/**
 * 数字展示辅助：token 量与 USD 金额的紧凑格式化。
 * 导出 formatTokens / formatUsd / formatSignedUsd。
 */

/** 去掉小数尾巴的 0（"12.30" → "12.3"、"12.0" → "12"）。 */
function trimZero(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/** token 数紧凑展示：小于 1k 原样、小于 1M 用 k（1 位小数）、以上用 M（2 位小数）。 */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${trimZero((n / 1000).toFixed(1))}k`;
  return `${trimZero((n / 1_000_000).toFixed(2))}M`;
}

/** USD 金额：固定 4 位小数（价格对比表的精度）。 */
export function formatUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

/** 带符号 USD（节省额）：正数加 +、负数加 -。 */
export function formatSignedUsd(n: number): string {
  return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(4)}`;
}
