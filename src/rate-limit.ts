/**
 * 全局限流门（插件进程级共享状态）：任一摘要请求遇 429 限流后记录时间戳，
 * 此后所有摘要请求在发出前先等待到「最近一次 429 + rateLimitWaitMs」之后——
 * 并行压缩时其他块的下一次请求同样受限。等待期间 signal 中止则立即放弃。
 *
 * 门在进入时与等待结束时都会重读最近限流时间戳：等待期间发生新的 429 会顺延
 * 冷却期（循环等待直到通过或中止）。
 */

/** 最近一次 429 限流的时间戳（ms；null = 未遇过限流，门直接放行）。 */
let lastRateLimitAt: number | null = null;

/** 默认限流冷却时长（ms）：调用方未传 rateLimitWaitMs 时的兜底值（与配置默认一致）。 */
export const RATE_LIMIT_WAIT_MS_DEFAULT = 60000;

/**
 * 判定错误信息是否为 429 限流：匹配 429（独立数字）或 rate limit（空格/连字符/
 * 下划线分隔与 camelCase 均可），大小写不敏感。
 */
export function isRateLimitError(message: string): boolean {
  return /\b429\b|rate[\s_-]?limit/i.test(message);
}

/** 记录一次 429 限流：把冷却期起点更新为当前时间。 */
export function noteRateLimit(): void {
  lastRateLimitAt = Date.now();
}

/** 可中止延时：等待满 ms 返回 true；等待期间 signal 中止返回 false。 */
function delay(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    /** 定时器句柄（正常到点或中止清理用）。 */
    const timer = setTimeout(() => {
      cleanup();
      resolve(true);
    }, ms);
    /** 中止监听（到点立即返回 false）。 */
    const onAbort = () => {
      cleanup();
      resolve(false);
    };
    /** 清理定时器与中止监听。 */
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 限流等待门：处于 429 冷却期（最近一次 429 + waitMs 未到）时等待到期限，
 * 通过后返回 true；等待期间 signal 中止返回 false。未遇过限流或冷却期已过
 * 立即放行。waitMs ≤ 0 视为不限流。
 */
export async function gateRateLimit(waitMs: number, signal?: AbortSignal): Promise<boolean> {
  if (waitMs <= 0) return true;
  while (lastRateLimitAt !== null) {
    /** 距冷却期结束的剩余等待（≤ 0 表示已过冷却期）。 */
    const remaining = lastRateLimitAt + waitMs - Date.now();
    if (remaining <= 0) return true;
    /** 等待（可能被中止）；等待结束后重读时间戳（期间的新 429 会顺延冷却期）。 */
    const completed = await delay(remaining, signal);
    if (!completed) return false;
  }
  return true;
}

/** 重置限流门状态（仅测试使用：用例间隔离）。 */
export function resetRateLimitGate(): void {
  lastRateLimitAt = null;
}
