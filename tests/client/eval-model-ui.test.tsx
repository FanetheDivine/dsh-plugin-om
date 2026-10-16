// @vitest-environment jsdom
/**
 * /om-compaction-eval 两栏模型面板：选模型后右栏默认落 max（无 max 则模型默认），
 * 点「开始分析」才提交，失败原因留在面板，成功关闭并跳转；注册后 action 弹出面板。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerEvalModelPanel } from '../../src/client/eval-model-register.tsx';
import type { NS } from '../../src/client/locales.ts';
import { zh } from '../../src/client/locales.ts';
import type { EvalDirectoryState } from '../../src/client/OmEvalModelPanel.tsx';
import { OmEvalModelPanel } from '../../src/client/OmEvalModelPanel.tsx';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const t: TranslateNS<typeof NS> = ((key: string, values?: Record<string, unknown>) => {
  let template = (zh as Record<string, string>)[key] ?? key;
  for (const [k, v] of Object.entries(values ?? {}))
    template = template.replaceAll(`{${k}}`, String(v));
  return template;
}) as TranslateNS<typeof NS>;

const state: EvalDirectoryState = {
  status: 'ready',
  error: null,
  failures: [],
  groups: [
    {
      id: 'alt',
      name: 'Alt',
      models: [
        {
          id: 'big',
          name: 'Big',
          reasoning: {
            efforts: [
              { id: 'low', name: 'Low' },
              { id: 'max', name: 'Max' },
            ],
          },
        },
        {
          id: 'mid',
          name: 'Mid',
          reasoning: { efforts: [{ id: 'high', name: 'High' }] },
        },
        { id: 'plain', name: 'Plain' },
      ],
    },
  ],
};

const directory = { subscribe: () => () => {}, getSnapshot: () => state };

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = '';
  root = undefined;
  container = undefined;
});

function mount(node: ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

const click = (selector: string) => {
  const el = document.querySelector<HTMLElement>(selector);
  if (el === null) throw new Error(`缺少元素 ${selector}`);
  act(() => el.click());
};
const checked = (selector: string) =>
  document.querySelector(selector)?.getAttribute('aria-checked');
const flush = () => act(async () => {});

function panel(onSubmit: () => Promise<void> | void, onClose = vi.fn(), load = vi.fn()) {
  mount(
    <OmEvalModelPanel
      directory={directory}
      load={load}
      t={t}
      onSubmit={async (choice) => {
        await (onSubmit as (c: unknown) => Promise<void> | void)(choice);
      }}
      onClose={onClose}
    />,
  );
  return { onClose, load };
}

describe('OmEvalModelPanel', () => {
  it('打开时加载目录；未选模型时开始按钮禁用', () => {
    const { load } = panel(vi.fn());
    expect(load).toHaveBeenCalledOnce();
    expect(document.querySelector<HTMLButtonElement>('[data-om-eval-start]')?.disabled).toBe(true);
    expect(document.body.textContent).toContain(zh['eval.pickModel']);
  });

  it('选支持 max 的模型：右栏默认 max，选中后不提交', () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    panel(onSubmit);
    click('[data-om-eval-model="alt/big"]');
    expect(checked('[data-om-eval-effort="max"]')).toBe('true');
    expect(checked('[data-om-eval-effort=""]')).toBe('false');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('模型没有 max：默认落在模型默认', () => {
    panel(vi.fn());
    click('[data-om-eval-model="alt/mid"]');
    expect(checked('[data-om-eval-effort=""]')).toBe('true');
    expect(checked('[data-om-eval-effort="high"]')).toBe('false');
  });

  it('模型没有思考等级：右栏提示，提交不带等级', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const { onClose } = panel(onSubmit);
    click('[data-om-eval-model="alt/plain"]');
    expect(document.body.textContent).toContain(zh['eval.noEffort']);
    click('[data-om-eval-start]');
    await flush();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ provider: 'alt', model: 'plain' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('可改选其他等级，再点开始提交该等级', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    panel(onSubmit);
    click('[data-om-eval-model="alt/big"]');
    click('[data-om-eval-effort="low"]');
    click('[data-om-eval-start]');
    await flush();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      provider: 'alt',
      model: 'big',
      reasoningEffort: 'low',
    });
  });

  it('换模型会重置为新模型的默认等级', () => {
    panel(vi.fn());
    click('[data-om-eval-model="alt/big"]');
    click('[data-om-eval-effort="low"]');
    click('[data-om-eval-model="alt/mid"]');
    expect(checked('[data-om-eval-effort=""]')).toBe('true');
    click('[data-om-eval-model="alt/big"]');
    expect(checked('[data-om-eval-effort="max"]')).toBe('true');
  });

  it('提交失败：原因显示在面板内，面板保持打开', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('仅支持主会话'));
    const { onClose } = panel(onSubmit);
    click('[data-om-eval-model="alt/big"]');
    click('[data-om-eval-start]');
    await flush();
    expect(document.querySelector('[data-om-eval-error]')?.textContent).toBe('仅支持主会话');
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLButtonElement>('[data-om-eval-start]')?.disabled).toBe(false);
  });

  it('按 Esc 关闭且不提交', () => {
    const onSubmit = vi.fn();
    const { onClose } = panel(onSubmit);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('registerEvalModelPanel', () => {
  /** 最小宿主桩：收集装饰、命令执行与会话跳转。 */
  function host(result: unknown) {
    const decorations: { ui: { run: (session: { sessionId: string }) => void } }[] = [];
    const dispose = vi.fn();
    const execute = vi.fn().mockResolvedValue(result);
    const openSession = vi.fn();
    const load = vi.fn().mockResolvedValue(state);
    const directoryFor = vi.fn().mockReturnValue({ store: directory, load });
    const scope = {
      effect: (factory: () => () => void) => factory(),
      commandUi: {
        decorate: (decoration: (typeof decorations)[number]) => {
          decorations.push(decoration);
          return dispose;
        },
      },
      modelDirectories: { directoryFor },
    };
    const ctx = {
      locale: { bind: () => t },
      inject: (_names: string[], callback: (s: typeof scope) => void) => callback(scope),
      get: (name: string) => (name === 'remote.commands' ? { execute } : undefined),
      uiWorkspace: { openSession },
    };
    registerEvalModelPanel(ctx as unknown as Context);
    const run = decorations[0]?.ui.run;
    if (run === undefined) throw new Error('缺少装饰');
    return { run, execute, openSession, directoryFor, dispose };
  }

  it('action 弹出面板；选模型点开始后带默认 max 提交并跳转，面板关闭', async () => {
    const { run, execute, openSession, directoryFor } = host({
      ok: true,
      value: { result: { kind: 'success', text: '已启动 OM 结果分析会话 session-new' } },
    });
    act(() => run({ sessionId: 's-1' }));
    expect(directoryFor).toHaveBeenCalledWith('s-1');
    expect(document.querySelector('[data-om-eval-start]')).not.toBeNull();
    click('[data-om-eval-model="alt/big"]');
    click('[data-om-eval-start]');
    await flush();
    expect(execute).toHaveBeenCalledExactlyOnceWith('s-1', '/om-compaction-eval alt/big max', []);
    expect(openSession).toHaveBeenCalledExactlyOnceWith('session-new');
    expect(document.querySelector('[data-om-eval-start]')).toBeNull();
  });

  it('重复触发只保留一个面板', () => {
    const { run } = host({ ok: true, value: { result: { kind: 'success' } } });
    act(() => run({ sessionId: 's-1' }));
    act(() => run({ sessionId: 's-1' }));
    expect(document.querySelectorAll('[data-om-eval-start]')).toHaveLength(1);
  });

  it('命令失败：原因留在面板且不跳转', async () => {
    const { run, openSession } = host({
      ok: true,
      value: { result: { kind: 'error', text: '仅支持主会话' } },
    });
    act(() => run({ sessionId: 's-1' }));
    click('[data-om-eval-model="alt/plain"]');
    click('[data-om-eval-start]');
    await flush();
    expect(document.querySelector('[data-om-eval-error]')?.textContent).toBe('仅支持主会话');
    expect(openSession).not.toHaveBeenCalled();
  });
});
