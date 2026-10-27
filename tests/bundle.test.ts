// 组合包结构测试：cordis.patch.yml 的行与 package.json exports、入口导出、
// locale 元信息一一对应。Loader 按行 name 作为模块 specifier import 入口，
// 并按 <标识>/locale/*.json 读取展示元信息，任一映射断裂都会导致该行加载失败。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/** 仓库根目录（tests/ 的上一级）。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 包名。 */
const PKG = 'dsh-plugin-om';

/** patch 插入的一行。 */
type PatchRow = { readonly id: string; readonly name: string };

/** package.json 解析结果（本测试关心的字段）。 */
type PkgJson = {
  exports: Record<string, unknown>;
  files: string[];
  description?: string;
};

/** 读取 package.json。 */
function readPkg(): PkgJson {
  return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as PkgJson;
}

/** patch 按声明顺序插入的行列表。 */
function patchRows(): PatchRow[] {
  const doc = parse(readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')) as Array<{
    insert?: PatchRow[];
  }>;
  return doc.flatMap((item) => item.insert ?? []);
}

/** 行 name（模块 specifier）对应的 exports 键；包根名对应 '.'。 */
function exportKeyOf(name: string): string {
  return name === PKG ? '.' : `./${name.slice(`${PKG}/`.length)}`;
}

/** 行 name 对应的源码入口（相对本测试文件）。 */
const SOURCE_ENTRIES: Record<string, string> = {
  'dsh-plugin-om': '../src/index.ts',
  'dsh-plugin-om/recompress': '../src/recompress/index.ts',
  'dsh-plugin-om/compaction-eval': '../src/compaction-eval/index.ts',
};

describe('组合包 patch 与 exports', () => {
  it('patch 按顺序插入包根行与两个组件行', () => {
    expect(patchRows()).toEqual([
      { id: 'dsh-plugin-om', name: 'dsh-plugin-om' },
      { id: 'dsh-plugin-om-recompress', name: 'dsh-plugin-om/recompress' },
      { id: 'dsh-plugin-om-compaction-eval', name: 'dsh-plugin-om/compaction-eval' },
    ]);
  });

  it('每行 name 能按 exports 解析，入口导出同名插件与 apply', async () => {
    const pkg = readPkg();
    for (const row of patchRows()) {
      expect(pkg.exports[exportKeyOf(row.name)], row.name).toBeDefined();
      const mod = (await import(SOURCE_ENTRIES[row.name] as string)) as {
        name: string;
        apply: unknown;
      };
      expect(mod.name, row.name).toBe(row.name);
      expect(typeof mod.apply, row.name).toBe('function');
    }
  });

  it('locale 子路径 exports 映射到包内文件且随包分发', () => {
    const pkg = readPkg();
    expect(pkg.exports['./locale/*.json']).toBe('./locale/*.json');
    expect(pkg.exports['./recompress/locale/*.json']).toBe('./locale/recompress/*.json');
    expect(pkg.exports['./compaction-eval/locale/*.json']).toBe('./locale/compaction-eval/*.json');
    expect(pkg.files).toContain('locale');
    expect(typeof pkg.description).toBe('string');
  });

  it('包根与组件行都有中英文展示元信息', () => {
    for (const dir of ['locale', 'locale/recompress', 'locale/compaction-eval']) {
      for (const lang of ['zh', 'en']) {
        const file = path.join(ROOT, dir, `${lang}.json`);
        const meta = JSON.parse(readFileSync(file, 'utf8')) as {
          meta?: { title?: unknown; description?: unknown };
        };
        const title = meta.meta?.title;
        const description = meta.meta?.description;
        expect(typeof title, file).toBe('string');
        expect((title as string).length, file).toBeGreaterThan(0);
        expect(typeof description, file).toBe('string');
        expect((description as string).length, file).toBeGreaterThan(0);
      }
    }
  });
});
