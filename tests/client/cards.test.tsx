// @vitest-environment jsdom
/**
 * 消息卡片组件测试：验证折叠行横向滚动支持与展开体水平滚动适配。
 */

import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client';
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
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
});
