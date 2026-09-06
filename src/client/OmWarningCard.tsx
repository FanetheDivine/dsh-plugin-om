/**
 * 功能降级警告行渲染器：与压缩卡片同款的折叠行。
 * 折叠行显示降级说明摘要，展开体显示完整说明；数据来自 om/warning 信封载荷
 * （借用 feedback/record），服务端按会话同问题去重后追加（每会话同一问题至多一行）。
 */

import type { ChatNode } from '@deepseek-ai/dsh-client-ui-conversation/client';
import { DisclosureRow, IconBrowseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { CSSProperties } from 'react';
import { memo, useState } from 'react';

/** Keyed renderer props: 装配好的警告行节点 + 绑定 `om-compaction` 命名空间的 locale 座。 */
export interface OmWarningCardProps {
  readonly node: ChatNode<'om-warning'>;
  readonly t: TranslateNS<'om-compaction'>;
}

/** 折叠式功能降级警告行（降级说明摘要行 + 完整说明展开）。 */
export const OmWarningCard = memo(function OmWarningCard({ node, t }: OmWarningCardProps) {
  const [expanded, setExpanded] = useState(false);
  const { data } = node;
  const message = data.message ?? (data.problem !== null ? data.problem : '');
  const expandable = message !== '';
  const messageSummary = message.length > 80 ? `${message.slice(0, 80)}…` : message;
  return (
    <div>
      <DisclosureRow
        className="om-compaction-root"
        icon={<IconBrowseOutline16 size={14} />}
        chevronClassName="om-compaction-chevron"
        title={t('warning')}
        collapsedContent={
          expandable ? (
            <>
              <span className="om-compaction-sep" aria-hidden />
              <span className="om-compaction-summary">{messageSummary}</span>
            </>
          ) : undefined
        }
        keepContentWhenOpen
        expandable={expandable}
        expandOnRowClick
        open={expandable && expanded}
        onToggle={() => {
          if (expandable) setExpanded((value) => !value);
        }}
      >
        {expandable && (
          <div className="om-compaction-body" style={bodyStyle}>
            {message}
          </div>
        )}
      </DisclosureRow>
    </div>
  );
});

const bodyStyle: CSSProperties = { whiteSpace: 'pre-wrap' };
