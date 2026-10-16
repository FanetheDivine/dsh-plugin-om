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
    interface PanelUi {
      kind: string;
      searchMode?: string;
      options: (session: { sessionId: string }, signal: AbortSignal) => Promise<unknown[]>;
      onSelect: (option: { id: string }, session: { sessionId: string }) => Promise<void>;
    }
    interface Decoration {
      name: string;
      available: (session: { sessionId: string }) => boolean;
      ui: PanelUi;
    }

    /** 构造带 commandUi 与模型目录的宿主，返回收集到的装饰。 */
    function panel(commandResult: unknown) {
      const decorations: Decoration[] = [];
      const state = {
        groups: [{ id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5', name: 'GPT-5' }] }],
        failures: [],
      };
      const load = vi.fn().mockResolvedValue(state);
      const directoryFor = vi.fn().mockReturnValue({
        load,
        store: { subscribe: () => () => {}, getSnapshot: () => state },
      });
      const execute = vi.fn().mockResolvedValue(commandResult);
      const host = setup({
        commandUi: {
          decorate: (decoration: Decoration) => {
            decorations.push(decoration);
            return () => {};
          },
        },
        modelDirectories: { directoryFor },
        'remote.commands': { execute },
      });
      return { decorations, directoryFor, load, execute, ...host };
    }

    /** 取唯一一条装饰，缺失即失败。 */
    function only(decorations: Decoration[]): Decoration {
      const [first] = decorations;
      if (first === undefined) throw new Error('缺少装饰注册');
      return first;
    }

    it('commandUi 与模型目录就绪时给评估命令挂面板', () => {
      const { decorations } = panel({ ok: true, value: { result: { kind: 'success' } } });
      expect(decorations).toHaveLength(1);
      expect(only(decorations).name).toBe('om-compaction-eval');
      expect(only(decorations).ui.kind).toBe('popupSelect');
      expect(only(decorations).ui.searchMode).toBe('fuzzy-label');
    });

    it('缺少 commandUi 或模型目录时不挂面板也不抛错', () => {
      expect(() => setup()).not.toThrow();
      expect(() => setup({ commandUi: { decorate: vi.fn() } })).not.toThrow();
      const decorate = vi.fn();
      setup({ commandUi: { decorate } });
      expect(decorate).not.toHaveBeenCalled();
    });

    it('面板选项来自当前会话的模型目录', async () => {
      const { decorations, directoryFor } = panel({
        ok: true,
        value: { result: { kind: 'success' } },
      });
      const options = await only(decorations).ui.options(
        { sessionId: 's-1' },
        new AbortController().signal,
      );
      expect(directoryFor).toHaveBeenCalledWith('s-1');
      expect(options).toMatchObject([{ label: 'GPT-5', group: { label: 'OpenAI' } }]);
    });

    it('选中模型：提交不带等级的命令行并跳转到新会话', async () => {
      const { decorations, execute, openSession } = panel({
        ok: true,
        value: { result: { kind: 'success', text: '已启动 OM 结果分析会话 session-new' } },
      });
      const options = (await only(decorations).ui.options(
        { sessionId: 's-1' },
        new AbortController().signal,
      )) as { id: string }[];
      await only(decorations).ui.onSelect(options[0] ?? { id: '' }, { sessionId: 's-1' });
      expect(execute).toHaveBeenCalledExactlyOnceWith(
        's-1',
        '/om-compaction-eval openai/gpt-5',
        [],
      );
      expect(openSession).toHaveBeenCalledExactlyOnceWith('session-new');
    });

    it('命令失败时把原因抛给面板且不跳转', async () => {
      const { decorations, openSession } = panel({
        ok: true,
        value: { result: { kind: 'error', text: '仅支持主会话' } },
      });
      await expect(
        only(decorations).ui.onSelect({ id: 'openai/gpt-5' }, { sessionId: 's-1' }),
      ).rejects.toThrow('仅支持主会话');
      expect(openSession).not.toHaveBeenCalled();
    });

    it('选中已不在目录的选项时抛错且不执行命令', async () => {
      const { decorations, execute } = panel({ ok: true, value: { result: { kind: 'success' } } });
      await expect(
        only(decorations).ui.onSelect({ id: 'openai/removed' }, { sessionId: 's-1' }),
      ).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
    });
  });
});
