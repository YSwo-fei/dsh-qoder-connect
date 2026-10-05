/**
 * imageupload.js — 把内联 base64 图片上传到 Qoder center，换成 OSS URL。
 *
 * 复刻官方 worker `qoder-worker-runtime.obf.mjs` 的 `GCc()` / `Lgi()` / `Hgi()`
 * / `WCc()` / `JCc()` / `_q()` 一整套。为什么要做这件事：
 *   - 内联 data URL 会随每条消息重复塞进请求体，长会话里体积爆炸；
 *   - 官方 VL 通道对 base64 与 URL 走不同路径，URL 形态才是线上主路径。
 *
 * 协议（全部实测过）：
 *   PUT {center}/algo/api/v2/image/upload?request_id=<32位无横线uuid>
 *   Content-Type: multipart/form-data; boundary=----qodercli-<32位无横线uuid>
 *   multipart 只有一个字段：name="file"; filename="image.<ext>"
 *
 * 三个坑：
 *   1. **签名签的是 multipart body 的字节长度的十进制字符串**，不是 body 本身：
 *      `prepareRequest(endpoint, path, "PUT", "auth", String(body.length), undefined)`。
 *      传 body 本身或传 undefined 会得到不同的 Authorization。
 *   2. path 传**不带 `/algo`** 的相对路径（官方 `Ngi = "/api/v2/image/upload"`），
 *      WASM 自己补 `/algo`。带 `/algo` 也能过，但签名不同，按官方写法来。
 *   3. `r.url` / `r.headers` 必须在 `r.free()` **之前**读，否则 WASM 抛
 *      `Error: null pointer passed to rust`。
 *
 * 失败不影响功能：官方 `JCc()` 捕获异常后保留原始 base64 并 warn 一句，
 * 这里照做（`hoistInlineImages` 里单张失败只 warn，不改写那一条）。
 */
import crypto from "node:crypto";
import { init, getCredentials, QODER_GATEWAY, QODER_COSY_VERSION } from "./bridge.js";
import * as W from "./wasm_prelude.mjs";

/** 官方 `Ngi`：相对路径，不含 `/algo`。 */
export const QODER_IMAGE_UPLOAD_PATH = "/api/v2/image/upload";
/** 官方 `Gte = 3e4`。 */
export const QODER_IMAGE_UPLOAD_TIMEOUT_MS = 30_000;
/** 官方 `uAn` / `_ac`：只有这四种会被上传，其它原样保留。 */
export const QODER_SUPPORTED_IMAGE_TYPES = Object.freeze(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** 单张图上限：官方常量表里有 `Jac = 10485760`（10MiB），超出直接跳过上传。 */
export const QODER_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const SUPPORTED = new Set(QODER_SUPPORTED_IMAGE_TYPES);

/**
 * 官方 `iR(A)`：归一 media type（`image/jpg` → `image/jpeg`；无斜杠补 `image/` 前缀）。
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeMediaType(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "";
  const withPrefix = raw.includes("/") ? raw : `image/${raw}`;
  return withPrefix === "image/jpg" ? "image/jpeg" : withPrefix;
}

/** 官方 `g9(A)`。 */
export function isSupportedImageType(value) {
  return SUPPORTED.has(normalizeMediaType(value));
}

/** 官方 `WCc(A)`：`image/jpeg` → `jpg`，其余取子类型，取不到则 `png`。 */
export function extensionForMediaType(value) {
  const sub = normalizeMediaType(value).split("/")[1]?.split("+")[0]?.trim();
  if (!sub) return "png";
  return sub === "jpeg" ? "jpg" : sub;
}

/** 官方 `Ogi().replaceAll("-","")`。 */
const bareUuid = () => crypto.randomUUID().replaceAll("-", "");

/**
 * 官方 `Lgi({fieldName, fileName, mediaType, buffer})`。
 * fieldName 官方恒传 `"file"`。
 * @param {{mediaType: string, buffer: Buffer, fieldName?: string, fileName?: string}} options
 * @returns {{boundary: string, body: Buffer, fileName: string}}
 */
export function buildMultipartBody({ mediaType, buffer, fieldName = "file", fileName }) {
  const boundary = `----qodercli-${bareUuid()}`;
  const name = fileName ?? `image.${extensionForMediaType(mediaType)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${name}"\r\nContent-Type: ${mediaType}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return { boundary, body: Buffer.concat([head, buffer, tail]), fileName: name };
}

/** 官方 `_te(A,e)`：非空字符串才算数。 */
const nonEmptyString = (value) => (typeof value === "string" && value.length > 0 ? value : null);

/**
 * 官方 `Hgi(json)`：顶层 `url`，否则 `result.url` / `result.oss_url`。
 * @param {unknown} json
 * @returns {string|null}
 */
export function parseUploadResponse(json) {
  if (!json || typeof json !== "object") return null;
  const direct = nonEmptyString(json.url);
  if (direct) return direct;
  const result = json.result;
  if (result && typeof result === "object") {
    const nested = nonEmptyString(result.url) ?? nonEmptyString(result.oss_url);
    if (nested) return nested;
  }
  return null;
}

/** 官方 `_Cc(...)` 的等价物：同一张图不重复上传。 */
function cacheKeyFor({ endpoint, uid, mediaType, data }) {
  return `${endpoint}|${uid}|${mediaType}|${crypto.createHash("sha1").update(data).digest("hex")}`;
}

/** 官方 `_gi(signal, ms)`：外部 signal 与超时二选一。 */
function withTimeout(signal, ms) {
  const controller = new AbortController();
  let disposed = false;
  const abort = () => { if (!controller.signal.aborted) controller.abort(); };
  const timer = setTimeout(abort, ms);
  timer.unref?.();
  signal?.addEventListener?.("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", abort);
    },
  };
}

/**
 * 用 WASM 签一个上传请求。
 * @param {{endpoint: string, path: string, bodyLength: number}} options
 * @returns {{url: string, headers: Record<string,string>}}
 */
export function signUploadRequest({ endpoint, path, bodyLength }) {
  // 官方：prepareRequest(endpoint, path, "PUT", "auth", String(body.length), undefined)
  const signed = W.Vd((ctx) => ctx.prepareRequest(endpoint, path, "PUT", "auth", String(bodyLength), undefined));
  try {
    // 必须先取值再 free，否则 WASM 报 null pointer passed to rust
    return { url: signed.url, headers: W.cd(signed.headers) };
  } finally {
    signed.free();
  }
}

/**
 * 上传一张 base64 图片，返回 OSS URL。
 *
 * @param {{data: string, mediaType: string, signal?: AbortSignal, endpoint?: string,
 *          timeoutMs?: number, fetchImpl?: typeof fetch, credentials?: {uid?: string, token?: string}}} options
 * @returns {Promise<string|null>} 失败返回 null（调用方保留原 base64）
 */
export async function uploadImage(options) {
  const { data, signal, timeoutMs = QODER_IMAGE_UPLOAD_TIMEOUT_MS, fetchImpl = fetch } = options;
  if (typeof data !== "string" || data.length === 0) return null;
  const mediaType = normalizeMediaType(options.mediaType);
  if (!isSupportedImageType(mediaType)) return null;

  const creds = options.credentials ?? getCredentials();
  if (!creds?.uid || !creds?.token) throw new Error("qoder: credentials not set (call setCredentials first)");
  await init();

  const buffer = Buffer.from(data, "base64");
  if (buffer.length === 0) return null;
  if (buffer.length > QODER_MAX_IMAGE_BYTES) {
    throw Object.assign(
      new Error(`qoder: image is ${buffer.length} bytes; the upload endpoint accepts at most ${QODER_MAX_IMAGE_BYTES}`),
      { code: "QODER_IMAGE_TOO_LARGE" },
    );
  }

  const endpoint = options.endpoint ?? QODER_GATEWAY;
  const requestId = bareUuid();
  const path = `${QODER_IMAGE_UPLOAD_PATH}?request_id=${requestId}`;
  const multipart = buildMultipartBody({ mediaType, buffer });

  const signed = signUploadRequest({ endpoint, path, bodyLength: multipart.body.length });
  const headers = {
    ...signed.headers,
    // 官方覆写这三个；Content-Length 由 fetch 自己算，这里显式给出与官方一致。
    "AI-CLIENT-TIMESTAMP": String(Math.floor(Date.now() / 1000)),
    "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
    "Content-Length": String(multipart.body.length),
  };
  // WASM 会给 Accept-Encoding: identity，node fetch 会自己解压；留着无害但显式去掉更干净。
  delete headers["Accept-Encoding"];

  const guard = withTimeout(signal, timeoutMs);
  try {
    const res = await fetchImpl(signed.url || `${endpoint}/algo${path}`, {
      method: "PUT",
      headers,
      body: multipart.body,
      signal: guard.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw Object.assign(
        new Error(`qoder: image upload HTTP ${res.status} ${text.slice(0, 300)}`),
        { status: res.status },
      );
    }
    const url = parseUploadResponse(await res.json());
    if (!url) throw new Error("qoder: image upload response missing url");
    return url;
  } finally {
    guard.dispose();
  }
}

/**
 * 带缓存的图片上传器（官方 `Yte` / `qGe` 两个 Map 的等价物）。
 * 同一张图在一个进程里只上传一次；并发请求同一张图共享同一个 Promise。
 */
export class QoderImageUploader {
  /**
   * @param {{enabled?: () => boolean, endpoint?: string, timeoutMs?: number,
   *          fetchImpl?: typeof fetch, logger?: object, maxEntries?: number}} [options]
   */
  constructor(options = {}) {
    this.options = options;
    this.results = new Map();
    this.pending = new Map();
    this.maxEntries = options.maxEntries ?? 64;
  }

  /** 是否启用（关掉时 `hoistInlineImages` 完全不动消息）。 */
  enabled() {
    const fn = this.options.enabled;
    return typeof fn === "function" ? fn() !== false : this.options.enabled !== false;
  }

  /** @returns {Promise<string|null>} */
  async upload(data, mediaType, signal) {
    if (!this.enabled()) return null;
    const creds = getCredentials();
    if (!creds?.uid || !creds?.token) return null;
    const key = cacheKeyFor({
      endpoint: this.options.endpoint ?? QODER_GATEWAY,
      uid: creds.uid,
      mediaType: normalizeMediaType(mediaType),
      data,
    });
    const cached = this.results.get(key);
    if (cached) return cached;
    const inflight = this.pending.get(key);
    if (inflight) return await inflight;
    const task = (async () => {
      try {
        const url = await uploadImage({
          data,
          mediaType,
          signal,
          endpoint: this.options.endpoint,
          timeoutMs: this.options.timeoutMs,
          fetchImpl: this.options.fetchImpl,
          credentials: creds,
        });
        if (url) this.remember(key, url);
        return url;
      } catch (error) {
        // 官方：上传失败保留 base64，不打断推理。
        this.options.logger?.warn?.(
          `dsh-qoder-connect: 图片上传失败，保留内联 base64（${error?.message ?? error}）`,
        );
        return null;
      } finally {
        if (this.pending.get(key) === task) this.pending.delete(key);
      }
    })();
    this.pending.set(key, task);
    return await task;
  }

  remember(key, url) {
    this.results.set(key, url);
    while (this.results.size > this.maxEntries) {
      const oldest = this.results.keys().next().value;
      if (oldest === undefined) break;
      this.results.delete(oldest);
    }
  }

  clear() {
    this.results.clear();
    this.pending.clear();
  }

  get size() {
    return this.results.size;
  }
}

const DATA_URL_RE = /^data:([^;,]+)(;[^,]*)?;base64,(.*)$/is;

/**
 * 解析 `data:<mime>;base64,<payload>`。
 * @param {unknown} url
 * @returns {{mediaType: string, data: string}|null}
 */
export function parseDataUrl(url) {
  if (typeof url !== "string") return null;
  const m = DATA_URL_RE.exec(url.trim());
  if (!m) return null;
  const data = m[3].replace(/\s+/g, "");
  if (!data) return null;
  return { mediaType: normalizeMediaType(m[1]), data };
}

/** 把 content part 里的内联图片换成上传后的 URL。返回新 part（或原 part）。 */
async function hoistPart(part, uploader, signal) {
  if (!part || typeof part !== "object") return part;
  if (part.type === "image_url") {
    const raw = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
    const parsed = parseDataUrl(raw);
    if (!parsed) return part;
    const url = await uploader.upload(parsed.data, parsed.mediaType, signal);
    if (!url) return part;
    const rest = typeof part.image_url === "object" && part.image_url !== null ? part.image_url : {};
    return { ...part, image_url: { ...rest, url } };
  }
  if (part.type === "image" && part.source?.type === "base64") {
    const mediaType = normalizeMediaType(part.source.media_type);
    const url = await uploader.upload(part.source.data, mediaType, signal);
    if (!url) return part;
    return { ...part, source: { type: "url", url } };
  }
  return part;
}

/**
 * 遍历 OpenAI messages，把所有内联 base64 图片上传并改写成 URL。
 *
 * 与官方 `_q(A,e)` 语义一致：
 *   - 非 base64（已经是 http URL）→ 原样返回；
 *   - mediaType 不在白名单 → 原样返回（官方会 warn 一句）；
 *   - 上传失败 → 原样返回，保留 base64。
 * 没有任何图片需要上传时**返回原数组**（同一引用），调用方可据此跳过。
 *
 * @param {Array<object>} messages
 * @param {{uploader: QoderImageUploader, signal?: AbortSignal}} options
 * @returns {Promise<Array<object>>}
 */
export async function hoistInlineImages(messages, { uploader, signal } = {}) {
  if (!uploader || !uploader.enabled() || !Array.isArray(messages)) return messages;
  let touched = false;
  const out = [];
  for (const message of messages) {
    if (!message || typeof message !== "object" || !Array.isArray(message.content)) {
      out.push(message);
      continue;
    }
    const parts = [];
    let changed = false;
    for (const part of message.content) {
      const next = await hoistPart(part, uploader, signal);
      if (next !== part) changed = true;
      parts.push(next);
    }
    if (!changed) { out.push(message); continue; }
    touched = true;
    const next = { ...message, content: parts };
    // bridge.js 的 toQoderMessages 在 content 是数组时会同时下发 contents，
    // 若原消息自带 contents 也要一起换掉，否则上游会读到旧的 base64。
    if (Array.isArray(message.contents)) next.contents = parts;
    out.push(next);
  }
  return touched ? out : messages;
}

/** 供 routes.js / bin.js 汇报状态用。 */
export const QODER_IMAGE_UPLOAD_ENDPOINT = `${QODER_GATEWAY}/algo${QODER_IMAGE_UPLOAD_PATH}`;
export { QODER_COSY_VERSION };
