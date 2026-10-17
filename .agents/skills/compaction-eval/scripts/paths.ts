/**
 * compaction-eval 的文件位置：评估根目录，以及按会话、阶段、区间命名的视图文件、重压缩目录与评估目录。
 * 各入口共用；不含命令行入口。
 * 导出 bareId / evalRoot / rangeSlug / evalPath / viewPath / recompressPath / selfName 与 RangeKey 类型。
 */
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

/** 命名用到的视图字段：会话头 id、阶段与区间。 */
export interface RangeKey {
  header: { id: string };
  phase: string;
  view: { minIndex: number; maxIndex: number };
}

/** 会话 id 规范化：parentSession 带 session- 前缀，目录名与头 id 为裸 uuid。 */
export function bareId(id: string): string {
  return id.replace(/^session-/, '');
}

/** 评估根目录：系统临时目录下的 om-compaction-eval，每次调用按当前环境解析。 */
export function evalRoot(): string {
  return join(tmpdir(), 'om-compaction-eval');
}

/** 用法行中的脚本名：取实际入口文件名，源码版为 .ts，发布版为 .mjs。 */
export function selfName(fallback: string): string {
  const entry = process.argv[1];
  return entry === undefined ? fallback : basename(entry);
}

/** 区间标识：<会话 id 前 8 位>-<阶段>-<A>-<B>。 */
export function rangeSlug(sessionId: string, phase: string, lo: number, hi: number): string {
  return `${bareId(sessionId).slice(0, 8)}-${phase}-${lo}-${hi}`;
}

/** prepare 缺省输出：<根>/eval-<区间标识>/。 */
export function evalPath(sessionId: string, phase: string, lo: number, hi: number): string {
  return join(evalRoot(), `eval-${rangeSlug(sessionId, phase, lo, hi)}`);
}

/** 视图的区间标识。 */
function viewSlug(file: RangeKey): string {
  return rangeSlug(file.header.id, file.phase, file.view.minIndex, file.view.maxIndex);
}

/** view 缺省输出：<根>/view-<区间标识>.json。 */
export function viewPath(file: RangeKey): string {
  return join(evalRoot(), `view-${viewSlug(file)}.json`);
}

/** compress 缺省输出：<根>/recompress-<区间标识>/，同一视图的多次重压缩共用。 */
export function recompressPath(file: RangeKey): string {
  return join(evalRoot(), `recompress-${viewSlug(file)}`);
}
