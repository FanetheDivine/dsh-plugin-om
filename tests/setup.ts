/**
 * vitest 全局准备：宿主 appendPluginRecord 只接受真实 Session 实例，而单测使用
 * helpers.ts 的极简会话模拟。这里让模拟会话走其 append（写入 ignorable 事件），
 * 真实 Session 仍走宿主原实现。
 */
import { vi } from 'vitest';

vi.mock('@deepseek-ai/dsh-session', async (importOriginal) => {
  const original = await importOriginal<typeof import('@deepseek-ai/dsh-session')>();
  return {
    ...original,
    appendPluginRecord: ((session, type, data) => {
      if (session instanceof original.Session) {
        return original.appendPluginRecord(session, type, data);
      }
      const mock = session as unknown as {
        append(type: string, data: unknown, opts: { ignorable: true }): { seq: number };
      };
      return mock.append(type, data, { ignorable: true }).seq;
    }) as typeof original.appendPluginRecord,
  };
});
