// @vitest-environment jsdom
/**
 * 压缩卡片的「尝试其他模型」：按钮可见性、模型目录菜单多选、思考等级勾选、
 * 开始按钮批量提交与结果提示。
 */

import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client';
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { NS } from '../../src/client/locales.ts';
import { zh } from '../../src/client/locales.ts';
import { OmCompactionCard } from '../../src/client/OmCompactionCard.tsx';
import type {
  DirectoryGroup,
  DirectoryState,
  RecompressChoice,
  RecompressInjected,
  RecompressOutcome,
} from '../../src/client/recompress-run.ts';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const t: TranslateNS<typeof NS> = ((key: string, values?: Record<string, unknown>) => {
  let template = (zh as Record<string, string>)[key] ?? key;
  for (const [k, v] of Object.entries(values ?? {}))
    template = template.replaceAll(`{${k}}`, String(v));
  return template;
}) as TranslateNS<typeof NS>;

const groups: DirectoryGroup[] = [
  {
    id: 'alt',
    name: 'Alt',
    models: [
      { id: 'plain', name: 'Plain' },
      {
        id: 'big-1',
        name: 'Big One',
        reasoning: {
          efforts: [
            { id: 'low', name: 'Low' },
            { id: 'high', name: 'High' },
          ],
        },
      },
      {
        id: 'big-2',
        name: 'Big Two',
        reasoning: {
          efforts: [
            { id: 'high', name: 'High' },
            { id: 'max', name: 'Max' },
          ],
        },
      },
    ],
  },
];

function stub(
  state: Partial<DirectoryState>,
  run: (id: string, choice: RecompressChoice) => Promise<RecompressOutcome>,
): RecompressInjected & { load: Mock<() => void> } {
  const snapshot: DirectoryState = { groups, status: 'ready', error: null, ...state };
  return {
    directory: { subscribe: () => () => {}, getSnapshot: () => snapshot },
    load: vi.fn<() => void>(),
    run,
  };
}

const node = (
  data: Partial<ChatNode<'om-compaction'>['data']> = {},
): ChatNode<'om-compaction'> => ({
  key: 'om-compaction:1',
  id: 'om-compaction:1',
  kind: 'om-compaction',
  target: 'chat',
  anchorSeq: 1,
  location: { kind: 'unresolved' },
  visibility: 'visible',
  data: {
    compactionId: 'om:1',
    running: false,
    phase: null,
    error: null,
    diagnosticSessionId: null,
    summaryEventSeq: 1,
    shadowedItemCount: 10,
    shadowedCharCount: 1000,
    shadowedTokenCount: 200,
    summaryCharCount: 200,
    summaryTokenCount: 50,
    provider: 'p',
    model: 'm',
    reasoningEffort: null,
    durationMs: 63100,
    summary: '摘要',
    ...data,
  },
});

const mounted: Array<() => void> = [];
afterEach(() => {
  for (const dispose of mounted.splice(0)) dispose();
  document.body.innerHTML = '';
});

function mount(recompress: RecompressInjected | undefined, data = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <OmCompactionCard
        node={node(data)}
        t={t}
        sessionId={'s-1' as SessionId}
        {...(recompress === undefined ? {} : { recompress })}
      />,
    );
  });
  act(() => {
    container
      .querySelector('[data-disclosure-row]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

const click = (el: Element | null) =>
  act(() => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
const q = (selector: string) => document.body.querySelector(selector);
const startButton = () => q('[data-om-recompress-start]') as HTMLButtonElement | null;
const startText = () => startButton()?.textContent ?? '';
/** run 收到的组合列表（按提交顺序）。 */
const runChoices = (run: Mock) => run.mock.calls.map((call) => call[1]);

describe('尝试其他模型按钮', () => {
  it('缺少注入时不显示；失败行与进行中行也不显示', () => {
    mount(undefined);
    expect(q('[data-om-recompress]')).toBeNull();
    const run = vi.fn();
    mount(stub({}, run), { error: 'x' });
    mount(stub({}, run), { running: true });
    expect(q('[data-om-recompress]')).toBeNull();
  });

  it('未选模型时开始按钮禁用且计数为 0', () => {
    mount(stub({}, vi.fn()));
    click(q('[data-om-recompress]'));
    expect(startButton()?.disabled).toBe(true);
    expect(startText()).toBe('开始(0)');
  });

  it('打开时加载目录，勾选无等级模型后点开始提交并关闭浮层', async () => {
    const run = vi.fn().mockResolvedValue({
      ok: true,
      text: '重压缩完成 字符 3.1k → 5.2k，26.1s，alt/plain(默认)',
    });
    const source = stub({}, run);
    mount(source);
    click(q('[data-om-recompress]'));
    expect(source.load).toHaveBeenCalledOnce();
    const row = q('[data-om-recompress-model="alt/plain"]');
    expect(row?.getAttribute('aria-checked')).toBe('false');
    click(row);
    expect(row?.getAttribute('aria-checked')).toBe('true');
    expect(startText()).toBe('开始(1)');
    await act(async () => {
      click(startButton());
    });
    expect(run).toHaveBeenCalledExactlyOnceWith('om:1', { provider: 'alt', model: 'plain' });
    expect(q('[data-om-recompress-model]')).toBeNull();
    // 卡片结果行直接显示命令返回的对比文本
    expect(document.body.querySelector('[data-om-recompress-result]')?.textContent).toBe(
      '重压缩完成 字符 3.1k → 5.2k，26.1s，alt/plain(默认)',
    );
  });

  it('带等级模型默认勾「模型默认」，再勾等级后按顺序展开组合', async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, text: '' });
    mount(stub({}, run));
    click(q('[data-om-recompress]'));
    click(q('[data-om-recompress-model="alt/big-1"]'));
    // 勾选区出现并集：模型默认已勾选，Low/High 未勾选
    expect(q('[data-om-recompress-effort=""]')?.getAttribute('aria-checked')).toBe('true');
    expect(q('[data-om-recompress-effort="low"]')?.getAttribute('aria-checked')).toBe('false');
    expect(startText()).toBe('开始(1)');
    click(q('[data-om-recompress-effort="high"]'));
    expect(startText()).toBe('开始(2)');
    await act(async () => {
      click(startButton());
    });
    expect(runChoices(run)).toEqual([
      { provider: 'alt', model: 'big-1' },
      { provider: 'alt', model: 'big-1', reasoningEffort: 'high' },
    ]);
  });

  it('全局等级为并集，模型不支持的勾选被跳过', async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, text: '' });
    mount(stub({}, run));
    click(q('[data-om-recompress]'));
    click(q('[data-om-recompress-model="alt/big-1"]'));
    click(q('[data-om-recompress-model="alt/big-2"]'));
    // 并集：low、high、max
    expect(
      Array.from(document.body.querySelectorAll('[data-om-recompress-effort]')).map((el) =>
        el.getAttribute('data-om-recompress-effort'),
      ),
    ).toEqual(['', 'low', 'high', 'max']);
    click(q('[data-om-recompress-effort=""]')); // 取消「模型默认」
    click(q('[data-om-recompress-effort="low"]'));
    click(q('[data-om-recompress-effort="max"]'));
    expect(startText()).toBe('开始(2)');
    await act(async () => {
      click(startButton());
    });
    expect(runChoices(run)).toEqual([
      { provider: 'alt', model: 'big-1', reasoningEffort: 'low' },
      { provider: 'alt', model: 'big-2', reasoningEffort: 'max' },
    ]);
  });

  it('无等级模型不受等级勾选影响，固定只生成一个组合', async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, text: '' });
    mount(stub({}, run));
    click(q('[data-om-recompress]'));
    click(q('[data-om-recompress-model="alt/plain"]'));
    expect(q('[data-om-recompress-effort]')).toBeNull();
    expect(startText()).toBe('开始(1)');
    await act(async () => {
      click(startButton());
    });
    expect(runChoices(run)).toEqual([{ provider: 'alt', model: 'plain' }]);
  });

  it('再次点击已勾选模型取消勾选，计数回落', async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, text: '' });
    mount(stub({}, run));
    click(q('[data-om-recompress]'));
    click(q('[data-om-recompress-model="alt/plain"]'));
    expect(startText()).toBe('开始(1)');
    click(q('[data-om-recompress-model="alt/plain"]'));
    expect(startText()).toBe('开始(0)');
    expect(startButton()?.disabled).toBe(true);
  });

  it('Esc 或点击浮层外关闭不提交，重开后选择已清空', async () => {
    const run = vi.fn();
    mount(stub({}, run));
    click(q('[data-om-recompress]'));
    click(q('[data-om-recompress-model="alt/plain"]'));
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(q('[data-om-recompress-model]')).toBeNull();
    expect(run).not.toHaveBeenCalled();
    click(q('[data-om-recompress]'));
    expect(startText()).toBe('开始(0)');
    click(q('[data-om-recompress-model="alt/plain"]'));
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(q('[data-om-recompress-model]')).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('点开始时弹出全局提示：压缩开始，完成后会添加至「子智能体」', async () => {
    let finish: (value: RecompressOutcome) => void = () => {};
    const run = vi.fn().mockReturnValue(new Promise<RecompressOutcome>((r) => (finish = r)));
    mount(stub({}, run));
    expect(document.body.textContent).not.toContain(zh['recompress.started']);
    click(q('[data-om-recompress]'));
    click(q('[data-om-recompress-model="alt/plain"]'));
    await act(async () => {
      click(startButton());
    });
    expect(zh['recompress.started']).toContain('子智能体');
    // 提示经 body portal 渲染，提交仍在进行时就已出现
    expect(document.body.textContent).toContain(zh['recompress.started']);
    expect((q('[data-om-recompress]') as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      finish({ ok: true, text: '' });
    });
  });

  it('提交期间按钮保持可用，进行中行显示模型名，失败后替换为原因', async () => {
    let finish: (value: RecompressOutcome) => void = () => {};
    const run = vi.fn().mockReturnValue(new Promise<RecompressOutcome>((r) => (finish = r)));
    mount(stub({}, run));
    click(q('[data-om-recompress]'));
    click(q('[data-om-recompress-model="alt/plain"]'));
    await act(async () => {
      click(startButton());
    });
    const button = q('[data-om-recompress]') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe(zh['recompress.action']);
    const running = document.body.querySelectorAll('[data-om-recompress-running]');
    expect(running).toHaveLength(1);
    expect(running[0]?.textContent).toBe('重压缩中：alt/plain(默认)…');
    await act(async () => {
      finish({ ok: false, text: '找不到压缩' });
    });
    expect(q('[data-om-recompress-running]')).toBeNull();
    expect(q('[data-om-recompress-result]')?.textContent).toBe('重压缩失败：找不到压缩');
  });

  it('进行中可再次提交并行重压缩，各自显示模型名与思考等级，结束一个不影响另一个', async () => {
    const finishers: Array<(value: RecompressOutcome) => void> = [];
    const run = vi
      .fn()
      .mockImplementation(
        () => new Promise<RecompressOutcome>((resolve) => finishers.push(resolve)),
      );
    mount(stub({}, run));
    click(q('[data-om-recompress]'));
    click(q('[data-om-recompress-model="alt/plain"]'));
    await act(async () => {
      click(startButton());
    });
    click(q('[data-om-recompress]'));
    click(q('[data-om-recompress-model="alt/big-1"]'));
    click(q('[data-om-recompress-effort=""]')); // 取消默认
    click(q('[data-om-recompress-effort="high"]'));
    await act(async () => {
      click(startButton());
    });
    expect(run).toHaveBeenCalledTimes(2);
    const labels = () =>
      Array.from(document.body.querySelectorAll('[data-om-recompress-running]')).map(
        (row) => row.textContent,
      );
    expect(labels()).toEqual(['重压缩中：alt/plain(默认)…', '重压缩中：alt/big-1(high)…']);
    await act(async () => {
      finishers[0]?.({ ok: true, text: '完成 A' });
    });
    expect(labels()).toEqual(['重压缩中：alt/big-1(high)…']);
    expect(q('[data-om-recompress-result]')?.textContent).toBe('完成 A');
    // 新一轮提交清掉已结束的旧结果
    click(q('[data-om-recompress]'));
    click(q('[data-om-recompress-model="alt/plain"]'));
    await act(async () => {
      click(startButton());
    });
    expect(q('[data-om-recompress-result]')).toBeNull();
    expect(labels()).toHaveLength(2);
    await act(async () => {
      for (const finish of finishers) finish({ ok: true, text: '' });
    });
  });

  it('目录加载失败显示重试，加载中与空目录显示提示', () => {
    const source = stub({ groups: [], status: 'error', error: 'net' }, vi.fn());
    mount(source);
    click(q('[data-om-recompress]'));
    click(q('[data-om-recompress-retry]'));
    expect(source.load).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain('net');
  });

  it('模型较多时出现搜索框并按名称过滤，勾选在过滤后保留', () => {
    const many: DirectoryGroup[] = [
      {
        id: 'p',
        name: 'P',
        models: ['alpha', 'beta', 'gamma', 'delta', 'omega'].map((id) => ({ id, name: id })),
      },
    ];
    mount(stub({ groups: many }, vi.fn()));
    click(q('[data-om-recompress]'));
    const input = q('[data-om-recompress-search]') as HTMLInputElement;
    expect(input).not.toBeNull();
    const search = (text: string) =>
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    search('alp');
    click(q('[data-om-recompress-model="p/alpha"]'));
    search('ome');
    const rows = document.body.querySelectorAll('[data-om-recompress-model]');
    expect(Array.from(rows).map((row) => row.getAttribute('data-om-recompress-model'))).toEqual([
      'p/omega',
    ]);
    // alpha 不在过滤结果里，勾选仍然保留并计数
    expect(startText()).toBe('开始(1)');
    search('alp');
    expect(q('[data-om-recompress-model="p/alpha"]')?.getAttribute('aria-checked')).toBe('true');
  });
});
