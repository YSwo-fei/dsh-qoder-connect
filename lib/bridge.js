/**
 * bridge.js — Qoder CN 推理网关 <-> OpenAI Chat Completions 桥接。
 *
 * 上游: POST https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation
 *       签名与加密体全部由 WASM qodercontext.prepareInferRequest 生成
 *       （path 传 ""，网关侧自动拼 /algo/... 后缀）。
 * 下游: 标准 OpenAI chat.completion.chunk 对象。
 */
import * as W from "./wasm_prelude.mjs";
import { randomUUID } from "node:crypto";
import { cosyHeaders } from "./cosy.js";

export const QODER_GATEWAY = "https://gateway.qoder.com.cn";
export const QODER_COSY_VERSION = "0.4.3";

let ready = false;
let creds = null;

export function setCredentials({ uid, token, machineId, cosyVersion = QODER_COSY_VERSION }) {
  if (!uid || !token) throw new Error("qoder: uid and token are required");
  creds = { uid, token, machineId: machineId ?? "0d0c00a0-0000-0000-0000-000000000000", cosyVersion };
  ready = false;
}

export function getCredentials() { return creds; }

export async function init() {
  if (ready) return;
  if (!creds) throw new Error("qoder: credentials not set (call setCredentials first)");
  await W.rN();
  const raw = W.WasmExports.generate_runtime_auth_fields(JSON.stringify({
    uid: creds.uid,
    security_oauth_token: creds.token,
    organization_id: "",
    organization_tags: [],
    data_policy_agreed: false,
  }));
  const fields = typeof raw === "string" ? JSON.parse(raw) : raw;
  W.HdA(creds.machineId, creds.cosyVersion, JSON.stringify({
    uid: creds.uid,
    encrypt_user_info: fields.encrypt_user_info,
    key: fields.key,
  }));
  ready = true;
}

/**
 * OpenAI -> Qoder 消息体。
 * 官方 nQc()/rQc() 同时输出 content 与 contents（parts 数组），
 * 缺 contents 会让上游节点报 `Execution failed: null`。
 */
/**
 * 归一到一个上游认识的 content part。
 * 上游只接受 `{type:"image_url", image_url:{url}}`（实测：扁平 `{type:"image_url", url}`
 * 会被静默丢弃，模型答“我看不到图片”；Anthropic 式 `{type:"image", source:{...}}`
 * 同理）。这里把两种变体都折成官方形状。
 */
function normalizePart(part) {
  if (!part || typeof part !== "object") return part;
  if (part.type === "image_url") {
    const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url ?? part.url;
    if (!url) return part;
    return { type: "image_url", image_url: { url, ...(part.image_url?.detail ? { detail: part.image_url.detail } : {}) } };
  }
  if (part.type === "image" && part.source) {
    const s = part.source;
    const url = s.type === "base64" && s.media_type && s.data
      ? `data:${s.media_type};base64,${s.data}`
      : s.type === "url" && s.url ? s.url
        : typeof part.url === "string" ? part.url
          : undefined;
    return url ? { type: "image_url", image_url: { url } } : { type: "text", text: "" };
  }
  return part;
}

function toQoderMessages(messages) {
  if (!Array.isArray(messages)) throw new Error("qoder: messages must be an array");
  return messages.map((m) => {
    if (!m || typeof m !== "object" || typeof m.role !== "string") {
      throw new Error("qoder: each message needs a role");
    }
    const out = { role: m.role };
    // 上游不接受 null/undefined content（实测返回 provider_error），统一收敛成空串。
    const content = m.content ?? "";
    if (typeof content === "string") {
      out.content = content;
      out.contents = [{ type: "text", text: content }];
    } else if (Array.isArray(content)) {
      // 图文混排：content 与 contents 同传（官方 nQc 在含图时也是这个形状）。
      const parts = content.map(normalizePart);
      out.content = parts;
      out.contents = parts;
    } else if (m.contents !== undefined) {
      out.contents = Array.isArray(m.contents) ? m.contents.map(normalizePart) : m.contents;
      out.content = m.content ?? "";
    } else {
      out.content = String(content);
      out.contents = [{ type: "text", text: String(content) }];
    }
    if (m.name !== undefined) out.name = m.name;
    if (m.tool_calls !== undefined) out.tool_calls = m.tool_calls;
    if (m.tool_call_id !== undefined) out.tool_call_id = m.tool_call_id;
    if (m.reasoning_content !== undefined) out.reasoning_content = m.reasoning_content;
    return out;
  });
}

/** 构造上游 ask 载荷（字段由 WASM 内部转换/加密）。 */
export function buildAsk(opts) {
  const {
    model, messages, temperature, max_tokens, top_p, stop,
    tools, tool_choice, reasoning_effort, response_format, user,
  } = opts;
  if (!model) throw new Error("qoder: model is required");
  const requestId = opts.request_id ?? `req-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const sessionId = opts.session_id ?? `sess-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const msgs = toQoderMessages(messages);
  const system = opts.system ?? "";
  // chat_context.text = 最后一条 user 消息的纯文本（官方 Lyc()）
  let lastUserText = "";
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === "user" && typeof m.content === "string") { lastUserText = m.content; break; }
  }

  const parameters = { ...(opts.parameters ?? {}) };
  if (typeof temperature === "number") parameters.temperature = temperature;
  if (typeof top_p === "number") parameters.top_p = top_p;
  if (typeof max_tokens === "number") parameters.max_tokens = max_tokens;

  // ---- 思考预算 ----------------------------------------------------------
  // 实测（E:\DSH CODE\timing.mjs，同一条 prompt，2026-10 实测）：
  //   字段缺省时上游套用自己的默认档，思考量极端膨胀——
  //     gmodel  不传 16032ms  vs  high 1828ms
  //     auto    不传  6972ms（但正文首字要 6879ms） vs  off 1146ms
  //     kmodel  不传  9624ms
  //   即“字段留空”远比显式下发慢，DSH 界面因此长时间没有可读输出。
  //   另：auto/gmodel/gm51model/kmodel/q37fmodel 的 thinking_config 没有
  //   disabled 分支，直接传 off/low/medium 会被上游 provider_error（gmodel
  //   实测三档全报错），所以“关思考”的模型集合由 catalog.js 的
  //   thinkingLevelMap 决定，本函数只做翻译。
  //
  // 档位语义：
  //   off/none/minimal/low（含空）-> 尽快出正文：enable_thinking=false
  //   medium/high/xhigh/max       -> 原样透传，用户显式要深入思考时不动它
  //
  // 例外：模型 thinking_config 没有 disabled 分支时（catalog 会给出 fast_effort），
  // 传 enable_thinking=false 或 off/low 会被上游 provider_error —— 此时改用
  // fast_effort 那个真被接受的省档。
  const askFast = opts.fast_effort; // 例如 gmodel/gfmodel/kmodel -> "high"
  const effort = typeof reasoning_effort === "string" ? reasoning_effort.toLowerCase() : "";
  const wantsFast = effort === "off" || effort === "none" || effort === "minimal" || effort === "low" || effort === "";
  if (wantsFast && askFast) {
    parameters.reasoning_effort = askFast;
    parameters.enable_thinking = true;
  } else if (wantsFast) {
    parameters.enable_thinking = false;
  } else {
    parameters.reasoning_effort = effort;
    parameters.enable_thinking = true;
  }
  if (stop !== undefined && stop !== null) parameters.stop = stop;
  if (tool_choice !== undefined && tool_choice !== null) parameters.tool_choice = tool_choice;
  // 上下文档位 —— 官方 G4A() 的写法：
  //   void 0 !== o?.contextWindow && LV(d, o.contextWindow) && (C.context_length = o.contextWindow)
  // 即只有档位合法（∈ available_context_windows / context_config）时才下发
  // parameters.context_length。注意 model_config 里【没有】context_config 字段，
  // 官方 Uyc() 构造的 model_config 只有 key/display_name/model/format/is_vl/
  // is_reasoning/api_key/url/source/max_input_tokens，其中 max_input_tokens 取目录
  // 原始值（qfmodel=180000），与档位无关。
  if (opts.context_length !== undefined && opts.context_length !== null) {
    parameters.context_length = opts.context_length;
  }

  // 与官方 worker G4A() 对齐的字段集合；缺字段会让网关返回
  // `400 [FAIL]node:<upstream> msg:Execution failed: null`
  return {
    request_id: requestId,
    request_set_id: opts.request_set_id ?? requestId,
    chat_record_id: requestId,
    session_id: sessionId,
    stream: true,
    chat_task: opts.chat_task ?? "FREE_INPUT",
    chat_context: {
      text: lastUserText,
      features: [],
      extra: { context: [], modelConfig: { key: model, is_reasoning: false }, originalContent: lastUserText },
      chatPrompt: "",
      imageUrls: null,
    },
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    agent_id: "agent_common",
    task_id: opts.task_id ?? "common",
    session_type: opts.session_type ?? "qoder_work",
    aliyun_user_type: "",
    model_config: {
      key: model,
      display_name: opts.display_name ?? model,
      model: "",
      format: "openai",
      is_vl: opts.is_vl ?? false,
      is_reasoning: opts.is_reasoning ?? false,
      api_key: "",
      url: "",
      source: opts.source ?? "system",
      // 官方 Uyc()：max_input_tokens 取目录原始 max_input_tokens（默认 2e5），
      // 与上下文档位无关。旧版这里错用了 contextWindow（档位值），会让
      // qfmodel 报 1000000 而官方报 180000。
      max_input_tokens: opts.max_input_tokens ?? opts.context_window ?? 200000,
    },
    custom_model: opts.custom_model ?? null,
    system,
    messages: msgs,
    tools: Array.isArray(tools) ? tools : [],
    parameters,
    // 必填：缺失（哪怕其它字段全对）会让网关返回
    // 400 [FAIL]node:<upstream> msg:Execution failed: null
    business: opts.business ?? {},
  };
}

/** 签名 + 加密一次推理请求，返回可直接交给 fetch 的参数。 */
export async function prepareInfer(ask, endpoint = null) {
  await init();
  const body = JSON.stringify(ask);
  // 第一参是路径字符串；传对象会让 WASM 抛 memory access out of bounds
  const ep = endpoint ?? "";
  const r = W.Vd((c) => c.prepareInferRequest(ep, body, ask.model_config.key, ask.model_config.source ?? "system"));
  const url = typeof r.url === "string" && r.url.startsWith("http") ? r.url : QODER_GATEWAY + r.url;
  const out = { url, headers: W.cd(r.headers), body: String(r.body) };
  r.free();
  return out;
}

/**
 * 解开上游 SSE。上游每条 `data:` 里是 {headers, body:"<OpenAI chunk JSON>"}，
 * body 为 "[DONE]" 即结束；另有 event:finish 统计帧。
 */
export async function* unwrapSSE(res) {
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buf = "";
  let sawDone = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trimEnd();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let envelope;
        try { envelope = JSON.parse(payload); } catch { continue; }
        if (envelope && typeof envelope.body !== "string") {
          if (envelope.totalDuration !== undefined) yield { $finish: envelope };
          continue;
        }
        if (envelope.body === "[DONE]") { sawDone = true; continue; }
        let inner;
        try { inner = JSON.parse(envelope.body); } catch { continue; }
        if (inner && typeof inner.code === "string" && inner.message) {
          const err = new Error(`qoder upstream ${inner.code}: ${inner.message}`);
          err.status = Number(inner.code) || 502;
          err.code = inner.code;
          throw err;
        }
        if (inner && inner.error) {
          const err = new Error(inner.error.message || "qoder upstream error");
          err.status = inner.error.code || 502;
          throw err;
        }
        yield inner;
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  if (!sawDone) yield { $incomplete: true };
}

/** 把上游 chunk 流聚合为标准 OpenAI 对象流。 */
export async function* toOpenAIChunks(source, { model, id } = {}) {
  const chatId = id ?? `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let sawFinish = false;
  const emit = (choices, usage) => ({
    id: chatId,
    object: "chat.completion.chunk",
    created,
    model: model ?? "qoder",
    choices,
    ...(usage ? { usage } : {}),
  });
  for await (const item of source) {
    if (item && (item.$finish || item.$incomplete)) continue;
    if (!item || typeof item !== "object") continue;
    const choices = Array.isArray(item.choices) ? item.choices : [];
    if (choices.some((c) => c && c.finish_reason)) sawFinish = true;
    yield emit(choices.map((c) => ({
      index: c?.index ?? 0,
      delta: c?.delta ?? {},
      ...(c?.finish_reason ? { finish_reason: c.finish_reason } : {}),
      ...(c?.logprobs ? { logprobs: c.logprobs } : {}),
    })), item.usage);
  }
  if (!sawFinish) {
    yield emit([{ index: 0, delta: {}, finish_reason: "stop" }]);
  }
}

/** OpenAI 请求 -> OpenAI chunk 异步迭代器。 */
export async function* chatCompletionChunks(opts) {
  const ask = buildAsk(opts);
  const req = await prepareInfer(ask);
  const ac = new AbortController();
  const timeout = opts.timeoutMs ?? 600_000;
  const timer = setTimeout(() => ac.abort(new Error("qoder: upstream timeout")), timeout);
  let res;
  try {
    res = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`qoder: HTTP ${res.status} ${text.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  yield* toOpenAIChunks(unwrapSSE(res), { model: ask.model_config.key, id: opts.id });
}

/** 非流式：聚合为单个 chat.completion。 */
export async function chatCompletion(opts) {
  let content = "";
  let reasoning = "";
  let finish = "stop";
  let usage;
  let id;
  let created;
  const toolCalls = [];
  for await (const chunk of chatCompletionChunks({ ...opts, stream: true })) {
    id = chunk.id;
    created = chunk.created;
    for (const c of chunk.choices ?? []) {
      const d = c.delta ?? {};
      if (typeof d.content === "string") content += d.content;
      if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content;
      if (typeof d.reasoning === "string") reasoning += d.reasoning;
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const idx = tc.index ?? toolCalls.length;
          toolCalls[idx] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].function.name = tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
        }
      }
      if (c.finish_reason) finish = c.finish_reason;
    }
    if (chunk.usage) usage = chunk.usage;
  }
  const message = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: id ?? `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: created ?? Math.floor(Date.now() / 1000),
    model: opts.model,
    choices: [{ index: 0, message, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  };
}

/**
 * 拉取实时模型目录（Cosy 签名 GET /algo/api/v2/model/list?Encode=1）。
 * @returns {Promise<Array<{key,display_name,is_vl,is_reasoning,max_input_tokens,...}>>}
 */
export async function fetchModelList(user, ideVersion = QODER_COSY_VERSION) {
  const url = `${QODER_GATEWAY}/algo/api/v2/model/list?Encode=1`;
  const headers = cosyHeaders({ url, user, ideVersion });
  const res = await fetch(url, { method: "GET", headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`qoder: model list HTTP ${res.status} ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  const rows = Array.isArray(json.chat) ? json.chat : [];
  return rows.filter((r) => r && r.enable !== false && r.key);
}
