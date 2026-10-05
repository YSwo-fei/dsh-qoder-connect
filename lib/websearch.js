/**
 * websearch.js —— Qoder CN 联网搜索（对齐官方 App 的 oneSearch 端点）。
 *
 * 端点：`POST https://gateway.qoder.com.cn/algo/api/v1/webSearch/oneSearch?Encode=1`
 *   - body 两层：`{payload: JSON.stringify(inner), encodeVersion:"1"}`，再走
 *     `qoderEncodeBody()`（见 cosy.js）。明文会被网关判 500，必须编码。
 *   - 签名签的是**编码后**的串。
 *   - `inner = {query, timeRange, contents:{mainText,markdownText,summary}}`。
 *     `contents` 全 false 时只回 title/link/snippet/publishedTime/hostname/hostLogo，
 *     约 0.5s；全开时每条会多出 mainText/markdownText/summary 全文，实测 8.5s。
 *     这里取默认 false：DSH 的搜索缝只需要 url/title/snippet。
 *   - query 上限约 1000 字符，超了回 `errorCode:400 InvalidParameter.InvalidStringLength`。
 *
 * 注册到 DSH 的 `ctx.web` 搜索缝：provider 需实现 `{id, available(), search(request, signal)}`，
 * 返回 `{sources:[{url,title,snippet,publishedAt}], truncated}`；`maxResults` 截断由
 * 缝自己做，provider 不必管。见 `@deepseek-ai/dsh-web` 的 `WebRuntime`。
 *
 * 依赖注入（不 import 任何 @deepseek-ai 包，宿主/CLI 都能加载）：
 *   - `WebError` 由调用方传入（宿主从 `@deepseek-ai/dsh-web` 取，CLI 传 undefined 时
 *     退回普通 Error）。这样模块本身在裸 node 里也能跑测试。
 */

import { cosyHeaders, qoderEncodeBody } from "./cosy.js";

/** 搜索端点（CN 推理网关同域）。 */
export const QODER_SEARCH_URL = "https://gateway.qoder.com.cn/algo/api/v1/webSearch/oneSearch?Encode=1";
/** 注册到 `ctx.web` 的 provider id。 */
export const QODER_SEARCH_PROVIDER_ID = "qoder";
/** 单次搜索超时。实测最小 contents 约 0.5s，留足余量。 */
export const QODER_SEARCH_TIMEOUT_MS = 30_000;
/** 网关对 query 的硬上限（超了回 InvalidParameter.InvalidStringLength）。 */
export const QODER_SEARCH_MAX_QUERY_CHARS = 1000;
/** `contents` 默认全关：只要 url/title/snippet，避免拉全文拖慢。 */
export const QODER_SEARCH_DEFAULT_CONTENTS = Object.freeze({
  mainText: false,
  markdownText: false,
  summary: false,
});

/** 本地兜底错误类：宿主提供 `@deepseek-ai/dsh-web` 时不会用到。 */
class QoderWebError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.code = code;
    this.name = "QoderWebError";
  }
}

let webErrorClass;
let webErrorResolved = false;

/**
 * 取 `@deepseek-ai/dsh-web` 的 `WebError` 类。
 *
 * 宿主运行时能解析到 asar 内的副本，裸 node / CLI 不能（同 authstore.js 对
 * `@deepseek-ai/dsh-home-paths` 的处理），所以懒加载 + 兜底。`code` 是开放字符串，
 * 缝不做 instanceof 检查，兜底类不影响路由。
 */
async function resolveWebErrorClass() {
  if (webErrorResolved) return webErrorClass;
  webErrorResolved = true;
  try {
    const mod = await import("@deepseek-ai/dsh-web");
    webErrorClass = typeof mod?.WebError === "function" ? mod.WebError : QoderWebError;
  } catch {
    webErrorClass = QoderWebError;
  }
  return webErrorClass;
}

/** 构造错误：能用宿主的 WebError 就用（带 code 与 cause 链），否则退回本地类。 */
function makeError(WebErrorClass, message, code, options) {
  const Ctor = typeof WebErrorClass === "function" ? WebErrorClass : QoderWebError;
  return new Ctor(message, code, options);
}

/** 把上游 pageItems 映射成搜索缝的 sources 形状。 */
export function normalizeSearchItems(pageItems) {
  if (!Array.isArray(pageItems)) return [];
  const seen = new Set();
  const sources = [];
  for (const item of pageItems) {
    if (!item || typeof item !== "object") continue;
    const url = typeof item.link === "string" ? item.link : "";
    if (url.length === 0 || seen.has(url)) continue;
    seen.add(url);
    const source = { url };
    if (typeof item.title === "string" && item.title.length > 0) source.title = item.title;
    // snippet 是网关直接给的摘要；contents.summary 打开时才另有 summary 字段。
    const snippet = typeof item.snippet === "string" && item.snippet.length > 0
      ? item.snippet
      : (typeof item.summary === "string" && item.summary.length > 0 ? item.summary : undefined);
    if (snippet !== undefined) source.snippet = snippet;
    if (typeof item.publishedTime === "string" && item.publishedTime.length > 0) source.publishedAt = item.publishedTime;
    sources.push(source);
  }
  return sources;
}

/** 解析网关响应：HTTP 200 里也可能是 `{errorCode, errorMsg}` 业务错误。 */
function readSearchResponse(status, text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: `Qoder search returned an unparseable body (HTTP ${status}): ${text.slice(0, 200)}` };
  }
  if (json && typeof json.errorCode === "number" && json.errorCode !== 0) {
    return { error: `Qoder search failed (${json.errorCode}): ${json.errorMsg ?? "unknown error"}` };
  }
  if (!json || !Array.isArray(json.pageItems)) {
    return { error: `Qoder search returned no pageItems (HTTP ${status}): ${text.slice(0, 200)}` };
  }
  return { items: json.pageItems };
}

/**
 * 一次搜索。不碰 DSH 缝，纯 HTTP + 签名，便于测试。
 *
 * @param {{query: string}} request
 * @param {{user: {uid: string, name?: string, email?: string, token: string},
 *          ideVersion?: string, contents?: object, signal?: AbortSignal,
 *          timeoutMs?: number, fetchImpl?: Function, WebErrorClass?: Function,
 *          endpoint?: string}} deps
 * @returns {Promise<{sources: Array<{url: string, title?: string, snippet?: string, publishedAt?: string}>, truncated: boolean}>}
 */
export async function qoderSearch(request, deps) {
  const { user } = deps;
  const WebErrorClass = deps.WebErrorClass ?? await resolveWebErrorClass();
  if (!user?.uid || !user?.token) {
    throw makeError(WebErrorClass, "Qoder search has no credentials; sign in to Qoder CN first", "WEB_PROVIDER_CREDENTIAL_MISSING");
  }
  const query = typeof request?.query === "string" ? request.query.trim() : "";
  if (query.length === 0) {
    throw makeError(WebErrorClass, "Qoder search requires a non-empty query", "WEB_PROVIDER_ERROR");
  }
  if (query.length > QODER_SEARCH_MAX_QUERY_CHARS) {
    throw makeError(
      WebErrorClass,
      `Qoder search query is ${query.length} characters; the gateway accepts at most ${QODER_SEARCH_MAX_QUERY_CHARS}`,
      "WEB_PROVIDER_ERROR",
    );
  }

  const endpoint = deps.endpoint ?? QODER_SEARCH_URL;
  const inner = JSON.stringify({
    query,
    timeRange: "NoLimit",
    contents: deps.contents ?? QODER_SEARCH_DEFAULT_CONTENTS,
  });
  const plaintext = JSON.stringify({ payload: inner, encodeVersion: "1" });
  const body = qoderEncodeBody(plaintext);
  const headers = {
    ...cosyHeaders({
      url: endpoint,
      body,
      user,
      ideVersion: deps.ideVersion ?? "0.4.3",
      accept: "application/json",
    }),
    "Accept-Encoding": "identity",
  };

  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = Number.isInteger(deps.timeoutMs) ? deps.timeoutMs : QODER_SEARCH_TIMEOUT_MS;
  // 调用方给了 signal 就尊重它，否则用超时自建一个。
  const signal = deps.signal ?? AbortSignal.timeout(timeoutMs);

  let response;
  try {
    response = await fetchImpl(endpoint, { method: "POST", headers, body, signal });
  } catch (error) {
    if (signal.aborted === true || error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw makeError(WebErrorClass, "Qoder search aborted", "WEB_ABORTED", { cause: error });
    }
    throw makeError(WebErrorClass, `Qoder search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
  }

  let text;
  try {
    text = await response.text();
  } catch (error) {
    if (signal.aborted === true || error?.name === "AbortError") {
      throw makeError(WebErrorClass, "Qoder search aborted", "WEB_ABORTED", { cause: error });
    }
    throw makeError(WebErrorClass, `Qoder search response could not be read: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
  }

  if (!response.ok) {
    const detail = text.slice(0, 200);
    if (response.status === 401 || response.status === 403) {
      throw makeError(
        WebErrorClass,
        `Qoder rejected the credentials used for this web search (HTTP ${response.status}). Sign in to Qoder CN again.`,
        "WEB_PROVIDER_ERROR",
      );
    }
    throw makeError(WebErrorClass, `Qoder search failed (HTTP ${response.status}): ${detail}`, "WEB_PROVIDER_ERROR");
  }

  const parsed = readSearchResponse(response.status, text);
  if (parsed.error) throw makeError(WebErrorClass, parsed.error, "WEB_PROVIDER_ERROR");
  return { sources: normalizeSearchItems(parsed.items), truncated: false };
}

/**
 * 注册到 `ctx.web` 的 provider。`available()` 在凭据就绪时为真 —— 缝在多个
 * provider 同时可用且未显式配置时会报 `WEB_PROVIDER_AMBIGUOUS`，所以这里
 * 只在真的能用时才算可用。
 */
export class QoderSearchProvider {
  /**
   * @param {() => {user?: object, ideVersion?: string, contents?: object, timeoutMs?: number,
   *                fetchImpl?: Function, WebErrorClass?: Function, enabled?: boolean}} resolveOptions
   *   每次操作入口快照一次，避免设置面板中途改动导致一次搜索混用两份配置。
   */
  constructor(resolveOptions) {
    this.resolveOptions = resolveOptions;
    this.id = QODER_SEARCH_PROVIDER_ID;
  }

  available() {
    const options = this.resolveOptions();
    if (options?.enabled === false) return false;
    return Boolean(options?.user?.uid && options?.user?.token);
  }

  async search(request, signal) {
    const options = this.resolveOptions();
    return qoderSearch(request, { ...options, ...(signal === undefined ? {} : { signal }) });
  }
}
