/**
 * 全局限流门（插件进程级共享状态）：任一摘要请求遇 429 后进入冷却期，
 * 此后所有摘要请求发出前先等待到「最近一次 429 + rateLimitWaitMs」之后。
 * 等待期间 signal 中止则立即放弃；等待期间的新 429 顺延冷却期。
 * 导出 isRateLimitError / noteRateLimit / gateRateLimit / RATE_LIMIT_WAIT_MS_DEFAULT /
 * resetRateLimitGate。
 */

/** 最近一次 429 限流的时间戳（ms；null = 未遇过限流，门直接放行）。 */
let lastRateLimitAt: number | null = null;

/** 默认限流冷却时长（ms）：调用方未传 rateLimitWaitMs 时的兜底值。 */
export const RATE_LIMIT_WAIT_MS_DEFAULT = 60000;

/** 判定错误信息是否为 429 限流（匹配 429 或 rate limit，大小写不敏感）。 */
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
    const timer = setTimeout(() => {
      cleanup();
      resolve(true);
    }, ms);
    const onAbort = () => {
      cleanup();
      resolve(false);
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 限流等待门：处于 429 冷却期时等待到期限再放行（返回 true）；
 * 等待期间 signal 中止返回 false。未遇过限流或冷却期已过立即放行。waitMs ≤ 0 视为不限流。
 */
export async function gateRateLimit(waitMs: number, signal?: AbortSignal): Promise<boolean> {
  if (waitMs <= 0) return true;
  while (lastRateLimitAt !== null) {
    const remaining = lastRateLimitAt + waitMs - Date.now();
    if (remaining <= 0) return true;
    const completed = await delay(remaining, signal);
    if (!completed) return false;
  }
  return true;
}

/** 重置限流门状态（仅测试使用：用例间隔离）。 */
export function resetRateLimitGate(): void {
  lastRateLimitAt = null;
}
