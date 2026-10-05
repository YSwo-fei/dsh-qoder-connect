/**
 * 回合身份（turn identity）—— 对齐官方 worker 的 `AgentLifecycle` / `Pgr()`。
 *
 * 为什么需要：
 *   Qoder 的积分面板按「一次 agent run」聚合消费，聚合键就是每个请求上报的
 *   `business.id`。本插件早期每个请求都新生成 `req-<ts>-<rand>`，等于告诉上游
 *   「每次调用都是一个新回合」，于是消费记录被拆成无数条碎片。
 *
 * 官方语义（qoder-worker-runtime.obf.mjs）：
 *   Pgr(A,e,t,i,n) -> {product, version, type, id, name, begin_at, stage}
 *     product  : XuA() -> "cli" | "ide" | "qoder_work"（桌面）/ "quest"
 *     type     : "agent" | "quest"
 *     id       : QPe() 随机 UUID，**一次 agent run 一个**，run 内所有请求共用
 *     name     : u7s(type, prompt, t) -> prompt 前 10 个字符
 *     begin_at : Date.now()（run 开始时）
 *     stage    : juA="init" -> rjA="start" -> tPe="processing"
 *                （changeBusinessState() 在 agent loop 开始与每次模型返回后各推一次）
 *   request_set_id 与 business.id 同源（G4A 的 o.requestSetId，来自 lifecycle.requestSetId）。
 *   finalize() 时补 end_at；abort/error/complete 分别对应 rPe/iPe/nPe。
 *
 * 本插件拿不到官方的 lifecycle 对象（DSH 走的是 OpenAI 兼容 HTTP，不带会话标识），
 * 所以从请求体本身重建：
 *   - 会话种子 = 第一条 user 消息的文本哈希。DSH 每次都重发全量历史，所以这个值
 *     在整段会话里稳定。
 *   - 回合键   = 哈希(会话种子 + user 消息条数)。工具调用期间 DSH 追加的是
 *     assistant / tool 消息，user 条数不变 —— 正好对应「同一次 agent run」；
 *     用户再发一条新消息，条数 +1，自然开新回合。
 */

import { createHash } from "node:crypto";

export const BUSINESS_PRODUCT_CLI = "cli";
export const BUSINESS_PRODUCT_IDE = "ide";
export const BUSINESS_PRODUCT_DESKTOP = "qoder_work";
export const BUSINESS_TYPE_AGENT = "agent";
export const BUSINESS_TYPE_QUEST = "quest";
export const BUSINESS_STAGE_INIT = "init";
export const BUSINESS_STAGE_START = "start";
export const BUSINESS_STAGE_PROCESSING = "processing";
export const BUSINESS_STAGE_COMPLETE = "complete";
export const BUSINESS_STAGE_ABORT = "abort";
export const BUSINESS_STAGE_ERROR = "error";
/** 官方 u7s()：business.name 取 prompt 前 10 个字符。 */
export const BUSINESS_NAME_MAX = 10;
/** 内存里保留多少个回合的 begin_at / stage 状态。 */
export const TURN_TRACKER_CAPACITY = 64;

function sha1(input) {
  return createHash("sha1").update(input).digest("hex");
}

/** 把 OpenAI 风格的 content（字符串 / 分块数组 / null）折成纯文本。 */
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (part && part.type === "text" && typeof part.text === "string") parts.push(part.text);
    }
    return parts.join("\n");
  }
  return "";
}

/**
 * 官方 u7s(type, prompt, t)：code_review 保留全文，其它类型截前 10 字符。
 * @param {string} prompt
 * @param {{type?: string, max?: number}} [options]
 */
export function businessName(prompt, options = {}) {
  const text = typeof prompt === "string" ? prompt.trim() : "";
  if (options.type === "code_review") return text;
  const max = Number.isInteger(options.max) && options.max > 0 ? options.max : BUSINESS_NAME_MAX;
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * 从消息数组推出回合标识。纯函数，不碰任何全局状态。
 *
 * @param {Array<{role?: string, content?: unknown}>} messages
 * @returns {{sessionKey: string, runKey: string, userTurns: number, name: string, prompt: string}|undefined}
 *   没有任何 user 消息时返回 undefined（调用方应退回旧行为）。
 */
export function turnKeyFor(messages) {
  if (!Array.isArray(messages)) return undefined;
  const users = [];
  for (const message of messages) {
    if (message && message.role === "user") users.push(message);
  }
  if (users.length === 0) return undefined;
  const seed = sha1(textOf(users[0].content));
  const prompt = textOf(users[users.length - 1].content);
  return {
    sessionKey: seed.slice(0, 32),
    runKey: sha1(`${seed}|${users.length}`).slice(0, 32),
    userTurns: users.length,
    name: businessName(prompt),
    prompt,
  };
}

/**
 * 回合追踪器：给每个 run 分配稳定的 business.id，并维护 begin_at / stage 推进。
 *
 * 用法：
 *   const tracker = new QoderTurnTracker({ version: QODER_COSY_VERSION });
 *   const turn = tracker.begin(body.messages);   // -> {business, request_set_id} | undefined
 */
export class QoderTurnTracker {
  /**
   * @param {{capacity?: number, product?: string, type?: string, version?: string,
   *          stageSequence?: string[], now?: () => number}} [options]
   */
  constructor(options = {}) {
    this.capacity = Number.isInteger(options.capacity) && options.capacity > 0
      ? options.capacity
      : TURN_TRACKER_CAPACITY;
    this.product = options.product ?? BUSINESS_PRODUCT_DESKTOP;
    this.type = options.type ?? BUSINESS_TYPE_AGENT;
    this.version = options.version ?? "";
    this.now = options.now ?? Date.now;
    this.stageSequence = Array.isArray(options.stageSequence) && options.stageSequence.length > 0
      ? options.stageSequence
      : [BUSINESS_STAGE_START, BUSINESS_STAGE_PROCESSING];
    /** @type {Map<string, {id: string, beginAt: number, stage: string, seen: number, touched?: number}>} */
    this.runs = new Map();
    this.clock = 0;
  }

  /** 当前已记录的回合数（测试用）。 */
  get size() {
    return this.runs.size;
  }

  /** 丢弃全部回合状态（登出 / 换账号时调用）。 */
  clear() {
    this.runs.clear();
    this.clock = 0;
  }

  /**
   * 记录一次请求，返回要下发给上游的 business 与 request_set_id。
   *
   * @param {Array<{role?: string, content?: unknown}>} messages
   * @param {{requestSetId?: string}} [options]
   * @returns {{business: object, request_set_id: string, runKey: string, userTurns: number}|undefined}
   */
  begin(messages, options = {}) {
    const turn = turnKeyFor(messages);
    if (!turn) return undefined;
    const now = this.now();
    let run = this.runs.get(turn.runKey);
    if (!run) {
      run = { id: turn.runKey, beginAt: now, stage: this.stageSequence[0], seen: 0 };
      this.runs.set(turn.runKey, run);
      this.evict();
    }
    const stage = run.seen === 0
      ? this.stageSequence[0]
      : this.stageSequence[Math.min(run.seen, this.stageSequence.length - 1)];
    run.seen += 1;
    run.stage = stage;
    run.touched = ++this.clock;
    const requestSetId = typeof options.requestSetId === "string" && options.requestSetId.length > 0
      ? options.requestSetId
      : run.id;
    return {
      business: {
        product: this.product,
        version: this.version,
        type: this.type,
        id: run.id,
        name: turn.name,
        begin_at: run.beginAt,
        stage,
      },
      request_set_id: requestSetId,
      runKey: turn.runKey,
      userTurns: turn.userTurns,
    };
  }

  /**
   * 标记某回合结束，补 end_at 与终态 stage（官方 finalize()）。
   * 上游请求本身不带终态，这里主要给调用方做记录用。
   */
  end(runKey, stage = BUSINESS_STAGE_COMPLETE) {
    const run = this.runs.get(runKey);
    if (!run) return undefined;
    run.stage = stage;
    run.endAt = this.now();
    run.touched = ++this.clock;
    return { ...run };
  }

  /** 超过容量时按最近使用时间淘汰。 */
  evict() {
    while (this.runs.size > this.capacity) {
      let oldestKey;
      let oldest = Infinity;
      for (const [key, run] of this.runs) {
        const touched = run.touched ?? 0;
        if (touched < oldest) { oldest = touched; oldestKey = key; }
      }
      if (oldestKey === undefined) break;
      this.runs.delete(oldestKey);
    }
  }
}
