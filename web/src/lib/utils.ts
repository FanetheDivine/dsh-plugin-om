/**
 * 样式工具：合并 clsx 类名 + tailwind-merge 去重。
 * 导出 cn。
 */
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** 合并并去重 Tailwind 类名。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
