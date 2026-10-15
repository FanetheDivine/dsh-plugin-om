// 客户端入口注册测试：压缩卡片槽注入宿主 openSession，并转发到 uiWorkspace。

import type { Context } from '@deepseek-ai/cordis';
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

/** 构造只实现入口实际读取服务的宿主桩，并收集所有槽注册。 */
function setup(extra: Record<string, unknown> = {}) {
  const registrations: Registration[] = [];
  const openSession = vi.fn();
  const base = {
    effect: (factory: () => (() => void) | undefined) => factory(),
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
  return { registrations, openSession };
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
});
