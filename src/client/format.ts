/**
 * 压缩卡片统计行的紧凑数字格式化。导出 formatCompactCount。
 * <1k 原样；≥1k 用 k；≥1w（万）用 w；≥1M 用 M；保留 1 位小数并去掉末尾 .0。
 */
export function formatCompactCount(value: number): string {
  const trim = (n: number): string => {
    const text = String(Math.round(n * 10) / 10);
    return text.endsWith('.0') ? text.slice(0, -2) : text;
  };
  if (value >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (value >= 10_000) return `${trim(value / 10_000)}w`;
  if (value >= 1_000) return `${trim(value / 1_000)}k`;
  return String(value);
}
