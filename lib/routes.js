/**
 * Host 端 HTTP 路由：把账号状态、模型目录、推理档位探测结果暴露给浏览器半边。
 *
 * 两条路由，与 dsh-workbuddy-connect 同构：
 *   GET  /plugins/dsh-qoder-connect/status  — 只读文档（账号、目录、已探测结果）
 *   POST /plugins/dsh-qoder-connect/probe   — 有副作用的动作（刷新凭据/目录、探测、清除）
 *
 * 写路由比读路由多两道守卫：loopback Host/Origin 校验，加上一个进程内随机 key
 * （浏览器半边从 status 文档里拿到它再回传）。loopback 校验防的是 DNS rebinding
 * 的页面，而改状态的动作需要的是授权，两者不是一回事。
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

export const QODER_STATUS_PATH = "/plugins/dsh-qoder-connect/status";
export const QODER_PROBE_PATH = "/plugins/dsh-qoder-connect/probe";

/** 请求体上限。 */
const MAX_BODY_BYTES = 64 * 1024;

/** 生成写路由的进程内 key。 */
export function createProbeKey() {
  return randomBytes(32).toString("base64url");
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function safeMessage(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 300);
}

/** Host 头必须是回环地址（带或不带端口）。 */
function hostIsLoopback(host) {
  if (typeof host !== "string") return false;
  const name = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

/**
 * Origin 校验：同源的浏览器请求会带 Origin。
 * 缺失 Origin 只在非 GET 时也接受（桌面壳可能不带），但 Host 校验仍然生效。
 */
function originIsLoopback(origin) {
  if (origin === undefined || origin === null || origin === "") return true;
  try {
    const url = new URL(String(origin));
    return hostIsLoopback(url.host);
  } catch {
    return false;
  }
}

function keyMatches(expected, provided) {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 解析一个写动作。 */
function parseAction(body) {
  const action = body?.action;
  if (action === "refresh") return { action: "refresh" };
  if (action === "clear") return { action: "clear" };
  if (action === "account-refresh") return { action: "account-refresh", summary: body.summary === true };
  if (action === "check-in") return { action: "check-in" };
  if (action === "clear-claims") return { action: "clear-claims" };
  if (action === "web-search") {
    if (typeof body.query !== "string" || body.query.length === 0 || body.query.length > 1000) return undefined;
    return { action: "web-search", query: body.query };
  }
  if (action === "image-upload") {
    // data 是裸 base64（不带 data: 前缀）；64KB 请求体上限下最多约 48KB 图片，
    // 足够面板上做一次真实上传验证。
    if (typeof body.data !== "string" || body.data.length === 0 || body.data.length > 48 * 1024) return undefined;
    if (typeof body.mediaType !== "string" || body.mediaType.length === 0 || body.mediaType.length > 64) return undefined;
    return { action: "image-upload", data: body.data, mediaType: body.mediaType };
  }
  if (action === "image-clear") return { action: "image-clear" };
  if (action === "probe") {
    if (typeof body.model !== "string" || body.model.length === 0 || body.model.length > 128) return undefined;
    return { action: "probe", model: body.model };
  }
  return undefined;
}

/**
 * 组装 status 文档。
 *
 * 每个字段都在 Host 侧算好：浏览器半边只渲染，不自己折事件，也不碰凭据。
 */
export async function qoderStatusDocument(deps) {
  const credentials = await deps.credentials();
  const models = deps.models();
  const store = typeof deps.credentialStore === "function" ? await deps.credentialStore() : undefined;
  const doc = {
    status: credentials === undefined ? "signed-out" : "signed-in",
    account: credentials === undefined ? undefined : {
      uid: credentials.uid,
      name: credentials.user?.name ?? "",
      email: credentials.user?.email ?? "",
      phone: credentials.user?.phone ?? "",
      avatarUrl: credentials.user?.avatarUrl ?? "",
      expiresAt: credentials.expiresAt ?? "",
      refreshExpiresAt: credentials.refreshTokenExpiresAt ?? "",
      refreshedAt: credentials.refreshedAt ?? "",
      source: credentials.source ?? "",
    },
    store,
    appDataDir: deps.appDataDir(),
    catalog: deps.catalogSection(),
    modelCount: models.length,
    models: models.map((m) => ({
      id: m.id,
      name: m.name,
      displayName: m.displayName ?? m.name,
      isVl: m.supportsImages === true,
      isReasoning: m.reasoning?.supports === true,
      canDisableThinking: m.reasoning?.canDisableThinking === true,
      fastEffort: m.reasoning?.fastEffort,
      contextWindow: m.contextWindow,
      contextWindows: m.contextWindows,
      defaultContextWindow: m.defaultContextWindow,
      maxInputTokens: m.maxInputTokens,
      maxTokens: m.maxTokens,
      source: m.source,
    })),
    probe: deps.probeSection(),
    images: typeof deps.imageSection === "function" ? deps.imageSection() : undefined,
    probeKey: credentials === undefined ? undefined : deps.probeKey,
  };
  // 账号侧（额度 / 订阅 / 签到）—— 只在登录态才取，未登录时 account 服务没有 token 可打
  if (credentials !== undefined && typeof deps.account === "function") {
    try {
      doc.billing = await deps.account();
    } catch (error) {
      doc.billing = { lastError: safeMessage(error) };
    }
  }
  return doc;
}

/** GET 处理器。 */
export function qoderStatusHandler(deps) {
  return async (req, res) => {
    if (req.method !== "GET") { json(res, 405, { error: "method not allowed" }); return; }
    if (!hostIsLoopback(req.headers.host)) { json(res, 403, { error: "request-not-trusted" }); return; }
    try {
      json(res, 200, await qoderStatusDocument(deps));
    } catch (error) {
      json(res, 500, { error: safeMessage(error) });
    }
  };
}

/** POST 处理器。 */
export function qoderProbeHandler(deps, key) {
  return async (req, res) => {
    if (req.method !== "POST") { json(res, 405, { error: "method not allowed" }); return; }
    if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
      json(res, 403, { error: "request-not-trusted" });
      return;
    }
    if (!keyMatches(key, req.headers["x-qoder-probe-key"])) {
      json(res, 403, { error: "invalid-probe-key" });
      return;
    }
    const body = await readBody(req);
    if (body === undefined) { json(res, 413, { error: "body too large or invalid" }); return; }
    const action = parseAction(body);
    if (action === undefined) { json(res, 400, { error: "invalid action" }); return; }
    try {
      if (action.action === "clear") { deps.clear(); json(res, 200, { state: "cleared" }); return; }
      if (action.action === "clear-claims") {
        if (typeof deps.accountClear !== "function") { json(res, 500, { error: "account service unavailable" }); return; }
        deps.accountClear();
        json(res, 200, { state: "cleared" });
        return;
      }
      if (action.action === "refresh") { json(res, 200, await deps.refresh()); return; }
      if (action.action === "account-refresh") {
        if (typeof deps.accountRefresh !== "function") { json(res, 500, { error: "account service unavailable" }); return; }
        json(res, 200, await deps.accountRefresh({ claim: true, summary: action.summary }));
        return;
      }
      if (action.action === "check-in") {
        if (typeof deps.accountRefresh !== "function") { json(res, 500, { error: "account service unavailable" }); return; }
        // 手动签到：清掉本地冷却记录再拉一次，让服务端说了算（它自己幂等）
        if (typeof deps.accountClear === "function") deps.accountClear();
        json(res, 200, await deps.accountRefresh({ claim: true, summary: false }));
        return;
      }
      if (action.action === "web-search") {
        if (typeof deps.webSearch !== "function") { json(res, 500, { error: "web search unavailable" }); return; }
        json(res, 200, await deps.webSearch(action.query));
        return;
      }
      if (action.action === "image-upload") {
        if (typeof deps.imageUpload !== "function") { json(res, 500, { error: "image upload unavailable" }); return; }
        json(res, 200, await deps.imageUpload(action.data, action.mediaType));
        return;
      }
      if (action.action === "image-clear") {
        if (typeof deps.imageClear !== "function") { json(res, 500, { error: "image upload unavailable" }); return; }
        deps.imageClear();
        json(res, 200, { state: "cleared" });
        return;
      }
      json(res, 200, await deps.probe(action.model));
    } catch (error) {
      json(res, 500, { error: safeMessage(error) });
    }
  };
}

/** 挂载只读路由；返回 dispose。 */
export function registerQoderStatusRoute(ctx, deps, path = QODER_STATUS_PATH) {
  return ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path,
    handler: qoderStatusHandler(deps),
  }), "dsh-qoder-connect: Web status route");
}

/** 挂载写路由；返回 dispose。 */
export function registerQoderProbeRoute(ctx, deps, key, path = QODER_PROBE_PATH) {
  return ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path,
    handler: qoderProbeHandler(deps, key),
  }), "dsh-qoder-connect: probe control route");
}
