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

/** 各行的配置命名空间，即 patch 行 id。 */
const ROW_NS = {
  root: 'dsh-plugin-om',
  recompress: 'dsh-plugin-om-recompress',
  eval: 'dsh-plugin-om-compaction-eval',
} as const;

/** 构造只实现入口实际读取服务的宿主桩，并收集所有槽注册。 */
function setup(extra: Record<string, unknown> = {}, served?: string[]) {
  const servedSet = new Set(served ?? Object.values(ROW_NS));
  const registrations: Registration[] = [];
  const listeners: Listener[] = [];
  const openSession = vi.fn();
  const base = {
    effect: (factory: () => (() => void) | undefined) => factory(),
    on: (type: string, fn: ExecutedListener) => {
      listeners.push({ type, fn });
      return () => {};
    },
    locale: {
      register: () => () => {},
      bind: () => (key: string, params?: Record<string, string>) =>
        params === undefined ? key : `${key}:${JSON.stringify(params)}`,
    },
    // 与 Cordis 一致：依赖服务都就绪时才执行回调，scope 提供这些服务
    inject: (names: string[], callback: (scope: Record<string, unknown>) => void) => {
      if (names.every((name) => extra[name] !== undefined)) {
        callback({ ...base, ...extra, get: (name: string) => extra[name] });
      }
    },
    uiConversation: { events: { register: () => () => {} } },
    uiWorkspace: { openSession },
    configForms: {
      get: () => ({
        subscribe: () => () => {},
        getSnapshot: () => ({ status: 'unavailable' }),
      }),
      whileServed: (names: string[], fn: () => () => void) =>
        names.some((name) => servedSet.has(name)) ? fn() : () => {},
      describe: () => ({
        getSnapshot: () => ({
          status: 'ready',
          view: {
            namespaces: [...servedSet].map((ns) => ({ ns })),
            writable: true,
            hasDocument: true,
          },
          error: null,
        }),
        subscribe: () => () => {},
        ensure: async () => {},
      }),
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
      if (prop === 'commandUi' || prop === 'modelDirectories') {
        throw new Error(`cannot get property "${prop}" without inject`);
      }
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

  it('重压缩组件行未启用时不注入重压缩能力', () => {
    const directoryFor = vi.fn().mockReturnValue({
      store: { subscribe: () => () => {}, getSnapshot: () => ({}) },
      load: vi.fn(),
    });
    const { registrations } = setup({ modelDirectories: { directoryFor } }, [
      ROW_NS.root,
      ROW_NS.eval,
    ]);
    const entry = registrations.find((item) => item.key === 'om-compaction');
    expect(entry?.inject?.('s-1').recompress).toBeUndefined();
  });

  it('为包根和两个组件行分别注册配置页，键为包名#行 id', () => {
    const { registrations } = setup();
    expect(
      registrations.filter((item) => item.name === 'plugins.row.config').map((item) => item.key),
    ).toEqual([
      'dsh-plugin-om#dsh-plugin-om',
      'dsh-plugin-om#dsh-plugin-om-recompress',
      'dsh-plugin-om#dsh-plugin-om-compaction-eval',
    ]);
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

  describe('/om-compaction-eval 模型面板', () => {
    interface Decoration {
      name: string;
      available: (session: { sessionId: string }) => boolean;
      ui: { kind: string; run?: (session: { sessionId: string }) => void };
    }

    /** 构造带 commandUi 与模型目录的宿主，返回收集到的装饰。 */
    function panel(served?: string[]) {
      const decorations: Decoration[] = [];
      const host = setup(
        {
          commandUi: {
            decorate: (decoration: Decoration) => {
              decorations.push(decoration);
              return () => {};
            },
          },
          modelDirectories: { directoryFor: vi.fn() },
          'remote.commands': { execute: vi.fn() },
        },
        served,
      );
      return { decorations, ...host };
    }

    it('commandUi 与模型目录就绪时给评估命令挂 action 装饰', () => {
      const { decorations } = panel();
      expect(decorations).toHaveLength(1);
      expect(decorations[0]?.name).toBe('om-compaction-eval');
      expect(decorations[0]?.ui.kind).toBe('action');
      expect(decorations[0]?.available({ sessionId: 's-1' })).toBe(true);
    });

    it('评估组件行未启用时装饰不可用，启用后恢复', () => {
      const { decorations } = panel([ROW_NS.root, ROW_NS.recompress]);
      expect(decorations[0]?.available({ sessionId: 's-1' })).toBe(false);
      const enabled = panel();
      expect(enabled.decorations[0]?.available({ sessionId: 's-1' })).toBe(true);
    });

    it('缺少 commandUi 或模型目录时不挂面板也不抛错', () => {
      expect(() => setup()).not.toThrow();
      expect(() => setup({ commandUi: { decorate: vi.fn() } })).not.toThrow();
      const decorate = vi.fn();
      setup({ commandUi: { decorate } });
      expect(decorate).not.toHaveBeenCalled();
    });
  });
});
