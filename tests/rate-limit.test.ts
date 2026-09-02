// 全局限流门单元测试：isRateLimitError（429/rate limit 识别）与
// gateRateLimit（冷却期等待 / 期满放行 / 未限流放行 / 中止放弃 / 新 429 顺延）。
// 门是模块级共享状态，用例间经 resetRateLimitGate 隔离；时间用 vitest fake timers 控制。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  gateRateLimit,
  isRateLimitError,
  noteRateLimit,
  resetRateLimitGate,
} from '../src/rate-limit.ts';

describe('isRateLimitError（429 识别）', () => {
  it('匹配各种 429 / rate limit 写法', () => {
    expect(isRateLimitError('HTTP 429: Too Many Requests')).toBe(true);
    expect(isRateLimitError('Request failed with status code 429')).toBe(true);
    expect(isRateLimitError('(429) rate limited')).toBe(true);
    expect(isRateLimitError('rate limit exceeded')).toBe(true);
    expect(isRateLimitError('Rate Limit Exceeded')).toBe(true);
    expect(isRateLimitError('RATE_LIMIT_EXCEEDED')).toBe(true);
    expect(isRateLimitError('rate-limit error')).toBe(true);
    expect(isRateLimitError('provider returned ratelimit')).toBe(true);
  });

  it('不匹配普通错误与包含 429 数字的无关数值', () => {
    expect(isRateLimitError('network timeout')).toBe(false);
    expect(isRateLimitError('HTTP 500: Internal Server Error')).toBe(false);
    expect(isRateLimitError('request aborted')).toBe(false);
    expect(isRateLimitError('error id 14295')).toBe(false); // 429 不是独立数字
    expect(isRateLimitError('')).toBe(false);
  });
});

describe('gateRateLimit（限流等待门）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRateLimitGate();
  });
  afterEach(() => {
    resetRateLimitGate();
    vi.useRealTimers();
  });

  it('未遇限流时直接放行', async () => {
    expect(await gateRateLimit(60000)).toBe(true);
  });

  it('waitMs ≤ 0 视为不限流，即使处于冷却期也放行', async () => {
    noteRateLimit();
    expect(await gateRateLimit(0)).toBe(true);
    expect(await gateRateLimit(-1)).toBe(true);
  });

  it('遇 429 后在冷却期内等待，期满放行', async () => {
    noteRateLimit();
    /** 放行标记（期满前不应置位）。 */
    let released = false;
    const gate = gateRateLimit(60000).then((v) => {
      released = true;
      return v;
    });
    await vi.advanceTimersByTimeAsync(59999);
    expect(released).toBe(false); // 冷却期内不放行
    await vi.advanceTimersByTimeAsync(1);
    expect(await gate).toBe(true); // 冷却期满放行
  });

  it('冷却期已过立即放行（不等待）', async () => {
    noteRateLimit();
    await vi.advanceTimersByTimeAsync(60000);
    /** 放行标记（同步检查：立即 resolve 则微任务后已置位）。 */
    let released = false;
    const gate = gateRateLimit(60000).then((v) => {
      released = true;
      return v;
    });
    await Promise.resolve();
    expect(released).toBe(true);
    expect(await gate).toBe(true);
  });

  it('等待期间 signal 中止立即返回 false', async () => {
    noteRateLimit();
    /** 中止控制器（等待中途触发）。 */
    const controller = new AbortController();
    const gate = gateRateLimit(60000, controller.signal);
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    expect(await gate).toBe(false);
  });

  it('signal 预先已中止时直接返回 false', async () => {
    noteRateLimit();
    /** 已中止的控制器。 */
    const controller = new AbortController();
    controller.abort();
    expect(await gateRateLimit(60000, controller.signal)).toBe(false);
  });

  it('等待期间发生新的 429 会顺延冷却期（以最近一次为准）', async () => {
    noteRateLimit();
    const gate = gateRateLimit(60000);
    await vi.advanceTimersByTimeAsync(30000);
    noteRateLimit(); // 等待中另一次请求遇 429：冷却期重新计时
    await vi.advanceTimersByTimeAsync(59999);
    /** 放行标记（顺延期内不应置位）。 */
    let released = false;
    const probe = Promise.race([gate, Promise.resolve('pending')]).then((v) => {
      if (v !== 'pending') released = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    await probe;
    expect(released).toBe(false); // 距第二次 429 仅 59999ms，仍不放行
    await vi.advanceTimersByTimeAsync(1);
    expect(await gate).toBe(true); // 第二次 429 后满 60000ms 放行
  });
});
