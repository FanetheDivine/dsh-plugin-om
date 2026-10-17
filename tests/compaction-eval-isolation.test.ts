// compaction-eval 入口隔离测试：prepare/view/compress/aggregate 四个脚本各自被 tsdown
// 打成自包含 .mjs，非外部依赖全部内联。入口之间的运行时导入会把被导入入口的
// main 守卫一起打进 bundle，单文件产物内 import.meta.url 相同，多个守卫同时判真，
// 执行一个脚本会连带运行其他脚本的 main。
// 用 TypeScript compiler API 解析入口源码，断言入口之间只允许 type-only 导入。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_DIR = path.join(ROOT, '.agents', 'skills', 'compaction-eval', 'scripts');

/** 入口脚本名，与 tsdown.config.ts 及 scripts/build-skill.mjs 的脚本清单一致。 */
const ENTRIES = ['prepare', 'view', 'compress', 'aggregate', 'merge'];

/** 命名绑定是否全部带 type 修饰；缺省绑定、命名空间绑定与空绑定都视为运行时。 */
function bindingsAllTypeOnly(
  bindings: ts.ImportClause['namedBindings'] | ts.ExportDeclaration['exportClause'],
): boolean {
  if (bindings === undefined) return false;
  if (ts.isNamespaceImport(bindings) || ts.isNamespaceExport(bindings)) return false;
  return bindings.elements.length > 0 && bindings.elements.every((e) => e.isTypeOnly);
}

/** import 声明是否纯类型：import type，或无默认绑定且命名绑定全为 type。 */
function importIsTypeOnly(stmt: ts.ImportDeclaration): boolean {
  const clause = stmt.importClause;
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  return clause.name === undefined && bindingsAllTypeOnly(clause.namedBindings);
}

/** export from 声明是否纯类型：export type，或命名绑定全为 type。 */
function exportIsTypeOnly(stmt: ts.ExportDeclaration): boolean {
  return stmt.isTypeOnly || bindingsAllTypeOnly(stmt.exportClause);
}

/** 入口脚本运行时导入的其他入口脚本名；type-only 导入不计。 */
function runtimeEntryImports(entry: string): string[] {
  const file = path.join(SCRIPT_DIR, `${entry}.ts`);
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const hits: string[] = [];
  for (const stmt of source.statements) {
    const isImport = ts.isImportDeclaration(stmt);
    if (!isImport && !ts.isExportDeclaration(stmt)) continue;
    const { moduleSpecifier } = stmt;
    if (moduleSpecifier === undefined || !ts.isStringLiteral(moduleSpecifier)) continue;
    const target = moduleSpecifier.text.replace(/^\.\//, '').replace(/\.ts$/, '');
    if (target === entry || !ENTRIES.includes(target)) continue;
    const typeOnly = isImport ? importIsTypeOnly(stmt) : exportIsTypeOnly(stmt);
    if (!typeOnly) hits.push(target);
  }
  return hits;
}

describe('compaction-eval 入口隔离', () => {
  it.each(ENTRIES)('%s.ts 不运行时导入其他入口脚本', (entry) => {
    expect(
      runtimeEntryImports(entry),
      '入口间运行时导入会被内联进 bundle，main 守卫共享 import.meta.url 而误触发',
    ).toEqual([]);
  });
});
