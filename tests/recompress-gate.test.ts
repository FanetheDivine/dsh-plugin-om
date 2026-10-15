// recompress-gate.ts 单元测试：进程级并发信号量的上限、FIFO、排队中止与热调整。
import { afterEach, describe, expect, it } from 'vitest';

import { acquireRecompressSlot, resetRecompressGate } from '../src/recompress-gate.ts';

/** 让已就绪的微任务队列跑完。 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => resetRecompressGate());

describe('acquireRecompressSlot', () => {
  it('上限内立即获得许可，超出的排队，释放后按先进先出唤醒', async () => {
    const order: string[] = [];
    const first = await acquireRecompressSlot(() => 2);
    const second = await acquireRecompressSlot(() => 2);
    const third = acquireRecompressSlot(() => 2).then((release) => {
      order.push('third');
      return release;
    });
    const fourth = acquireRecompressSlot(() => 2).then((release) => {
      order.push('fourth');
      return release;
    });
    await flush();
    expect(order).toEqual([]);
    first();
    await flush();
    expect(order).toEqual(['third']);
    second();
    await flush();
    expect(order).toEqual(['third', 'fourth']);
    (await third)();
    (await fourth)();
  });

  it('release 幂等，重复调用不会多放许可', async () => {
    const release = await acquireRecompressSlot(() => 1);
    release();
    release();
    const second = await acquireRecompressSlot(() => 1);
    let waiting = true;
    const third = acquireRecompressSlot(() => 1).then((r) => {
      waiting = false;
      return r;
    });
    await flush();
    expect(waiting).toBe(true);
    second();
    (await third)();
  });

  it('排队中 signal 中止则拒绝，且不占用许可', async () => {
    const holder = await acquireRecompressSlot(() => 1);
    const controller = new AbortController();
    const queued = acquireRecompressSlot(() => 1, controller.signal);
    const rejected = expect(queued).rejects.toThrow(/abort/i);
    controller.abort();
    await rejected;
    holder();
    const next = await acquireRecompressSlot(() => 1);
    next();
  });

  it('已中止的 signal 直接拒绝，不入队', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(acquireRecompressSlot(() => 1, controller.signal)).rejects.toThrow(/abort/i);
  });

  it('上限热调大后，释放时唤醒更多排队者', async () => {
    let limit = 1;
    const holder = await acquireRecompressSlot(() => limit);
    const woken: number[] = [];
    const a = acquireRecompressSlot(() => limit).then((r) => {
      woken.push(1);
      return r;
    });
    const b = acquireRecompressSlot(() => limit).then((r) => {
      woken.push(2);
      return r;
    });
    await flush();
    limit = 3;
    holder();
    await flush();
    expect(woken).toEqual([1, 2]);
    (await a)();
    (await b)();
  });
});
