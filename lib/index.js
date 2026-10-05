/**
 * dsh-qoder-connect — 把 Qoder CN 桌面 App 的模型接入 DeepSeek Harness。
 *
 * 结构与 dsh-workbuddy-connect 一致：
 *   凭据（解密 Qoder CN auth.v1.dat） → 实时模型目录 → 回环 OpenAI shim
 *   → pi-ai Provider → PiAiAdapter → ctx.llm.registerAdapter。
 * 插件自身不落任何密钥：上游鉴权每次请求都从 Qoder 凭据派生。
 */
import z from "@deepseek-ai/schemastery";
import { resolveImageAttachmentAccess, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

import { resolveCredentials, machineIdFor, defaultAppDataDir } from "./credentials.js";
import { QoderCredentialStore } from "./authstore.js";
import { QoderAccountService } from "./account.js";
import { QoderCatalog } from "./catalog.js";
import { createQoderShim } from "./shim.js";
import { QoderTurnTracker } from "./turn.js";
import { setCredentials, QODER_COSY_VERSION, chatCompletionChunks } from "./bridge.js";
import { probeEfforts, makeProbeSender, PROBE_EFFORT_CANDIDATES } from "./probe.js";
import { createProbeKey, registerQoderStatusRoute, registerQoderProbeRoute } from "./routes.js";
import { QoderSearchProvider } from "./websearch.js";
import { QoderImageUploader, QODER_IMAGE_UPLOAD_ENDPOINT, QODER_MAX_IMAGE_BYTES, QODER_SUPPORTED_IMAGE_TYPES } from "./imageupload.js";

/** 稳定的 cordis 插件名（与 cordis.patch.yml 的 insert id 对应）。 */
const name = "llm-qoder";
/** 模型注册表先于 provider 装载；webServer 通过 ctx.inject 按需取，缺失时只少了浏览器半边的状态页。 */
const inject = ["llm"];
/** 上游流空闲上限。 */
const QODER_STREAM_IDLE_TIMEOUT_MS = 600_000;

/** 图片请求预算（dsh-llm-pi-ai 0.1.1-rc.2 起必填）。 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576,
};
/** 惰性 pi-ai 凭据平面：鉴权只走 shim 共享密钥，pi-ai 自己不存任何东西。 */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() { return []; },
    async modify() { throw new Error("dsh-qoder-connect: 该 provider 没有 pi-ai 凭据生命周期"); },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() { return false; },
  },
};
/** 订阅制配额没有可公布的每 token 价格，报零。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/** 目录里 price_factor/promotion 徽标拼进显示名（模型位只渲染 name）。 */
const RATE_SEPARATOR = " · ";
function displaySuffix(info) {
  const parts = [];
  if (typeof info.price_factor === "number") parts.push(`×${info.price_factor}`);
  const badges = info.promotion?.badge;
  if (badges) parts.push(badges.zh ?? badges.en ?? "");
  if (info.is_free) parts.push("免费");
  const cleaned = parts.filter((p) => p !== "" && p !== undefined);
  return cleaned.length ? cleaned.join(RATE_SEPARATOR) : undefined;
}
function withCatalogDisplay(name, info) {
  const suffix = displaySuffix(info);
  return suffix === undefined ? name : `${name}${RATE_SEPARATOR}${suffix}`;
}

/** 目录条目 -> pi-ai 模型描述符。 */
function toPiModel(entry, baseUrl, providerId) {
  const reasoning = entry.reasoning;
  const declared = reasoning.supportedEfforts;
  const model = {
    id: entry.id,
    name: entry.name,
    api: "openai-completions",
    provider: providerId,
    baseUrl,
    input: entry.supportsImages === true ? ["text", "image"] : ["text"],
    cost: NO_COST,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    compat: { maxTokensField: "max_tokens" },
  };
  if (reasoning.supports === true && Array.isArray(declared) && declared.length > 0) {
    model.reasoning = true;
    model.thinkingLevelMap = entry.reasoning.thinkingLevelMap;
  } else {
    model.reasoning = false;
  }
  return model;
}

/**
 * 组装 adapter：provider 的 getModels 读实时目录，baseUrl 每次读都重解析，
 * 保证 shim 端口变更后首个快照即生效。
 */
function createQoderAdapter({ providerId, displayName, shim, catalog, resolveAttachments, resolveImageAccess }) {
  const buildModels = () => {
    const baseUrl = `${shim.baseUrl()}/v1`;
    return catalog.current().map((entry) => toPiModel(entry, baseUrl, providerId));
  };
  const provider = {
    ...createProvider({
      id: providerId,
      name: displayName,
      auth: {
        apiKey: {
          name: "Qoder CN 订阅（零配置，凭据来自 Qoder CN 桌面 App）",
          async resolve({ credential }) {
            const apiKey = credential?.key;
            return apiKey === undefined || apiKey.length === 0 ? undefined : { auth: { apiKey }, source: "Qoder CN" };
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    getModels: () => buildModels(),
  };
  const profile = {
    provider: providerId,
    displayName,
    streamIdleTimeoutMs: QODER_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, "dsh-qoder-connect retryPolicy"),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  };
  let profiles = new Map([[providerId, profile]]);
  return {
    adapter: new PiAiAdapter({
      profiles: () => profiles,
      auth: INERT_AUTH,
      resolveApiKey: async () => shim.token(),
      ...resolveAttachments === undefined ? {} : { resolveAttachments },
      ...resolveImageAccess === undefined ? {} : { resolveImageAccess },
    }),
    /** 让 DSH 重新读一次 provider 的模型表。 */
    invalidate: () => { profiles = new Map([[providerId, profile]]); },
  };
}

const VARIANT = { id: "qoder", displayName: "Qoder CN" };

/** 探测结果存内存：一次会话内有效即可，且不落盘就不会泄漏模型/额度信息。 */
const probeResults = new Map();

const Config = z.object({
  uid: z.string().description("覆盖 Qoder CN uid（默认从 auth.v1.dat 解密）"),
  token: z.string().description("覆盖 Qoder CN access token"),
  appDataDir: z.string().description("Qoder CN 用户数据目录"),
  refreshIntervalMs: z.number().min(10_000).default(10 * 60_000)
    .description("模型目录刷新间隔（默认 10 分钟，只读本地凭据 + 一次目录请求）"),
  hideModels: z.array(z.string()).default([])
    .description("要从模型列表里隐藏的 model key，如 [\"qfmodel\"]"),
  contextTier: z.dict(z.number()).default({})
    .description("按模型固定上下文档位，如 {\"qfmodel\": 1000000}；缺省时用该模型声明的最大档"),
  autoCheckIn: z.boolean().default(true)
    .description("自动领取 Qoder 每日签到奖励（每天 10:00 UTC+8 刷新，每次 100 Credits）"),
  accountIntervalMs: z.number().min(60_000).default(30 * 60_000)
    .description("额度/签到轮询间隔（默认 30 分钟）"),
  webSearch: z.boolean().default(true)
    .description("把 Qoder 联网搜索注册成 DSH 的 web 搜索 provider（id 为 qoder）"),
  imageUpload: z.boolean().default(true)
    .description("把内联 base64 图片上传到 Qoder center 换成 OSS URL（失败自动保留 base64）"),
});

function apply(ctx, config) {
  const settings = Config(config ?? {});
  let stopped = false;
  const timers = [];
  const appDataDir = settings.appDataDir ?? defaultAppDataDir();

  // 1) 凭据存储：桌面副本 + 自留副本 + 自动续期（详见 authstore.js）
  const store = new QoderCredentialStore({ appDataDir, logger: ctx.logger });
  let credentials;
  /** 取一份可用凭据并推给上游 bridge；env/config 显式凭据优先。 */
  const loadCredentials = async (options = {}) => {
    if (settings.uid && settings.token) {
      credentials = { uid: settings.uid, token: settings.token, source: "config", user: undefined };
    } else if (process.env.QODER_CN_UID && process.env.QODER_CN_TOKEN) {
      credentials = { uid: process.env.QODER_CN_UID, token: process.env.QODER_CN_TOKEN, source: "env", user: undefined };
    } else {
      credentials = await store.resolve(options);
    }
    if (credentials === undefined) {
      const err = new Error(
        `dsh-qoder-connect: 找不到 Qoder CN 凭据（桌面 ${appDataDir}\\auth.v1.dat 与自留副本 ${await store.path()} 都没有）；请先登录 Qoder CN 桌面版，或设置 QODER_CN_UID/QODER_CN_TOKEN`,
      );
      err.code = "QODER_NO_CREDENTIALS";
      throw err;
    }
    setCredentials({
      uid: credentials.uid,
      token: credentials.token,
      machineId: machineIdFor(appDataDir),
      cosyVersion: QODER_COSY_VERSION,
    });
    return credentials;
  };

  const credentialInfo = () => credentials === undefined ? undefined : {
    uid: credentials.uid,
    user: credentials.user,
    expiresAt: credentials.expiresAt,
    refreshTokenExpiresAt: credentials.refreshTokenExpiresAt,
    refreshedAt: credentials.refreshedAt,
    source: credentials.source,
  };

  // 启动时先同步尝试一次：桌面副本可直接解密；拿不到就留给下面的异步路径（自留副本 + 续期）
  try {
    if (settings.uid && settings.token) {
      credentials = { uid: settings.uid, token: settings.token, source: "config", user: undefined };
    } else if (process.env.QODER_CN_UID && process.env.QODER_CN_TOKEN) {
      credentials = { uid: process.env.QODER_CN_UID, token: process.env.QODER_CN_TOKEN, source: "env", user: undefined };
    } else {
      credentials = store.readDesktop();
    }
    if (credentials !== undefined) {
      setCredentials({
        uid: credentials.uid,
        token: credentials.token,
        machineId: machineIdFor(appDataDir),
        cosyVersion: QODER_COSY_VERSION,
      });
      ctx.logger.info(`dsh-qoder-connect: 凭据来源 ${credentials.source}${credentials.expiresAt ? `，到期 ${credentials.expiresAt}` : ""}`);
    }
  } catch (error) {
    ctx.logger.warn(`dsh-qoder-connect: 桌面凭据读取失败，改走自留副本/续期路径`, error);
    credentials = undefined;
  }

  // 2) 目录（先用内置快照保证首屏可见，再异步拉实时目录）
  const catalog = new QoderCatalog({ logger: ctx.logger });
  const hidden = new Set(settings.hideModels);
  const visibleCatalog = {
    current: () => catalog.current().filter((e) => !hidden.has(e.id)),
    isVisible: () => catalog.isVisible(),
    source: () => catalog.source,
  };

  // 2.5) 浏览器半边：探测结果存储 + status/probe 依赖
  const probeKey = createProbeKey();

  // 2.55) 图片上传器：内联 base64 → Qoder center → OSS URL（见 imageupload.js）。
  // 只活在内存里（结果缓存 LRU 64 条），凭据随 credentials 每次现取。
  const imageUploader = new QoderImageUploader({
    enabled: () => !stopped && settings.imageUpload === true,
    logger: ctx.logger,
  });

  // 2.6) 账号侧：额度 / 订阅 / 自动签到（详见 account.js）
  const account = new QoderAccountService({
    logger: ctx.logger,
    autoClaim: settings.autoCheckIn,
  });
  /** 拉一次账号数据；token 缺失时静默跳过（未登录不是错误）。 */
  const refreshAccount = async (options = {}) => {
    // credentials 还没就绪时退回同步读桌面副本；它可能因文件损坏而抛，这里只当没有 token。
    let token = credentials?.token;
    if (token === undefined) {
      try { token = store.readDesktop()?.token; } catch { token = undefined; }
    }
    if (token === undefined) return account.snapshot();
    return account.refresh({ token, claim: options.claim ?? settings.autoCheckIn, summary: options.summary === true });
  };

  /** 能被探测的模型：声明了思考能力、且没有可用快档（否则目录已给出确定答案）。 */
  const probeCandidates = () => visibleCatalog.current()
    .filter((e) => e.reasoning?.supports === true && e.reasoning?.fastEffort === undefined)
    .map((e) => e.id);
  const probeSection = () => ({
    running: probeRunning,
    candidates: probeCandidates(),
    results: [...probeResults.entries()].map(([id, r]) => ({ id, ...r })),
  });
  let probeRunning = null;

  /** 探测一个模型并记录结果。 */
  const probeModel = async (model) => {
    const entry = visibleCatalog.current().find((e) => e.id === model);
    if (entry === undefined) throw new Error(`未知模型：${model}`);
    if (probeRunning !== null) throw new Error(`已有探测在进行中：${probeRunning}`);
    probeRunning = model;
    try {
      const info = entry.reasoning ?? {};
      const outcome = await probeEfforts({
        model,
        send: makeProbeSender({ model, fastEffort: info.fastEffort }),
        candidates: PROBE_EFFORT_CANDIDATES,
      });
      const record = {
        validation: outcome.validation,
        efforts: outcome.efforts,
        probedAt: new Date().toISOString(),
        ...outcome.reason === undefined ? {} : { reason: outcome.reason },
      };
      probeResults.set(model, record);
      ctx.logger.info(`dsh-qoder-connect: 档位探测 ${model} -> ${outcome.validation} ${outcome.efforts.join(",")}（${outcome.requests} 次请求）`);
      return record;
    } finally {
      probeRunning = null;
    }
  };

  const webDeps = {
    credentials: async () => credentialInfo(),
    credentialStore: () => store.describe(),
    models: () => visibleCatalog.current(),
    appDataDir: () => appDataDir,
    catalogSection: () => ({ source: typeof catalog.source === "function" ? catalog.source() : catalog.source, at: catalog.updatedAt ?? "" }),
    probeSection,
    probeKey,
    probe: probeModel,
    account: () => account.snapshot(),
    accountRefresh: (options) => refreshAccount(options),
    accountClear: () => account.clearClaims(),
    refresh: async () => {
      // 不强制轮换 token：只在快到期时才续（store 自己判断）。
      // 面板上的「刷新」要的是最新状态与模型列表，不是每次都换一个 dt-。
      await loadCredentials();
      await catalog.refresh({ uid: credentials.uid, name: credentials.user?.name ?? "", email: credentials.user?.email ?? "", token: credentials.token });
      await refreshAccount({ claim: true, summary: true });
      runtime?.built?.invalidate?.();
      ctx.emit("llm/adapters-updated");
      return { state: "refreshed" };
    },
    clear: () => { probeResults.clear(); },
    // 走 DSH 的搜索缝本身（不是直接调 provider），这样面板上的「测试搜索」
    // 验的就是 provider 选择 + maxResults 截断那条真实路径。
    webSearch: async (query) => {
      const web = ctx.get("web");
      if (web === undefined) return { ok: false, error: "web capability unavailable" };
      const started = Date.now();
      try {
        const result = await web.search({ query, maxResults: 5 });
        return {
          ok: true,
          ms: Date.now() - started,
          truncated: result.truncated === true,
          sources: (result.sources ?? []).map((s) => ({
            url: s.url,
            title: s.title ?? "",
            snippet: typeof s.snippet === "string" ? s.snippet.slice(0, 300) : "",
            publishedAt: s.publishedAt ?? "",
          })),
        };
      } catch (error) {
        return { ok: false, ms: Date.now() - started, error: `${error?.code ?? "ERROR"}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400) };
      }
    },
    // 图片上传：面板上的「测试上传」直接喂一段 base64，验的是真端点 + 真签名。
    imageSection: () => ({
      enabled: settings.imageUpload === true && !stopped,
      endpoint: QODER_IMAGE_UPLOAD_ENDPOINT,
      maxBytes: QODER_MAX_IMAGE_BYTES,
      supported: [...QODER_SUPPORTED_IMAGE_TYPES],
      cached: imageUploader.size,
      stats: runtime?.shim?.stats?.() ?? { requests: 0, imagesHoisted: 0, imagesKept: 0 },
    }),
    imageUpload: async (data, mediaType) => {
      const started = Date.now();
      try {
        const url = await imageUploader.upload(data, mediaType, undefined);
        if (url === null) return { ok: false, ms: Date.now() - started, error: "上传被跳过（未启用或媒体类型不支持）" };
        return { ok: true, ms: Date.now() - started, url, cached: imageUploader.size };
      } catch (error) {
        return {
          ok: false,
          ms: Date.now() - started,
          error: `${error?.code ?? "ERROR"}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400),
        };
      }
    },
    imageClear: () => imageUploader.clear(),
  };

  // 浏览器半边路由（webServer 缺失时静默跳过）
  ctx.inject(["webServer"], (webCtx) => {
    registerQoderStatusRoute(webCtx, webDeps);
    registerQoderProbeRoute(webCtx, webDeps, probeKey);
  });

  // 联网搜索：注册成 DSH 的 web 搜索 provider（缝见 @deepseek-ai/dsh-web 的 WebRuntime）。
  // 本插件的 cordis.patch.yml 把 `web` 行的 searchProvider 指到了 "qoder"，所以这里
  // **无条件注册**：一旦条件跳过，缝就会以 WEB_PROVIDER_CONFIGURED_MISSING 失败。
  // 关掉搜索用 Config.webSearch，让 available() 报 false（错误变成「已配置但不可用」，语义准确）。
  ctx.inject(["web"], (webCtx) => {
    const provider = new QoderSearchProvider(() => {
      if (stopped || settings.webSearch !== true || credentials === undefined) return { enabled: false };
      return {
        enabled: true,
        user: {
          uid: credentials.uid,
          name: credentials.user?.name ?? "",
          email: credentials.user?.email ?? "",
          token: credentials.token,
        },
      };
    });
    webCtx.effect(() => webCtx.web.registerSearchProvider(provider), "dsh-qoder-connect: web search provider");
    ctx.logger.info(`dsh-qoder-connect: 已注册联网搜索 provider（id=${provider.id}）`);
  });

  let runtime;
  // 回合追踪器：一次 agent run 内所有请求共用 business.id（官方 AgentLifecycle 语义）。
  // 只活在内存里，登出/换账号时随 runtime 一起重建。
  const tracker = new QoderTurnTracker({ version: QODER_COSY_VERSION });
  Promise.resolve().then(async () => {
    // 3) 回环 shim
    //    contextTierFor：Config.contextTier 里显式指定的档位优先，其次用目录声明的最大档
    //    （见 shim.js；官方只接受 available_context_windows 表内的值）。
    const shim = createQoderShim({
      catalog: visibleCatalog,
      logger: ctx.logger,
      //    tracker：一次 agent run 内所有请求共用 business.id / request_set_id
      //    （官方 AgentLifecycle 语义，见 turn.js），让 Qoder 的积分面板能按回合聚合。
      tracker,
      imageUploader,
      contextTierFor: (model) => {
        const asked = settings.contextTier?.[model];
        if (typeof asked === "number") return asked;
        const entry = visibleCatalog.current().find((e) => e.id === model);
        const tiers = entry?.contextWindows;
        return Array.isArray(tiers) && tiers.length > 0 ? tiers[tiers.length - 1] : undefined;
      },
    });
    try { await shim.ready; } catch (error) {
      ctx.logger.error("dsh-qoder-connect: 回环端点启动失败", error);
      return;
    }
    const releaseAdapter = ctx.llm.registerAdapter([VARIANT.id], (() => {
      const built = createQoderAdapter({
        providerId: VARIANT.id,
        displayName: VARIANT.displayName,
        shim,
        catalog: visibleCatalog,
        resolveAttachments: () => ctx.get("attachments"),
        resolveImageAccess: (attachments, ref) =>
          resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get("fs")?.processPathFromHostPath(hostPath), ref),
      });
      runtime = { shim, built, registered: true };
      return built.adapter;
    })());
    ctx.effect(() => () => { releaseAdapter(); shim.close(); stopped = true; for (const t of timers) clearInterval(t); });
    ctx.emit("llm/adapters-updated");

    // 4) 凭据续期 + 目录刷新循环（成功后通知 DSH 重读模型表）
    const refresh = async () => {
      if (stopped) return;
      // 凭据快到期时 store 会自行续期并写回自留副本；续期后 token 变了要重新推给 bridge
      const before = credentials?.token;
      await loadCredentials();
      if (credentials?.token !== before) {
        runtime?.built?.invalidate?.();
        ctx.emit("llm/adapters-updated");
      }
      const ok = await catalog.refresh({ uid: credentials.uid, name: credentials.user?.name ?? "", email: credentials.user?.email ?? "", token: credentials.token });
      if (ok) {
        runtime?.built?.invalidate?.();
        ctx.emit("llm/adapters-updated");
        ctx.logger.info(`dsh-qoder-connect: 模型目录已刷新（${visibleCatalog.current().length} 个模型，source=${catalog.source}）`);
      }
    };
    await refresh();
    const timer = setInterval(() => { refresh().catch((e) => ctx.logger.warn("dsh-qoder-connect: 定时刷新失败", e)); }, settings.refreshIntervalMs);
    timer.unref?.();
    timers.push(timer);

    // 5) 账号侧轮询：额度 / 订阅 / 自动签到
    //    签到活动的刷新时间是每天 10:00 (UTC+8)，所以 30 分钟一轮足够；
    //    活动被领过后服务端会把它标成 CLAIMED，account.js 也记了冷却期，重复轮询不会重复打接口。
    const tickAccount = async () => {
      if (stopped) return;
      try {
        const snap = await refreshAccount({ claim: settings.autoCheckIn, summary: false });
        if (snap.lastError !== undefined) {
          ctx.logger.warn(`dsh-qoder-connect: 账号数据部分失败 — ${snap.lastError}`);
        }
        if (snap.claimed !== undefined && snap.claimed.length > 0) {
          for (const c of snap.claimed) {
            if (c.ok === true && c.replayed !== true) {
              ctx.logger.info(`dsh-qoder-connect: 签到成功 ${c.key ?? c.id} +${c.amount ?? "?"} ${c.kind ?? "credits"}`);
            }
          }
        }
      } catch (error) {
        ctx.logger.warn("dsh-qoder-connect: 账号轮询失败", error);
      }
    };
    await tickAccount();
    const accountTimer = setInterval(() => { tickAccount(); }, settings.accountIntervalMs);
    accountTimer.unref?.();
    timers.push(accountTimer);
  }).catch((error) => ctx.logger.error("dsh-qoder-connect: 插件启动失败", error));
}

export { name, inject, apply, Config };
