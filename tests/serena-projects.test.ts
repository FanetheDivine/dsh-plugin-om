// Serena 项目解析行为测试：真实 TypeScript 配置、成员约束、引用与缓存依赖。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = path.join(ROOT, 'scripts/serena-projects.cjs');
const TYPESCRIPT = createRequire(path.join(ROOT, 'package.json')).resolve('typescript');
const temporaryRoots: string[] = [];

/** 配置解析结果。 */
interface ProjectResult {
  projects: { config: string; files: string[] }[];
  dependencies: string[];
}

/** 创建独立项目根目录。 */
function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'serena-project-membership-'));
  temporaryRoots.push(root);
  return root;
}

/** 写入配置或源文件。 */
function write(root: string, relative: string, content: string): void {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** 使用显式受信任编译器运行 helper。 */
function parse(root: string, configs: string[], files: string[]): ProjectResult {
  const result = spawnSync(process.execPath, [HELPER, TYPESCRIPT], {
    cwd: root,
    input: JSON.stringify({ root, configs, files }),
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as ProjectResult;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe('Serena TypeScript 项目成员解析', () => {
  it('解析 JSONC 和 extends，并随继承选项变化更新 MJS 成员与 exclude', () => {
    const root = fixture();
    const files = ['src/main.ts', 'src/hidden.ts', 'scripts/task.mjs'];
    for (const file of [...files, 'src/unlisted.ts']) write(root, file, 'export const value = 1;');
    write(
      root,
      'base.json',
      '{ "compilerOptions": { "allowJs": false }, "include": ["src", "scripts"], "exclude": ["src/hidden.ts"] }',
    );
    write(
      root,
      'tsconfig.json',
      '{\n// project settings\n"extends": "./base.json",\n"compilerOptions": {"target": "es2022",},\n}',
    );

    const first = parse(root, ['tsconfig.json'], files);
    expect(first.projects).toEqual([{ config: 'tsconfig.json', files: ['src/main.ts'] }]);
    expect(first.dependencies).toEqual(
      expect.arrayContaining([path.join(root, 'tsconfig.json'), path.join(root, 'base.json')]),
    );

    write(
      root,
      'base.json',
      '{ "compilerOptions": { "allowJs": true }, "include": ["src", "scripts"], "exclude": [] }',
    );
    const changed = parse(root, ['tsconfig.json'], files);
    expect(changed.projects).toEqual([{ config: 'tsconfig.json', files: [...files].sort() }]);
  });

  it('分别解析根与 web 工程，跟随命名配置引用并记录缺失引用', () => {
    const root = fixture();
    const files = ['src/root.ts', 'web/src/view.tsx', 'packages/unit/src/unit.ts'];
    for (const file of files) write(root, file, 'export const value = 1;');
    write(
      root,
      'tsconfig.json',
      JSON.stringify({
        include: ['src'],
        references: [{ path: './packages/unit/typed.config.json' }, { path: './missing-project' }],
      }),
    );
    write(
      root,
      'web/tsconfig.json',
      '{"include": ["src"], "compilerOptions": {"jsx": "preserve"}}',
    );
    write(
      root,
      'packages/unit/typed.config.json',
      '{"include": ["src"], "references": [{"path": "../../tsconfig.json"}]}',
    );

    const result = parse(root, ['tsconfig.json', 'web/tsconfig.json'], files);
    expect(result.projects).toEqual([
      { config: 'packages/unit/typed.config.json', files: ['packages/unit/src/unit.ts'] },
      { config: 'tsconfig.json', files: ['src/root.ts'] },
      { config: 'web/tsconfig.json', files: ['web/src/view.tsx'] },
    ]);
    expect(result.dependencies).toEqual(
      expect.arrayContaining([
        path.join(root, 'packages/unit/typed.config.json'),
        path.join(root, 'missing-project/tsconfig.json'),
      ]),
    );
  });

  it('跳过坏配置、非法选项和无源工程，保留缺失继承依赖', () => {
    const root = fixture();
    write(root, 'src/main.ts', 'export const value = 1;');
    write(root, 'broken.json', '{"compilerOptions": {,}, "include": ["src"]}');
    write(root, 'invalid.json', '{"compilerOptions": {"allowJs": "yes"}, "include": ["src"]}');
    write(root, 'empty.json', '{"include": ["no-files"]}');
    write(root, 'missing-base.json', '{"extends": "./not-there", "include": ["src"]}');

    const configs = ['broken.json', 'invalid.json', 'empty.json', 'missing-base.json'];
    const first = parse(root, configs, ['src/main.ts']);
    expect(first.projects).toEqual([]);
    expect(first.dependencies).toEqual(
      expect.arrayContaining([
        ...configs.map((config) => path.join(root, config)),
        path.join(root, 'not-there'),
        path.join(root, 'not-there.json'),
      ]),
    );

    write(root, 'not-there.json', '{}');
    expect(parse(root, configs, ['src/main.ts']).projects).toEqual([
      { config: 'missing-base.json', files: ['src/main.ts'] },
    ]);
  });

  it('解析包式 extends，记录包元数据、继承配置与缺失包探测', () => {
    const root = fixture();
    write(root, 'src/main.ts', 'export const value = 1;');
    write(root, 'scripts/task.mjs', 'export const task = 1;');
    write(
      root,
      'node_modules/@shared/settings/package.json',
      '{"name": "@shared/settings", "tsconfig": "base.config.json"}',
    );
    write(
      root,
      'node_modules/@shared/settings/base.config.json',
      '{"compilerOptions": {"allowJs": true}}',
    );
    write(root, 'tsconfig.json', '{"extends": "@shared/settings", "include": ["src", "scripts"]}');
    write(root, 'missing-package.json', '{"extends": "@shared/missing", "include": ["src"]}');

    const result = parse(
      root,
      ['tsconfig.json', 'missing-package.json'],
      ['src/main.ts', 'scripts/task.mjs'],
    );
    expect(result.projects).toEqual([
      { config: 'tsconfig.json', files: ['scripts/task.mjs', 'src/main.ts'] },
    ]);
    expect(result.dependencies).toEqual(
      expect.arrayContaining([
        path.join(root, 'node_modules/@shared/settings/package.json'),
        path.join(root, 'node_modules/@shared/settings/base.config.json'),
        path.join(root, 'node_modules/@shared/missing'),
      ]),
    );
  });

  it('无源 solution 仍展开项目引用，files 显式列表仅返回输入源文件', () => {
    const root = fixture();
    write(root, 'src/main.ts', 'export const value = 1;');
    write(root, 'src/unlisted.ts', 'export const unlisted = 1;');
    write(root, 'solution.json', '{"files": [], "references": [{"path": "./explicit.json"}]}');
    write(root, 'explicit.json', '{"files": ["src/main.ts", "src/unlisted.ts", "../outside.ts"]}');
    expect(parse(root, ['solution.json'], ['src/main.ts']).projects).toEqual([
      { config: 'explicit.json', files: ['src/main.ts'] },
    ]);
  });

  it('仅加载指定编译器，不执行配置插件或项目代码，不输出未供给或越界源文件', () => {
    const root = fixture();
    const sentinel = path.join(root, 'executed');
    const payload = `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'unsafe');`;
    write(root, 'node_modules/typescript/index.js', payload);
    write(root, 'plugin.cjs', payload);
    write(root, 'src/run.ts', payload);
    write(root, 'src/unlisted.ts', 'export const unlisted = 1;');
    write(
      root,
      'tsconfig.json',
      '{"include": ["**/*", "../*"], "compilerOptions": {"allowJs": true, "plugins": [{"name": "./plugin.cjs"}]}}',
    );

    const result = parse(
      root,
      ['tsconfig.json', '../outside.json'],
      ['src/run.ts', '../outside.ts', path.join(root, 'src/unlisted.ts')],
    );
    expect(result.projects).toEqual([{ config: 'tsconfig.json', files: ['src/run.ts'] }]);
    expect(existsSync(sentinel)).toBe(false);
    for (const project of result.projects) {
      expect(project.files).not.toContain('src/unlisted.ts');
      expect(project.files.some((file) => file.startsWith('../'))).toBe(false);
    }
  });
});
