/**
 * 压缩卡片渲染器：与宿主「上下文注入」卡片同款的折叠行。
 * 复用平台原语 DisclosureRow；行内统计与展开体样式按宿主 ContextInjectionRow 的规则
 * 注入 <style>（宿主该卡片样式是编译期哈希的 CSS Module，插件 bundle 无法引用其类名）。
 * 卡片报告模型从何处起不再看到那段历史；summary 留在加载窗口外时行不可展开。
 * 压缩失败节点渲染为可展开的错误行：折叠行显示错误摘要，展开体显示完整报错。
 * 展开体下方的操作栏（宿主 inspectButton 同款胶囊）：宿主提供 inspectCall 时显示「轨迹」，
 * 切到轨迹视图；节点带诊断子会话 id 且宿主注入 openSession 时显示「诊断日志」，跳转到该子会话页面。
 */

import type { ChatNode, ToolCallId } from '@deepseek-ai/dsh-client-ui-chat/client';
import {
  DisclosureRow,
  IconBrowseOutlineRegular,
  IconInspectOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client';
import type { CSSProperties, MouseEvent } from 'react';
import { memo, useState } from 'react';
import { formatCompactCount } from './format.ts';

/** Keyed renderer props: 装配好的卡片节点 + 绑定 `om-compaction` 命名空间的 locale 座。 */
export interface OmCompactionCardProps {
  readonly node: ChatNode<'om-compaction'>;
  readonly t: TranslateNS<'om-compaction'>;
  /** 当前（父）会话 id，作为诊断子会话地址的 parentSessionId。 */
  readonly sessionId?: SessionId;
  /** 宿主注入的会话跳转；缺失时不显示「诊断日志」。 */
  readonly openSession?: (target: SubagentAddress) => void;
  /** 宿主 owner 提供的轨迹视图跳转；缺失（轨迹视图不可用）时不显示「轨迹」。 */
  readonly inspectCall?: ((callId: ToolCallId) => void) | undefined;
}

/** 卡片样式类名（与宿主 ContextInjectionRow.module.css 同款规则，增加水平滚动支持）。 */
const css = {
  root: 'om-compaction-root',
  chevron: 'om-compaction-chevron',
  sep: 'om-compaction-sep',
  summary: 'om-compaction-summary',
  scrollable: 'om-compaction-scrollable',
  body: 'om-compaction-body',
  actions: 'om-compaction-actions',
  inspect: 'om-compaction-inspect',
} as const;

/** 卡片样式规则：保留宿主外观，对折叠摘要与展开体增加水平滚动适配。 */
const cardCss = `
.${css.root}{min-width:0}
.${css.root}[data-open]{padding-bottom:4px}
.${css.chevron}{color:var(--dsw-alias-label-secondary)}
.${css.sep}{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}
.${css.summary}{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:auto;font-size:14px;line-height:24px;overflow:hidden}
.${css.summary}.${css.scrollable}{overflow-x:auto;overflow-y:hidden;text-overflow:clip;scrollbar-width:none;-webkit-overflow-scrolling:touch}
.${css.summary}.${css.scrollable}::-webkit-scrollbar{display:none}
.${css.actions}{flex-wrap:wrap;align-items:center;gap:8px;margin:4px 0 2px 22px;display:flex}
.${css.inspect}{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;cursor:pointer;white-space:nowrap;border-radius:999px;flex:none;align-items:center;gap:4px;margin:0;padding:2px 8px;display:inline-flex}
.${css.inspect}:is(:hover,:focus-visible){background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}
.${css.body}{box-sizing:border-box;background:var(--dsw-alias-markdown-code-block);width:calc(100% - 22px);max-height:141px;color:var(--dsw-alias-label-tertiary);font:400 11px/16px var(--ds-font-family-code);border:none;border-radius:8px;margin:4px 0 0 22px;padding:10px 16px 12px 12px;overflow-x:auto;overflow-y:auto;overscroll-behavior-x:contain;-webkit-overflow-scrolling:touch;scrollbar-width:thin}
`;

/** 注册卡片样式（无 document 的环境如 node 测试直接跳过）。 */
if (
  typeof document !== 'undefined' &&
  document.querySelector('style[data-dsh-plugin-om-card]') === null
) {
  const tag = document.createElement('style');
  tag.dataset.dshPluginOmCard = 'true';
  tag.textContent = cardCss;
  document.head.appendChild(tag);
}

/** 折叠式压缩卡片（统计标题行 + 代码块样式 summary 展开）。 */
export const OmCompactionCard = memo(function OmCompactionCard({
  node,
  t,
  sessionId,
  openSession,
  inspectCall,
}: OmCompactionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const { data } = node;
  // 「诊断日志」：仅当有诊断子会话 id、父会话 id 与宿主跳转能力时渲染；点击不触发行折叠
  const diagnosticSessionId = data.diagnosticSessionId;
  const inspect =
    diagnosticSessionId !== null && sessionId !== undefined && openSession !== undefined ? (
      <button
        type="button"
        className={css.inspect}
        data-om-compaction-inspect
        onClick={(event: MouseEvent) => {
          event.stopPropagation();
          openSession({
            parentSessionId: sessionId,
            // 事件载荷里的 id 是普通字符串；品牌类型仅在类型层区分，无运行时构造器可用于浏览器 bundle
            childSessionId: diagnosticSessionId as SessionId,
            mode: 'one-shot',
          });
        }}
      >
        <IconInspectOutlineRegular size={12} />
        {t('card.inspect')}
      </button>
    ) : null;
  // 「轨迹」：切到轨迹视图。轨迹按 callId 定位记录，压缩没有 callId，故只切换视图
  const trajectory =
    inspectCall === undefined ? null : (
      <button
        type="button"
        className={css.inspect}
        data-om-compaction-trajectory
        onClick={(event: MouseEvent) => {
          event.stopPropagation();
          inspectCall(node.key as ToolCallId);
        }}
      >
        <IconInspectOutlineRegular size={12} />
        {t('card.trajectory')}
      </button>
    );
  // 展开体下方的操作栏；没有可用按钮时不渲染
  const actions =
    trajectory === null && inspect === null ? null : (
      <div className={css.actions} data-om-compaction-actions>
        {trajectory}
        {inspect}
      </div>
    );
  // 压缩进行中：不可展开的「正在压缩上下文…」提示行（按 phase 区分文案）
  if (data.running) {
    const runningLabel =
      data.phase === 'observe'
        ? t('compaction.running.observe')
        : data.phase === 'reflect'
          ? t('compaction.running.reflect')
          : t('compaction.running');
    return (
      <div style={styles.row}>
        <DisclosureRow
          className={css.root}
          icon={<IconBrowseOutlineRegular size={14} />}
          title={runningLabel}
          open={false}
          expandable={false}
          onToggle={() => {
            /* 进行中提示行不可展开 */
          }}
        />
      </div>
    );
  }
  // 压缩失败：可展开的错误行（按 phase 区分文案），折叠行为错误摘要、展开体为完整报错
  if (data.error !== null) {
    const failedLabel =
      data.phase === 'observe'
        ? t('compaction.failed.observe')
        : data.phase === 'reflect'
          ? t('compaction.failed.reflect')
          : t('compaction.failed');
    const errorSummary = data.error.length > 80 ? `${data.error.slice(0, 80)}…` : data.error;
    return (
      <div style={styles.row}>
        <DisclosureRow
          className={css.root}
          icon={<IconBrowseOutlineRegular size={14} />}
          chevronClassName={css.chevron}
          title={failedLabel}
          collapsedContent={
            <>
              <span className={css.sep} aria-hidden />
              <span className={`${css.summary} ${css.scrollable}`}>{errorSummary}</span>
            </>
          }
          keepContentWhenOpen
          expandable
          expandOnRowClick
          open={expanded}
          onToggle={() => {
            setExpanded((value) => !value);
          }}
        >
          <div className={css.body} style={styles.body}>
            {data.error}
          </div>
          {actions}
        </DisclosureRow>
      </div>
    );
  }
  // summary 在加载窗口外时仍可展开：展开体只放操作栏
  const expandable = data.summary !== null || actions !== null;
  const open = expandable && expanded;
  // 统计行：优先完整压缩前后统计，载荷字段不全时逐级回落
  const stats =
    data.shadowedItemCount !== null &&
    data.shadowedCharCount !== null &&
    data.shadowedTokenCount !== null &&
    data.summaryCharCount !== null &&
    data.summaryTokenCount !== null
      ? t('compaction.stats', {
          items: formatCompactCount(data.shadowedItemCount),
          beforeChars: formatCompactCount(data.shadowedCharCount),
          beforeTokens: formatCompactCount(data.shadowedTokenCount),
          afterChars: formatCompactCount(data.summaryCharCount),
          afterTokens: formatCompactCount(data.summaryTokenCount),
        })
      : data.shadowedItemCount !== null && data.shadowedTokenCount !== null
        ? t('compaction.completed', {
            items: formatCompactCount(data.shadowedItemCount),
            tokens: formatCompactCount(data.shadowedTokenCount),
          })
        : data.summary !== null
          ? t('compaction.expand')
          : t('compaction.unavailable');
  return (
    <div style={styles.row}>
      <DisclosureRow
        className={css.root}
        icon={<IconBrowseOutlineRegular size={14} />}
        chevronClassName={css.chevron}
        title={t('compaction')}
        collapsedContent={
          <>
            <span className={css.sep} aria-hidden />
            <span className={`${css.summary} ${css.scrollable}`} data-om-compaction-summary>
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
        {actions}
      </DisclosureRow>
    </div>
  );
});

const styles: Record<string, CSSProperties> = {
  row: {},
  /** 摘要与失败报错为多行文本，保留换行。 */
  body: { whiteSpace: 'pre-wrap' },
};
