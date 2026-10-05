/**
 * catalog.js — Qoder 模型目录 -> 插件内部目录条目。
 *
 * 目录来源优先级：
 *   1. 实时 GET /algo/api/v2/model/list（Cosy 签名）
 *   2. data/model-fallback.json（打包时抓取的快照，离线兜底）
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchModelList, QODER_COSY_VERSION } from "./bridge.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FALLBACK_PATH = path.join(HERE, "..", "data", "model-fallback.json");

/** DSH/pi-ai 认识的思考档位全集；未声明的档位置 null（不支持）。 */
const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Qoder thinking_config -> reasoning 字段。
 *  - disabled 分支存在 => off 可用（canDisableThinking）
 *  - enabled.efforts 的 key 即上游声明的档位
 *  - 模型 is_reasoning=false => reasoning:false
 */
function reasoningOf(row) {
  if (row.is_reasoning !== true) return { supports: false };
  const tc = row.thinking_config ?? null;
  const canDisableThinking = !!(tc && tc.disabled);
  const declared = tc && tc.enabled && tc.enabled.efforts ? Object.keys(tc.enabled.efforts) : [];
  const defaultEffort = (() => {
    if (!tc || !tc.enabled) return undefined;
    const efforts = tc.enabled.efforts;
    if (!efforts) return undefined;
    const hit = Object.entries(efforts).find(([, v]) => v && v.is_default);
    return hit ? hit[0] : undefined;
  })();
  // thinking_config 缺失（auto/q37fmodel/gmodel 等）时按上游接受度视为通用档位。
  //
  // 实测（E:\DSH CODE\timing.mjs，2026-10 逐档实测）：
  //   1) 字段缺省时上游套用自己的默认档（常常是 max/medium），思考量极大：
  //        gmodel 不传 16032ms、auto 不传 6972ms（正文首字 6879ms）、kmodel 9624ms
  //      所以“什么都不发”远慢于显式下发，必须永远填一个档位。
  //   2) 不同模型接受的快档并不一样，且没有 disabled 分支的模型行为分两类：
  //        auto / q37fmodel       -> off|low 均可用且快（0.6~1.6s），medium|high 要 11~26s
  //        gmodel/gfmodel/kmodel  -> off|low|medium 一律 provider_error，只有 high 能用
  //      因此不能用“能不能关思考”一个布尔量推断，得看实测表。
  const CANNOT_DISABLE_FAST = {
    // 无 disabled 分支、但 low 档可用
    auto: "low",
    q37fmodel: "low",
    // 无 disabled 分支、且只接受 high
    gmodel: "high",
    gfmodel: "high",
    kmodel: "high",
    kmodel_latest: "high",
  };
  const levels = declared.length > 0 ? declared : ["low", "medium", "high", "xhigh", "max"];
  const map = {};
  for (const level of ALL_LEVELS) {
    if (level === "off") { map.off = canDisableThinking ? "off" : null; continue; }
    map[level] = levels.includes(level) ? level : null;
  }
  // 该模型的“尽快出正文”档位：
  //   能关思考 -> off（enable_thinking=false，最省）
  //   关不掉   -> 查实测表；查不到就退到声明里的 low（若声明了 low 与 medium，
  //              说明它属于 auto 那类可关型），否则退到 high。
  const fast = canDisableThinking
    ? "off"
    : (CANNOT_DISABLE_FAST[row.key] ?? (levels.includes("low") && levels.includes("medium") ? "low" : "high"));
  map.minimal = fast;
  map.medium = fast;
  map.low = fast;
  if (!canDisableThinking) map.off = fast;
  return {
    supports: true,
    canDisableThinking,
    supportedEfforts: levels,
    defaultEffort: defaultEffort && levels.includes(defaultEffort) ? defaultEffort : undefined,
    thinkingLevelMap: map,
    // 关不掉思考时，唯一被上游接受、且明显省时的档位（如 gmodel=high）；
    // 能关思考时为 undefined（直接 enable_thinking=false 更快）。
    fastEffort: canDisableThinking ? undefined : fast,
  };
}

const isPosInt = (v) => typeof v === "number" && Number.isInteger(v) && v > 0;

/**
 * 可用上下文档位 —— 复刻官方 worker `HV()` / `Y1()`：
 *   1. 有 context_config  -> 取其中全部 token_count（去重升序），is_default 那项为默认档
 *   2. 否则有 available_context_windows -> 直接用
 *   3. 否则由 max_input_tokens 合成 [128K, 200K, max] 中不超过 max 的部分
 * 官方 `LV(model, n)` 的判据：有档位表就必须命中表内，否则 n <= max_input_tokens。
 */
export function contextTiersOf(row) {
  const windows = [];
  const seen = new Set();
  let defaultWindow;
  const push = (n) => { if (!isPosInt(n) || seen.has(n)) return; seen.add(n); windows.push(n); };
  const cc = row.context_config;
  if (cc && typeof cc === "object" && !Array.isArray(cc)) {
    for (const v of Object.values(cc)) {
      if (!v || typeof v !== "object") continue;
      push(v.token_count);
      if (v.is_default === true) defaultWindow = v.token_count;
    }
  }
  if (windows.length === 0) {
    const raw = row.available_context_windows ?? row.availableContextWindows;
    if (Array.isArray(raw)) for (const n of raw) push(n);
  }
  if (windows.length === 0) {
    const max = row.max_input_tokens ?? row.maxInputTokens;
    if (isPosInt(max)) { push(128_000); push(200_000); push(max); }
  }
  windows.sort((a, b) => a - b);
  if (!isPosInt(defaultWindow) || !seen.has(defaultWindow)) defaultWindow = undefined;
  return { windows, defaultWindow };
}

/**
 * 模型实际生效的上下文窗口（DSH 用它决定何时压缩）。
 * 官方 `y5e(model, requested, fallback)`：请求档合法则用它，否则用 default_context_window，
 * 再否则退回 max_input_tokens。这里默认取**最大档**（官方 App 也把 1M 列出来供选），
 * 让 DSH 不因 200K 的默认档而过早压缩；要固定某一档用 Config.contextTier。
 */
function contextWindowOf(row, tiers) {
  if (tiers.windows.length > 0) return tiers.windows[tiers.windows.length - 1];
  return isPosInt(row.max_input_tokens) ? row.max_input_tokens : 131072;
}

/**
 * 一行目录 -> 插件 catalog entry。
 * @returns {{id,name,display_name,supportsImages,reasoning,contextWindow,maxTokens,price_factor,is_free,promotion}}
 */
export function toEntry(row) {
  const reasoning = reasoningOf(row);
  const promotion = row.promotion && row.promotion.active ? row.promotion : undefined;
  const tiers = contextTiersOf(row);
  return {
    id: row.key,
    name: row.display_name || row.key,
    display_name: row.display_name || row.key,
    supportsImages: row.is_vl === true,
    reasoning,
    contextWindow: contextWindowOf(row, tiers),
    // 上游声明的上下文档位（如 [200000,400000,1000000]）与默认档。
    // 请求时通过 parameters.context_length 下发选中档；官方只接受表内的值。
    contextWindows: tiers.windows,
    defaultContextWindow: tiers.defaultWindow,
    // 目录原始 max_input_tokens：官方 model_config.max_input_tokens 用的就是它，
    // 与档位无关（qfmodel 是 180000，而档位最大到 1000000）。
    maxInputTokens: isPosInt(row.max_input_tokens) ? row.max_input_tokens : undefined,
    // 上游接受 65536（实测），但按目录声明保守取 32768 输出上限。
    maxTokens: 32768,
    price_factor: typeof row.price_factor === "number" ? row.price_factor : undefined,
    is_free: row.is_free === true,
    is_default: row.is_default === true,
    promotion,
    source: row.source ?? "system",
    format: row.format ?? "openai",
  };
}

function fallbackRows() {
  try {
    const j = JSON.parse(readFileSync(FALLBACK_PATH, "utf8"));
    return Array.isArray(j.chat) ? j.chat : [];
  } catch {
    return [];
  }
}

/** 目录源：live 拉取失败回退快照。 */
export class QoderCatalog {
  constructor({ logger } = {}) {
    this.rows = fallbackRows().map(toEntry);
    this.source = this.rows.length > 0 ? "fallback" : "empty";
    this.lastError = undefined;
    this.lastFetchAtMs = 0;
    this.logger = logger;
  }

  current() { return this.rows; }

  isVisible() { return this.rows.length > 0; }

  /** 用凭证刷新目录；失败保留旧目录并记录错误。 */
  async refresh(user, ideVersion = QODER_COSY_VERSION) {
    try {
      const live = await fetchModelList(user, ideVersion);
      if (live.length === 0) throw new Error("qoder: model list came back empty");
      this.rows = live.map(toEntry);
      this.source = "live";
      this.lastError = undefined;
      this.lastFetchAtMs = Date.now();
      return true;
    } catch (error) {
      this.lastError = error;
      this.lastFetchAtMs = Date.now();
      this.logger?.warn?.(`dsh-qoder-connect: 目录刷新失败（保留 ${this.source} 目录）`, error);
      return false;
    }
  }
}
