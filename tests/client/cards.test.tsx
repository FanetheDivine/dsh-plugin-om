// @vitest-environment jsdom
/**
 * 消息卡片组件测试：验证折叠行横向滚动支持与展开体水平滚动适配。
 */

import type { ChatNode, ToolCallId } from '@deepseek-ai/dsh-client-ui-chat/client';
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { NS } from '../../src/client/locales.ts';
import { zh } from '../../src/client/locales.ts';
import { OmCompactionCard } from '../../src/client/OmCompactionCard.tsx';
import { OmWarningCard } from '../../src/client/OmWarningCard.tsx';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mockTranslate: TranslateNS<typeof NS> = ((key: string, values?: Record<string, unknown>) => {
  let template = (zh as Record<string, string>)[key] ?? key;
  if (values !== undefined) {
    for (const [k, v] of Object.entries(values)) {
      template = template.replaceAll(`{${k}}`, String(v));
    }
  }
  return template;
}) as TranslateNS<typeof NS>;

describe('消息列表卡片水平滚动适配', () => {
  it('压缩卡片展开体支持水平滚动与移动端滑动，且折叠行摘要允许左右滚动', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const node: ChatNode<'om-compaction'> = {
      key: 'om-compaction:1',
      id: 'om-compaction:1',
      kind: 'om-compaction',
      target: 'chat',
      anchorSeq: 1,
      location: { kind: 'unresolved' },
      visibility: 'visible',
      data: {
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
        summary: 'Very long summary with multiple code blocks and wide lines\nLine 2',
      },
    };

    act(() => {
      root.render(<OmCompactionCard node={node} t={mockTranslate} />);
    });

    const summaryEl = container.querySelector('[data-om-compaction-summary]');
    expect(summaryEl).not.toBeNull();
    // 折叠行摘要必须带有横向滚动支持（允许左右滚动）
    expect(summaryEl?.className).toContain('om-compaction-scrollable');

    // 展开卡片（点击可点击的 row 区域）
    const row = container.querySelector('[data-disclosure-row]');
    expect(row).not.toBeNull();
    act(() => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const bodyEl = container.querySelector('.om-compaction-body') as HTMLElement | null;
    expect(bodyEl).not.toBeNull();
    expect(bodyEl?.textContent).toContain('Very long summary');

    // 注入的样式表需声明 overflow-x: auto 与滚动容器支持
    const styleEl = document.querySelector('style[data-dsh-plugin-om-card]');
    expect(styleEl).not.toBeNull();
    const styleContent = styleEl?.textContent ?? '';
    expect(styleContent).toContain('overflow-x:auto');
    expect(styleContent).toContain('overflow-y:auto');
    expect(styleContent).toContain('-webkit-overflow-scrolling:touch');
    expect(styleContent).toContain('.om-compaction-scrollable');

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('降级警告卡片摘要与展开体支持横向滚动', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const node: ChatNode<'om-warning'> = {
      key: 'om-warning:1',
      id: 'om-warning:1',
      kind: 'om-warning',
      target: 'chat',
      anchorSeq: 1,
      location: { kind: 'unresolved' },
      visibility: 'visible',
      data: {
        problem: 'ModelDegraded',
        message: 'A very wide warning message that needs horizontal scrolling on mobile devices',
      },
    };

    act(() => {
      root.render(<OmWarningCard node={node} t={mockTranslate} />);
    });

    const summaryEl = container.querySelector('.om-compaction-summary');
    expect(summaryEl).not.toBeNull();
    expect(summaryEl?.className).toContain('om-compaction-scrollable');

    // 点击展开
    const row = container.querySelector('[data-disclosure-row]');
    expect(row).not.toBeNull();
    act(() => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const bodyEl = container.querySelector('.om-compaction-body') as HTMLElement | null;
    expect(bodyEl).not.toBeNull();
    expect(bodyEl?.textContent).toContain('A very wide warning message');

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  describe('展开体操作栏', () => {
    type CompactionData = ChatNode<'om-compaction'>['data'];

    const baseData: CompactionData = {
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
      summary: '摘要文本',
    };

    function nodeOf(data: Partial<CompactionData>): ChatNode<'om-compaction'> {
      return {
        key: 'om-compaction:1',
        id: 'om-compaction:1',
        kind: 'om-compaction',
        target: 'chat',
        anchorSeq: 1,
        location: { kind: 'unresolved' },
        visibility: 'visible',
        data: { ...baseData, ...data },
      };
    }

    function mount(
      data: Partial<CompactionData>,
      openSession?: (target: SubagentAddress) => void,
      inspectCall?: (callId: ToolCallId) => void,
    ): { container: HTMLElement; unmount: () => void } {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      act(() => {
        root.render(
          <OmCompactionCard
            node={nodeOf(data)}
            t={mockTranslate}
            sessionId={'parent-1' as SessionId}
            {...(openSession === undefined ? {} : { openSession })}
            {...(inspectCall === undefined ? {} : { inspectCall })}
          />,
        );
      });
      return {
        container,
        unmount: () => {
          act(() => {
            root.unmount();
          });
          container.remove();
        },
      };
    }

    function click(element: Element | null): void {
      act(() => {
        element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    }

    function expand(container: HTMLElement): void {
      click(container.querySelector('[data-disclosure-row]'));
    }

    it('折叠态不渲染操作栏，展开后「诊断日志」按钮位于展开体下方', () => {
      const view = mount({ diagnosticSessionId: 'diag-1' }, vi.fn());
      expect(view.container.querySelector('[data-om-compaction-inspect]')).toBeNull();
      expect(view.container.querySelector('[data-om-compaction-actions]')).toBeNull();
      expand(view.container);
      const body = view.container.querySelector('.om-compaction-body');
      const actions = view.container.querySelector('[data-om-compaction-actions]');
      expect(actions?.querySelector('[data-om-compaction-inspect]')).not.toBeNull();
      // 操作栏紧随展开体之后
      expect(body?.nextElementSibling).toBe(actions);
      view.unmount();
    });

    it('成功卡片点击「诊断日志」以 one-shot 地址跳转诊断子会话，且不折叠', () => {
      const openSession = vi.fn();
      const view = mount({ diagnosticSessionId: 'diag-1' }, openSession);
      expand(view.container);
      const button = view.container.querySelector('[data-om-compaction-inspect]');
      expect(button?.textContent).toContain('诊断日志');
      click(button);
      expect(openSession).toHaveBeenCalledExactlyOnceWith({
        parentSessionId: 'parent-1',
        childSessionId: 'diag-1',
        mode: 'one-shot',
      });
      expect(view.container.querySelector('.om-compaction-body')).not.toBeNull();
      view.unmount();
    });

    it('失败行展开后可「诊断日志」，按钮位于报错下方', () => {
      const openSession = vi.fn();
      const view = mount({ error: 'LLM 429', diagnosticSessionId: 'diag-fail' }, openSession);
      expect(view.container.querySelector('[data-om-compaction-inspect]')).toBeNull();
      expand(view.container);
      const body = view.container.querySelector('.om-compaction-body');
      expect(body?.nextElementSibling).toBe(
        view.container.querySelector('[data-om-compaction-actions]'),
      );
      click(view.container.querySelector('[data-om-compaction-inspect]'));
      expect(openSession).toHaveBeenCalledExactlyOnceWith({
        parentSessionId: 'parent-1',
        childSessionId: 'diag-fail',
        mode: 'one-shot',
      });
      expect(view.container.querySelector('.om-compaction-body')).not.toBeNull();
      view.unmount();
    });

    it('无 id、无 openSession 或进行中时不渲染「诊断日志」', () => {
      const openSession = vi.fn();
      for (const view of [
        mount({ diagnosticSessionId: null }, openSession),
        mount({ diagnosticSessionId: 'diag-1' }),
        mount({ running: true, phase: 'observe', diagnosticSessionId: 'diag-1' }, openSession),
      ]) {
        expand(view.container);
        expect(view.container.querySelector('[data-om-compaction-inspect]')).toBeNull();
        expect(view.container.querySelector('[data-om-compaction-actions]')).toBeNull();
        view.unmount();
      }
    });

    it('summary 不在加载窗口内时仍可展开并「诊断日志」', () => {
      const openSession = vi.fn();
      const view = mount({ diagnosticSessionId: 'diag-1', summary: null }, openSession);
      expand(view.container);
      expect(view.container.querySelector('.om-compaction-body')).toBeNull();
      click(view.container.querySelector('[data-om-compaction-inspect]'));
      expect(openSession).toHaveBeenCalledOnce();
      view.unmount();
    });

    it('传入 inspectCall 时展开体显示「轨迹」，点击以节点 key 调用且不折叠', () => {
      const inspectCall = vi.fn();
      const view = mount({}, undefined, inspectCall);
      expect(view.container.querySelector('[data-om-compaction-trajectory]')).toBeNull();
      expand(view.container);
      const button = view.container.querySelector('[data-om-compaction-trajectory]');
      expect(button?.textContent).toContain('轨迹');
      click(button);
      expect(inspectCall).toHaveBeenCalledExactlyOnceWith('om-compaction:1');
      expect(view.container.querySelector('.om-compaction-body')).not.toBeNull();
      view.unmount();
    });

    it('无 inspectCall 时不渲染「轨迹」；两个按钮并存时「轨迹」在前', () => {
      const none = mount({ diagnosticSessionId: 'diag-1' }, vi.fn());
      expand(none.container);
      expect(none.container.querySelector('[data-om-compaction-trajectory]')).toBeNull();
      none.unmount();

      const both = mount({ diagnosticSessionId: 'diag-1' }, vi.fn(), vi.fn());
      expand(both.container);
      const buttons = [
        ...both.container.querySelectorAll('[data-om-compaction-actions] button'),
      ].map((el) => el.getAttribute('data-om-compaction-trajectory') !== null);
      expect(buttons).toEqual([true, false]);
      both.unmount();
    });

    it('失败卡片同样提供「轨迹」；进行中不渲染操作栏', () => {
      const inspectCall = vi.fn();
      const failed = mount({ error: 'boom' }, undefined, inspectCall);
      expand(failed.container);
      click(failed.container.querySelector('[data-om-compaction-trajectory]'));
      expect(inspectCall).toHaveBeenCalledOnce();
      failed.unmount();

      const running = mount({ running: true, phase: 'observe' }, undefined, inspectCall);
      expand(running.container);
      expect(running.container.querySelector('[data-om-compaction-actions]')).toBeNull();
      running.unmount();
    });

    it('按钮样式对齐宿主 inspectButton 胶囊', () => {
      mount({ diagnosticSessionId: 'diag-1' }, vi.fn()).unmount();
      const css = document.querySelector('style[data-dsh-plugin-om-card]')?.textContent ?? '';
      expect(css).toContain('border-radius:999px');
      expect(css).toContain('border:.5px solid var(--dsw-alias-border-l4)');
      expect(css).toContain('font-size:11px');
      expect(css).toContain('var(--dsw-alias-interactive-bg-hover-solid)');
    });
  });
});
