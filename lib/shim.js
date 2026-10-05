/**
 * shim.js — 本地回环 OpenAI 兼容端点。
 *
 * DSH 的 PiAiAdapter 通过 pi-ai 的 openai-completions API 访问这里；
 * 这里把 OpenAI 请求转成 Qoder 网关调用，再把上游（嵌套包装的）SSE
 * 重新装成标准 OpenAI SSE 转发回去。
 */
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { chatCompletionChunks, chatCompletion } from "./bridge.js";
import { hoistInlineImages } from "./imageupload.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const REQUEST_BODY_LIMIT = 64 * 1024 * 1024;
const STREAM_IDLE_TIMEOUT_MS = 600_000;

function hostnameOfHost(host) {
  if (!host) return "";
  let h = String(host).trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h : h.slice(0, end + 1);
  }
  const colon = h.lastIndexOf(":");
  return colon > -1 && /^\d+$/.test(h.slice(colon + 1)) ? h.slice(0, colon) : h;
}

const hostIsLoopback = (host) => LOOPBACK_HOSTS.has(hostnameOfHost(host));
const originIsLoopback = (origin) => {
  if (!origin) return true;
  try { return hostIsLoopback(new URL(origin).host); } catch { return false; }
};
function bearerOk(header, secret) {
  if (!header) return false;
  const got = /^Bearer\s+(.+)$/i.exec(String(header).trim())?.[1];
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
const isJsonContentType = (ct) => String(ct ?? "").toLowerCase().split(";")[0].trim() === "application/json";

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("request body too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function writeJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function writeOpenAIError(res, status, message) {
  writeJson(res, status, { error: { message, type: "qoder_error", code: String(status) } });
}

/** 数一数还有多少张内联 base64 图（上传成功的会被换掉，用于统计）。 */
function countInlineImages(messages) {
  let n = 0;
  for (const message of messages ?? []) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type === "image_url") {
        const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
        if (typeof url === "string" && url.startsWith("data:")) n++;
      } else if (part?.type === "image" && part.source?.type === "base64") {
        n++;
      }
    }
  }
  return n;
}

/**
 * 创建回环 shim。
 * @param {{catalog: import("./catalog.js").QoderCatalog, logger?: object, onRequest?: Function,
 *          contextTierFor?: (model: string) => number|undefined,
 *          tracker?: import("./turn.js").QoderTurnTracker,
 *          imageUploader?: import("./imageupload.js").QoderImageUploader}} options
 * @returns {{ready: Promise<void>, baseUrl(): string, token(): string, close(): Promise<void>, address(): object|undefined}}
 */
export function createQoderShim({ catalog, logger, onRequest, contextTierFor, tracker, imageUploader }) {
  const token = randomBytes(32).toString("base64url");
  let closed = false;
  /** 观测计数：面板/CLI 想报告「有多少张图被换成了 URL」时用得上。 */
  const stats = { requests: 0, imagesHoisted: 0, imagesKept: 0 };

  const server = createServer(async (req, res) => {
    try {
      if (!hostIsLoopback(req.headers.host)) { writeJson(res, 403, { error: "forbidden" }); return; }
      if (!originIsLoopback(req.headers.origin)) { writeJson(res, 403, { error: "forbidden origin" }); return; }
      const { method, url } = req;
      const pathname = (url ?? "/").split("?")[0];

      if (method === "GET" && (pathname === "/healthz" || pathname === "/")) {
        const src = typeof catalog.source === "function" ? catalog.source() : catalog.source;
        writeJson(res, 200, { ok: true, models: catalog.current().length, source: src ?? "empty" });
        return;
      }
      if (!bearerOk(req.headers.authorization, token)) { writeJson(res, 401, { error: "unauthorized" }); return; }

      if (method === "GET" && pathname === "/v1/models") {
        writeJson(res, 200, {
          object: "list",
          data: catalog.current().map((m) => ({ id: m.id, object: "model", created: 0, owned_by: "qoder" })),
        });
        return;
      }

      if (method === "POST" && pathname === "/v1/chat/completions") {
        if (!isJsonContentType(req.headers["content-type"])) { writeOpenAIError(res, 415, "content-type must be application/json"); return; }
        const raw = await readBody(req, REQUEST_BODY_LIMIT);
        let body;
        try { body = JSON.parse(raw.toString("utf8")); } catch { writeOpenAIError(res, 400, "invalid JSON body"); return; }
        if (!body || typeof body !== "object" || !Array.isArray(body.messages)) { writeOpenAIError(res, 400, "messages array is required"); return; }
        if (!body.model || typeof body.model !== "string") { writeOpenAIError(res, 400, "model is required"); return; }

        onRequest?.({ model: body.model, stream: body.stream !== false, messages: body.messages.length });
        stats.requests++;

        // 内联 base64 图片先上传到 Qoder center 换成 OSS URL（官方 _q() 语义）。
        // 好处：长会话里同一张图不必每条消息重复塞 data URL，且 URL 形态才是
        // 官方 VL 通道的线上主路径。失败一律保留原 base64，绝不打断推理。
        let messages = body.messages;
        const inlineImages = countInlineImages(messages);
        if (inlineImages > 0 && imageUploader) {
          try {
            const hoisted = await hoistInlineImages(messages, { uploader: imageUploader, signal: undefined });
            if (hoisted !== messages) {
              const left = countInlineImages(hoisted);
              stats.imagesHoisted += inlineImages - left;
              stats.imagesKept += left;
              messages = hoisted;
            } else {
              stats.imagesKept += inlineImages;
            }
          } catch (error) {
            stats.imagesKept += inlineImages;
            logger?.warn?.("dsh-qoder-connect: 图片上传阶段异常，保留内联 base64", error);
          }
        }

        // model_config 的 is_vl / is_reasoning / display_name / max_input_tokens
        // 必须从目录取：上游用它们决定图像通道与思考预算，写死成 false/200000
        // 会让 VL 模型丢图、上下文被无谓截断。
        const info = catalog?.current?.().find?.((e) => e.id === body.model);
        // 该模型关不掉思考时，目录给出的“真被上游接受的省档”（如 gmodel=high）。
        // 传 off/low 到这类模型会直接 provider_error。
        const fastEffort = info?.reasoning?.fastEffort;
        const asked = body.reasoning_effort ?? undefined;
        // 上下文档位：官方走 parameters.context_length，且只接受目录声明过的值
        // （LV(model,n)：有档位表就必须命中表内）。调用方可给 contextTierFor()
        // 覆写，否则用目录里的最大档，让上游放开到该模型真实可用的上限。
        const tiers = Array.isArray(info?.contextWindows) ? info.contextWindows : [];
        const wantTier = typeof contextTierFor === "function" ? contextTierFor(body.model) : undefined;
        const contextLength = Number.isInteger(wantTier) && tiers.includes(wantTier)
          ? wantTier
          : (tiers.length > 0 ? tiers[tiers.length - 1] : undefined);
        const opts = {
          model: body.model,
          messages,
          source: body.source ?? info?.source,
          display_name: info?.display_name ?? info?.name ?? body.model,
          is_vl: info?.supportsImages === true,
          is_reasoning: info?.reasoning?.supports === true,
          // model_config.max_input_tokens 用目录原始值（官方 Uyc() 的 l = n?.max_input_tokens ?? 2e5），
          // 与档位无关；缺目录信息时退回 contextWindow。
          max_input_tokens: info?.maxInputTokens ?? (typeof info?.contextWindow === "number" ? info.contextWindow : undefined),
          context_window: typeof info?.contextWindow === "number" ? info.contextWindow : undefined,
          context_length: contextLength,
          temperature: typeof body.temperature === "number" ? body.temperature : undefined,
          max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : undefined,
          top_p: typeof body.top_p === "number" ? body.top_p : undefined,
          stop: body.stop ?? undefined,
          tools: Array.isArray(body.tools) ? body.tools : undefined,
          tool_choice: body.tool_choice ?? undefined,
          // DSH 没给档位时也要显式下发：能关思考就关，关不掉就用目录给的
          // fast_effort（否则上游落到自己的大思考默认档，实测慢 4~10 倍）。
          reasoning_effort: asked ?? (fastEffort ? fastEffort : "off"),
          fast_effort: fastEffort,
          response_format: body.response_format ?? undefined,
          user: typeof body.user === "string" ? body.user : undefined,
          id: typeof body.id === "string" ? body.id : undefined,
        };

        // 回合身份：官方 Pgr()/AgentLifecycle 让一次 agent run 内所有请求共用
        // 同一个 business.id，Qoder 的积分面板按它聚合消费。DSH 的 OpenAI 兼容
        // 请求不带会话标识，所以由 tracker 从消息历史重建（见 turn.js）。
        if (tracker) {
          const turn = tracker.begin(messages);
          if (turn) {
            opts.business = turn.business;
            opts.request_set_id = turn.request_set_id;
          }
        }

        if (body.stream === false) {
          const result = await chatCompletion(opts);
          writeJson(res, 200, result);
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        const idle = setTimeout(() => {
          logger?.warn?.("dsh-qoder-connect: 上游流空闲超时，断开");
          try { res.end("data: [DONE]\n\n"); } catch { /* ignore */ }
        }, STREAM_IDLE_TIMEOUT_MS);
        idle.unref?.();
        let doneSent = false;
        try {
          for await (const chunk of chatCompletionChunks(opts)) {
            if (closed) break;
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
        } catch (error) {
          logger?.error?.("dsh-qoder-connect: 流式请求失败", error);
          if (!res.writableEnded) {
            const message = String(error?.message ?? error);
            const status = Number(error?.status) || 502;
            res.write(`data: ${JSON.stringify({ error: { message, type: "qoder_error", code: String(status) } })}\n\n`);
          }
        } finally {
          clearTimeout(idle);
          if (!res.writableEnded) {
            if (!doneSent) res.write("data: [DONE]\n\n");
            res.end();
          }
        }
        return;
      }

      writeJson(res, 404, { error: "not found" });
    } catch (error) {
      logger?.error?.("dsh-qoder-connect: shim 请求异常", error);
      if (!res.headersSent) writeOpenAIError(res, Number(error?.status) || 500, String(error?.message ?? error));
      else try { res.end(); } catch { /* ignore */ }
    }
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 0;

  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(undefined);
    });
  });

  return {
    ready,
    token: () => token,
    baseUrl: () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return "http://127.0.0.1:0";
      return `http://127.0.0.1:${addr.port}`;
    },
    address: () => server.address(),
    stats: () => ({ ...stats }),
    close: () => new Promise((resolve) => {
      closed = true;
      try { server.closeAllConnections?.(); } catch { /* ignore */ }
      try { server.close(() => resolve()); } catch { resolve(); }
    }),
  };
}
