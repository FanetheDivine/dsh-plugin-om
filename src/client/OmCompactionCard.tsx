/**
 * dsh-plugin-om 压缩卡片渲染器：默认折叠的压缩标记行。
 *
 * 压缩检查点遮蔽的是模型可见表层，人类转录中的历史仍在其上方；卡片只报告
 * 模型从何处起不再看到那段历史。summary 来自检查点引用的 compaction/summary
 * 事件；窗口裁剪把该事件留在窗外时，行不可展开而不是显示空内容。
 */

import type { ChatNode } from '@deepseek-ai/dsh-client-ui-conversation/client';
import {
  IconApiOutline14,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { CSSProperties } from 'react';
import { memo, useState } from 'react';

/** Keyed renderer props: 装配好的卡片节点 + 绑定 `om-compaction` 命名空间的 locale 座。 */
export interface OmCompactionCardProps {
  readonly node: ChatNode<'om-compaction'>;
  readonly t: TranslateNS<'om-compaction'>;
}

/** 折叠式压缩卡片（计数 + summary 展开）。 */
export const OmCompactionCard = memo(function OmCompactionCard({ node, t }: OmCompactionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const { data } = node;
  const expandable = data.summary !== null;
  const open = expandable && expanded;
  const summary =
    data.shadowedItemCount !== null && data.shadowedTokenCount !== null
      ? t('compaction.completed', {
          items: data.shadowedItemCount,
          tokens: data.shadowedTokenCount,
        })
      : expandable
        ? t('compaction.expand')
        : t('compaction.unavailable');
  return (
    <div style={styles.row}>
      <button
        type="button"
        style={styles.button}
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => {
          setExpanded((value) => !value);
        }}
      >
        <span style={styles.leading} aria-hidden>
          <span style={styles.contextIcon}>
            <IconApiOutline14 />
          </span>
          <span style={styles.disclosure}>
            {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
          </span>
        </span>
        <span style={styles.title}>{t('compaction')}</span>
        <span style={styles.sep} aria-hidden />
        <span style={styles.summary}>{summary}</span>
      </button>
      {open && data.summary !== null && (
        <div style={styles.body}>
          <MarkdownText text={data.summary} />
        </div>
      )}
    </div>
  );
});

const styles: Record<string, CSSProperties> = {
  row: { padding: '2px 12px' },
  button: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    border: 'none',
    background: 'transparent',
    padding: '6px 4px',
    cursor: 'pointer',
    font: 'inherit',
    color: 'inherit',
    textAlign: 'left',
  },
  leading: { display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 },
  contextIcon: { display: 'inline-flex', color: 'var(--dsh-fg-muted, #9aa4b2)' },
  disclosure: { display: 'inline-flex', color: 'var(--dsh-fg-muted, #9aa4b2)' },
  title: { fontWeight: 600 },
  sep: { flex: 1, borderTop: '1px solid var(--dsh-border, #e3e8ef)' },
  summary: { color: 'var(--dsh-fg-muted, #9aa4b2)', fontSize: 12 },
  body: { padding: '6px 4px 10px', borderTop: '1px solid var(--dsh-border, #e3e8ef)' },
};
