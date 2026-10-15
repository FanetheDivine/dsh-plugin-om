/**
 * 重压缩并发门（插件进程级共享状态）：限制同时运行的 /om-recompress 数量，超出的先进先出排队。
 * 上限由调用方以函数传入，每次获取与唤醒时重读，配置热更新即时生效。
 * 排队中 signal 中止则拒绝并退出队列。
 * 导出 acquireRecompressSlot / resetRecompressGate。
 */

/** 排队中的获取请求。 */
type Waiter = {
  limit: () => number;
  grant: () => void;
};

/** 当前持有许可的数量。 */
let active = 0;

/** 排队中的请求（先进先出）。 */
const queue: Waiter[] = [];

/** 按各自上限唤醒队首请求，直到许可用尽。 */
function drain(): void {
  while (queue.length > 0) {
    const head = queue[0];
    if (head === undefined || active >= Math.max(1, head.limit())) return;
    queue.shift();
    head.grant();
  }
}

/** 获取一个重压缩许可，返回幂等的 release；signal 中止时拒绝。 */
export function acquireRecompressSlot(
  limit: () => number,
  signal?: AbortSignal,
): Promise<() => void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    const grant = () => {
      signal?.removeEventListener('abort', onAbort);
      active++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        active--;
        drain();
      });
    };
    const waiter: Waiter = { limit, grant };
    const onAbort = () => {
      const index = queue.indexOf(waiter);
      if (index >= 0) queue.splice(index, 1);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    queue.push(waiter);
    drain();
  });
}

/** 清空并发门状态（仅供测试）。 */
export function resetRecompressGate(): void {
  active = 0;
  queue.length = 0;
}
