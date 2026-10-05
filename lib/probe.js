/**
 * 推理档位探测：向某个模型发少量真实请求，确认它到底接受哪些档位。
 *
 * 为什么需要它：Qoder 目录里的 thinking_config 并不总是说实话 ——
 *   · 有的模型声明了 [low,medium,high,...] 却没有 disabled 分支，传 low 直接 400；
 *   · 有的模型的快档只有 high（传 off/low/medium 一律 provider_error）；
 *   · 有的模型声明了档位却根本不校验（传什么都接受）。
 * 靠目录猜不出来，只能打一枪看回什么。
 *
 * 探测流程（照搬 dsh-workbuddy-connect 的 probeModel，换成 Qoder 的判据）：
 *   1. baseline：不带 effort 打一次。失败说明模型/凭据本身有问题，判 unknown。
 *   2. sentinel：带一个随机垃圾档位打一次。
 *        · 被接受 -> 该模型不校验该参数，判 non-validating（界面上「该模型不校验该参数」）。
 *        · 被拒   -> 说明确实校验，进入第 3 步。
 *        · 其它   -> unknown。
 *   3. 逐档验证 candidates，记下被接受的档位，判 validating。
 *
 * 每次探测最多 2 + candidates.length 次请求，全部走插件自己的 bridge，
 * 不碰 DSH 的对话链路。
 */
import { chatCompletionChunks } from "./bridge.js";

/** 探测档位候选（与 DSH 的 thinkingLevelMap 语义一致）。 */
export const PROBE_EFFORT_CANDIDATES = ["off", "low", "medium", "high", "xhigh", "max"];

/** 单次探测请求超时。 */
const PROBE_TIMEOUT_MS = 30_000;

/** 随机 sentinel：一个必然不被任何真实档位接受的字符串。 */
export function randomSentinel() {
  return `__probe_${Math.random().toString(36).slice(2, 10)}__`;
}

/**
 * 判定一次探测结果是否代表「上游接受了这次请求」。
 * 判据：拿到了 HTTP 层响应且没有抛错 —— bridge 把非 2xx 转成异常，
 * 所以能走到这里就说明上游没拒。
 */
function isAcceptance(result) {
  return result.ok === true;
}

/**
 * 判定一次失败是否属于「参数值不被接受」。
 * Qoder 网关对非法 effort 的回应是 provider_error / Execution failed 这类
 * 参数级错误；网络层、鉴权层错误不算。
 */
function isEffortRejection(result) {
  if (result.ok !== false) return false;
  const text = `${result.detail ?? ""}`.toLowerCase();
  if (text.includes("provider_error")) return true;
  if (text.includes("execution failed")) return true;
  if (text.includes("invalid") && text.includes("reasoning")) return true;
  if (text.includes("unsupported") || text.includes("not support")) return true;
  if (text.includes("400")) return true;
  return false;
}

function unknownReason(where, result) {
  const detail = typeof result.detail === "string" ? result.detail.slice(0, 200) : String(result.detail ?? "");
  return `${where}: ${result.detail === undefined ? `status ${result.status}` : detail}`;
}

/**
 * 探测一个模型可用的推理档位。
 *
 * @param {object} options
 * @param {string} options.model 模型 key
 * @param {(effort: string|undefined, signal: AbortSignal) => Promise<object>} options.send 发送一次探测请求
 * @param {string[]} [options.candidates] 档位候选
 * @param {number} [options.timeoutMs] 单次超时
 * @param {() => string} [options.sentinel] sentinel 生成器
 * @returns {Promise<{validation:"validating"|"non-validating"|"unknown", efforts:string[], requests:number, reason?:string}>}
 */
export async function probeEfforts(options) {
  const sentinel = options.sentinel ?? randomSentinel;
  const candidates = options.candidates ?? PROBE_EFFORT_CANDIDATES;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  let requests = 0;

  const attempt = async (effort) => {
    requests += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await options.send(effort, controller.signal);
    } catch (error) {
      return { ok: false, status: 0, detail: `transport error: ${String(error)}` };
    } finally {
      clearTimeout(timer);
    }
  };

  const baseline = await attempt(undefined);
  if (!isAcceptance(baseline)) {
    return { validation: "unknown", efforts: [], requests, reason: unknownReason("baseline", baseline) };
  }

  const sentinelAttempt = await attempt(sentinel());
  if (isAcceptance(sentinelAttempt)) {
    // 上游对垃圾档位照单全收 —— 这个模型不校验该参数。
    return { validation: "non-validating", efforts: [], requests };
  }
  if (!isEffortRejection(sentinelAttempt)) {
    return { validation: "unknown", efforts: [], requests, reason: unknownReason("sentinel", sentinelAttempt) };
  }

  const accepted = [];
  for (const effort of candidates) {
    const levelAttempt = await attempt(effort);
    if (isAcceptance(levelAttempt)) {
      accepted.push(effort);
      continue;
    }
    if (isEffortRejection(levelAttempt)) continue;
    return { validation: "unknown", efforts: [], requests, reason: unknownReason(`level ${effort}`, levelAttempt) };
  }
  return { validation: "validating", efforts: accepted, requests };
}

/**
 * 探测一条消息：只发一个最小的非流式请求，看上游收不收。
 * 之所以要读完整流，是因为 Qoder 的错误是在 SSE 里回的，只看 HTTP 状态不够。
 */
export function makeProbeSender({ model, fastEffort }) {
  return async (effort, signal) => {
    try {
      let sawError = null;
      let sawAny = false;
      const stream = chatCompletionChunks({
        model,
        messages: [{ role: "user", content: "hi" }],
        is_reasoning: true,
        reasoning_effort: effort,
        fast_effort: fastEffort,
        max_tokens: 8,
        signal,
      });
      for await (const chunk of stream) {
        sawAny = true;
        const delta = chunk.choices?.[0]?.delta ?? {};
        if (typeof delta.content === "string" && delta.content.length > 0) break;
        if (chunk.error) { sawError = String(chunk.error); break; }
      }
      if (sawError !== null) return { ok: false, status: 200, detail: sawError };
      return { ok: true, status: 200, streamed: sawAny };
    } catch (error) {
      return { ok: false, status: 0, detail: String(error?.message ?? error) };
    }
  };
}
