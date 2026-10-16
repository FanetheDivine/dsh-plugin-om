// 客户端入口注册测试：压缩卡片槽注入宿主 openSession 并转发到 uiWorkspace，
// 以及 command/executed 监听把 /om-compaction-eval 的新会话跳转接到 uiWorkspace。

import type { Context } from '@deepseek-ai/cordis';
import type { CommandResult } from '@deepseek-ai/dsh-commands/types';
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client';
import { describe, expect, it, vi } from 'vitest';
import { apply, inject } from '../../src/client/index.ts';
import type { RecompressInjected } from '../../src/client/recompress-run.ts';

interface Registration {
  name: string;
  key: string;
  inject?: (sessionId: string) => {
    openSession?: (target: SubagentAddress) => void;
    recompress?: RecompressInjected;
  };
}

/** command/executed 监听回调的形状（会话 id、命令名、宿主命令结果）。 */
type ExecutedListener = (sessionId: string, name: string, result: CommandResult) => void;

/** 客户端事件监听记录。 */
interface Listener {
  type: string;
  fn: ExecutedListener;
}

/** 构造只实现入口实际读取服务的宿主桩，并收集所有槽注册。 */
function setup(extra: Record<string, unknown> = {}) {
  const registrations: Registration[] = [];
  const listeners: Listener[] = [];
  const openSession = vi.fn();
  const base = {
    effect: (factory: () => (() => void) | undefined) => factory(),
    on: (type: string, fn: ExecutedListener) => {
      listeners.push({ type, fn });
      return () => {};
    },
    locale: { register: () => () => {} },
    uiConversation: { events: { register: () => () => {} } },
    uiWorkspace: { openSession },
    configForms: {
      get: () => ({
        subscribe: () => () => {},
        getSnapshot: () => ({ status: 'unavailable' }),
      }),
      whileServed: (_names: string[], fn: () => () => void) => fn(),
    },
    slots: {
      inject: (_name: string, callback: () => () => void) => callback(),
      register: (entry: Registration) => {
        registrations.push(entry);
        return () => {};
      },
    },
  };
  // 与 Cordis 一致：未声明 inject 的可选服务只能经 ctx.get 读取，直接访问会抛错
  const ctx = new Proxy(base as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop === 'get') return (name: string) => extra[name];
      if (prop === 'modelDirectories' || prop === 'remote' || prop === 'remote.commands') {
        throw new Error(`cannot get property "${prop}" without inject`);
      }
      return Reflect.get(target, prop);
    },
  });
  apply(ctx as unknown as Context);
  return { registrations, openSession, listeners };
}

describe('client apply', () => {
  it('依赖宿主 uiWorkspace', () => {
    expect(inject).toContain('uiWorkspace');
  });

  it('om-compaction 槽注入的 openSession 转发到 uiWorkspace.openSession', () => {
    const { registrations, openSession } = setup();
    const entry = registrations.find((item) => item.key === 'om-compaction');
    const target = {
      parentSessionId: 'parent-1',
      childSessionId: 'diag-1',
      mode: 'one-shot',
    } as unknown as SubagentAddress;
    entry?.inject?.('s-1').openSession?.(target);
    expect(openSession).toHaveBeenCalledExactlyOnceWith(target);
  });

  it('宿主无模型目录服务时不注入重压缩能力', () => {
    const { registrations } = setup();
    const entry = registrations.find((item) => item.key === 'om-compaction');
    expect(entry?.inject?.('s-1').recompress).toBeUndefined();
  });

  it('有模型目录服务时注入：共用会话目录，提交走 command.execute', async () => {
    const store = { subscribe: () => () => {}, getSnapshot: () => ({}) };
    const load = vi.fn().mockResolvedValue(undefined);
    const directoryFor = vi.fn().mockReturnValue({ store, load });
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      value: { result: { kind: 'success', text: 'ok' } },
    });
    const { registrations } = setup({
      modelDirectories: { directoryFor },
      'remote.commands': { execute },
    });
    const entry = registrations.find((item) => item.key === 'om-compaction');
    const recompress = entry?.inject?.('s-1').recompress;
    expect(directoryFor).toHaveBeenCalledWith('s-1');
    expect(recompress?.directory).toBe(store);
    recompress?.load();
    expect(load).toHaveBeenCalledOnce();
    await expect(
      recompress?.run('om:1', { provider: 'alt', model: 'big-1', reasoningEffort: 'high' }),
    ).resolves.toEqual({ ok: true, text: 'ok' });
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      's-1',
      '/om-recompress om:1 alt big-1 high',
      [],
    );
  });

  it('监听 command/executed：本命令成功时跳转到新会话', () => {
    const { openSession, listeners } = setup();
    const listener = listeners.find((item) => item.type === 'command/executed')?.fn;
    expect(listener).toBeTypeOf('function');
    listener?.('s-1', 'om-compaction-eval', {
      kind: 'success',
      text: '已启动 OM 结果分析会话 session-new',
    });
    expect(openSession).toHaveBeenCalledExactlyOnceWith('session-new');
  });

  it('其他命令、失败结果与无法反解的文本都不跳转', () => {
    const { openSession, listeners } = setup();
    const listener = listeners.find((item) => item.type === 'command/executed')?.fn;
    const started = { kind: 'success', text: '已启动 OM 结果分析会话 session-new' } as const;
    listener?.('s-1', 'om-recompress', started);
    listener?.('s-1', 'om-compaction-eval', { kind: 'error', text: '仅支持主会话' });
    listener?.('s-1', 'om-compaction-eval', { kind: 'success', text: '重压缩完成' });
    listener?.('s-1', 'om-compaction-eval', { kind: 'success' });
    expect(openSession).not.toHaveBeenCalled();
  });
});
