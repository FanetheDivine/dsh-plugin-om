/**
 * 降级报告：压缩流程中的挂载失败统一出口。
 * 导出 reportDegrade / DEGRADE_PROBLEMS / DegradedProblem。
 *
 * - 挂载失败类问题（服务缺失、服务调用异常）始终 console.warn 到宿主进程外部输出，
 *   并向会话日志追加 log-only 的 `om/warning` 事件（客户端渲染为「功能降级」警告行）；
 *   同一会话同一问题只报告一次（按日志扫描去重，重启不重复）
 * - 报告动作自身绝不抛错：追加失败只记日志，不阻塞压缩
 * - 辅助函数的普通运行时报错（组装失败、请求头读取失败）不走本模块，仅记日志
 */
import { PLUGIN_LABEL } from './constants.ts';
import type { PluginLogger } from './logger.ts';
import type { Session } from './types.ts';

/** 降级问题标识（om/warning 载荷 problem；同会话按此去重）。 */
export type DegradedProblem =
  /** systemPrompt 服务未挂载（ctx.get 返回 undefined）：上下文压力不扣系统提示词，观察偏早触发 */
  | 'systemPrompt-missing'
  /** tokenMeter 服务调用异常（measure/estimateMessage 抛错）：压力估算降级，可能跳过观察压缩 */
  | 'tokenMeter-unavailable';

/** 各降级问题面向用户的简短说明（om/warning 载荷 message；客户端警告行直接展示）。 */
export const DEGRADE_PROBLEMS: Record<DegradedProblem, string> = {
  'systemPrompt-missing':
    '系统提示词服务未挂载，上下文压力估算不扣除系统提示词 tokens（压缩触发会偏早）',
  'tokenMeter-unavailable': 'token 计量服务异常，上下文压力估算降级（可能跳过压缩或按 0 计）',
};

/** 判定事件是否为指定 problem 的已有 om/warning 记录（会话内去重依据）。 */
function isWarningFor(event: { type?: string; data?: unknown }, problem: DegradedProblem): boolean {
  if (event.type !== 'om/warning') return false;
  return (event.data as { problem?: unknown } | undefined)?.problem === problem;
}

/**
 * 报告一次挂载失败类降级：console.warn 始终输出到宿主进程外部；同会话同问题首次
 * 出现时，向会话日志追加 log-only `om/warning` 事件（客户端渲染警告行，每会话最多
 * 一次）并输出 logger.warn（避免每个 pre-step 重复刷日志）。
 * 日志扫描/事件追加失败只记日志，绝不抛错、不阻塞压缩。
 */
export function reportDegrade(
  session: Session,
  logger: PluginLogger,
  problem: DegradedProblem,
): void {
  const message = DEGRADE_PROBLEMS[problem];
  let first = true;
  try {
    first = !session.events.some((event) => isWarningFor(event, problem));
  } catch {
    /* 日志扫描失败按首次处理（可能重复追加一次警告，无害） */
  }
  if (!first) return;
  console.warn(`${PLUGIN_LABEL}: ${message}`);
  logger.warn(message);
  try {
    session.append('om/warning', { problem, message });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    logger.warn(`om/warning 事件追加失败: ${text}`);
  }
}
