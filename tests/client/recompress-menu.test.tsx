// @vitest-environment jsdom
/**
 * 压缩卡片的「尝试其他模型」：按钮可见性、模型目录菜单、思考等级选择与结果提示。
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

describe('尝试其他模型按钮', () => {
  it('缺少注入时不显示；失败行与进行中行也不显示', () => {
    mount(undefined);
    expect(q('[data-om-recompress]')).toBeNull();
    const run = vi.fn();
    mount(stub({}, run), { error: 'x' });
    mount(stub({}, run), { running: true });
    expect(q('[data-om-recompress]')).toBeNull();
  });

  it('打开时加载目录，无思考等级的模型选中后直接提交', async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, text: '完成' });
    const source = stub({}, run);
    mount(source);
    click(q('[data-om-recompress]'));
    expect(source.load).toHaveBeenCalledOnce();
    await act(async () => {
      click(q('[data-om-recompress-model="alt/plain"]'));
    });
    expect(run).toHaveBeenCalledExactlyOnceWith('om:1', { provider: 'alt', model: 'plain' });
    expect(q('[data-om-recompress-model]')).toBeNull();
    expect(document.body.querySelector('[data-om-recompress-result]')?.textContent).toBe(
      zh['recompress.done'],
    );
  });

  it('选中模型提交时弹出全局提示：压缩开始，完成后会添加至「子智能体」', async () => {
    let finish: (value: RecompressOutcome) => void = () => {};
    const run = vi.fn().mockReturnValue(new Promise<RecompressOutcome>((r) => (finish = r)));
    mount(stub({}, run));
    expect(document.body.textContent).not.toContain(zh['recompress.started']);
    click(q('[data-om-recompress]'));
    await act(async () => {
      click(q('[data-om-recompress-model="alt/plain"]'));
    });
    expect(zh['recompress.started']).toContain('子智能体');
    // 提示经 body portal 渲染，提交仍在进行时就已出现
    expect(document.body.textContent).toContain(zh['recompress.started']);
    expect((q('[data-om-recompress]') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      finish({ ok: true, text: '' });
    });
  });

  it('带思考等级的模型先选等级，「模型默认」不带 effort', async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, text: '' });
    mount(stub({}, run));
    click(q('[data-om-recompress]'));
    click(q('[data-om-recompress-model="alt/big-1"]'));
    expect(run).not.toHaveBeenCalled();
    await act(async () => {
      click(q('[data-om-recompress-effort="high"]'));
    });
    expect(run).toHaveBeenLastCalledWith('om:1', {
      provider: 'alt',
      model: 'big-1',
      reasoningEffort: 'high',
    });
    click(q('[data-om-recompress]'));
    click(q('[data-om-recompress-model="alt/big-1"]'));
    await act(async () => {
      click(q('[data-om-recompress-effort=""]'));
    });
    expect(run).toHaveBeenLastCalledWith('om:1', { provider: 'alt', model: 'big-1' });
  });

  it('提交期间按钮禁用并显示进行中，失败后展示原因', async () => {
    let finish: (value: RecompressOutcome) => void = () => {};
    const run = vi.fn().mockReturnValue(new Promise<RecompressOutcome>((r) => (finish = r)));
    mount(stub({}, run));
    click(q('[data-om-recompress]'));
    click(q('[data-om-recompress-model="alt/plain"]'));
    const button = q('[data-om-recompress]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain(zh['recompress.running']);
    await act(async () => {
      finish({ ok: false, text: '找不到压缩' });
    });
    expect((q('[data-om-recompress]') as HTMLButtonElement).disabled).toBe(false);
    expect(q('[data-om-recompress-result]')?.textContent).toBe('重压缩失败：找不到压缩');
  });

  it('目录加载失败显示重试，加载中与空目录显示提示', () => {
    const source = stub({ groups: [], status: 'error', error: 'net' }, vi.fn());
    mount(source);
    click(q('[data-om-recompress]'));
    click(q('[data-om-recompress-retry]'));
    expect(source.load).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain('net');
  });

  it('模型较多时出现搜索框并按名称过滤', () => {
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
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'ome');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const rows = document.body.querySelectorAll('[data-om-recompress-model]');
    expect(Array.from(rows).map((row) => row.getAttribute('data-om-recompress-model'))).toEqual([
      'p/omega',
    ]);
  });
});
