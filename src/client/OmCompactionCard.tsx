/**
 * dsh-plugin-om 压缩卡片渲染器：与宿主「上下文注入」卡片同款的折叠行。
 *
 * 复用平台原语 DisclosureRow（宿主 ContextInjectionRow 用的同一外壳组件）；行内
 * 统计与展开体样式按宿主 ContextInjectionRow.module.css 的规则注入——宿主该卡片
 * 的样式是编译期哈希的 CSS Module，插件 bundle 无法引用其类名，故按宿主 client
 * bundle 的同一机制（注入 <style>）注册逐字一致的规则，保证视觉同款。
 *
 * 压缩检查点遮蔽的是模型可见表层，人类转录中的历史仍在其上方；卡片只报告
 * 模型从何处起不再看到那段历史。summary 来自检查点引用的 compaction/summary
 * 事件；窗口裁剪把该事件留在窗外时，行不可展开而不是显示空内容。
 */

import type { ChatNode } from '@deepseek-ai/dsh-client-ui-conversation/client';
import { DisclosureRow, IconBrowseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { CSSProperties } from 'react';
import { memo, useState } from 'react';

/** Keyed renderer props: 装配好的卡片节点 + 绑定 `om-compaction` 命名空间的 locale 座。 */
export interface OmCompactionCardProps {
  readonly node: ChatNode<'om-compaction'>;
  readonly t: TranslateNS<'om-compaction'>;
}

/** 卡片样式类名（与宿主 ContextInjectionRow.module.css 同款规则，见下方注册）。 */
const css = {
  root: 'om-compaction-root',
  chevron: 'om-compaction-chevron',
  sep: 'om-compaction-sep',
  summary: 'om-compaction-summary',
  body: 'om-compaction-body',
} as const;

/** 宿主 ContextInjectionRow.module.css 的规则（逐字一致，仅类名按插件前缀）。 */
const cardCss = `
.${css.root}{min-width:0}
.${css.root}[data-open]{padding-bottom:4px}
.${css.chevron}{color:var(--dsw-alias-label-secondary)}
.${css.sep}{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}
.${css.summary}{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:auto;font-size:14px;line-height:24px;overflow:hidden}
.${css.body}{box-sizing:border-box;background:var(--dsw-alias-markdown-code-block);width:calc(100% - 22px);max-height:141px;color:var(--dsw-alias-label-tertiary);font:400 11px/16px var(--ds-font-family-code);border:none;border-radius:8px;margin:4px 0 0 22px;padding:10px 16px 12px 12px;overflow:auto}
`;

/** 注册卡片样式（与宿主 client bundle 同机制；无 document 的环境如 node 测试直接跳过）。 */
if (
  typeof document !== 'undefined' &&
  document.querySelector('style[data-dsh-plugin-om-card]') === null
) {
  const tag = document.createElement('style');
  tag.dataset.dshPluginOmCard = 'true';
  tag.textContent = cardCss;
  document.head.appendChild(tag);
}

/** 折叠式压缩卡片（统计标题行 + 代码块样式 summary 展开，同「上下文注入」卡片）。 */
export const OmCompactionCard = memo(function OmCompactionCard({ node, t }: OmCompactionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const { data } = node;
  const expandable = data.summary !== null;
  const open = expandable && expanded;
  const stats =
    data.shadowedItemCount !== null &&
    data.shadowedCharCount !== null &&
    data.shadowedTokenCount !== null &&
    data.summaryCharCount !== null &&
    data.summaryTokenCount !== null
      ? t('compaction.stats', {
          items: data.shadowedItemCount,
          beforeChars: data.shadowedCharCount,
          beforeTokens: data.shadowedTokenCount,
          afterChars: data.summaryCharCount,
          afterTokens: data.summaryTokenCount,
        })
      : data.shadowedItemCount !== null && data.shadowedTokenCount !== null
        ? t('compaction.completed', {
            items: data.shadowedItemCount,
            tokens: data.shadowedTokenCount,
          })
        : expandable
          ? t('compaction.expand')
          : t('compaction.unavailable');
  return (
    <div style={styles.row}>
      <DisclosureRow
        className={css.root}
        icon={<IconBrowseOutline16 size={14} />}
        chevronClassName={css.chevron}
        title={t('compaction')}
        collapsedContent={
          <>
            <span className={css.sep} aria-hidden />
            <span className={css.summary} data-om-compaction-summary>
              {stats}
            </span>
          </>
        }
        keepContentWhenOpen
        expandable={expandable}
        expandOnRowClick
        open={open}
        onToggle={() => {
          setExpanded((value) => !value);
        }}
      >
        {data.summary !== null && (
          <div className={css.body} style={styles.body}>
            {data.summary}
          </div>
        )}
      </DisclosureRow>
    </div>
  );
});

const styles: Record<string, CSSProperties> = {
  row: {},
  /** 摘要为 <history> 文本，保留换行（宿主 body 的白色空间由内容形态各自处理）。 */
  body: { whiteSpace: 'pre-wrap' },
};
