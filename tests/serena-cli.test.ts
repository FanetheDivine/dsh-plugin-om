// Serena CLI 真实行为测试：通过 uv 启动独立进程并查询仓库 TypeScript 符号。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** 仓库根目录。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Serena 符号输出。 */
interface SymbolOutput {
  name_path: string;
  relative_path?: string;
  kind?: string;
  line?: number;
  body_location?: { start_line: number; end_line: number };
  info?: string;
}

/** 执行 Serena CLI，单次调用给语言服务器充足启动时间。 */
function runSerena(...args: string[]) {
  return spawnSync('uv', ['run', '--script', 'scripts/serena-cli.py', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
    timeout: 120_000,
    windowsHide: true,
  });
}

/** 从可能带 Serena 截断说明的 stdout 中解析 JSON。 */
function parseOutput(stdout: string): SymbolOutput[] {
  const start = stdout.search(/[[{]/);
  expect(start, stdout).toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(start)) as SymbolOutput[];
}

/** 断言进程成功，并在失败时保留 Serena 诊断。 */
function expectSuccess(result: ReturnType<typeof runSerena>) {
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(0);
}

describe('Serena CLI', () => {
  it('拒绝互斥输入、缺失目标和无效行号', () => {
    const conflict = runSerena('definition', 'formatTokens', '--at', 'web/src/format.ts:13');
    expect(conflict.status).toBe(2);
    expect(conflict.stderr).toContain('exactly one');

    const missing = runSerena('references');
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('exactly one');

    const invalidLine = runSerena('doc', '--at', 'web/src/format.ts:0');
    expect(invalidLine.status).toBe(2);
    expect(invalidLine.stderr).toContain('positive');
  }, 120_000);

  it('名称模式返回定义，输出位置和类型', () => {
    const result = runSerena('definition', 'formatTokens');
    expectSuccess(result);
    const symbols = parseOutput(result.stdout);
    const symbol = symbols.find((item) => item.name_path === 'formatTokens');
    expect(symbol).toMatchObject({
      name_path: 'formatTokens',
      kind: 'Function',
      body_location: { start_line: 13 },
    });
    expect(symbol?.relative_path?.replaceAll('\\', '/')).toBe('web/src/format.ts');
  }, 180_000);

  it('声明行模式定位定义，省略行号时只返回文件候选', () => {
    const definition = runSerena('definition', '--at', 'web/src/format.ts:13');
    expectSuccess(definition);
    const definitions = parseOutput(definition.stdout);
    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toMatchObject({
      name_path: 'formatTokens',
      body_location: { start_line: 13 },
    });

    const candidates = runSerena('doc', '--at', 'web/src/format.ts');
    expectSuccess(candidates);
    const symbols = parseOutput(candidates.stdout);
    const formatTokens = symbols.find((item) => item.name_path === 'formatTokens');
    expect(formatTokens?.line).toBe(13);
    expect(symbols.every((item) => item.info === undefined)).toBe(true);
  }, 240_000);

  it('引用模式定位唯一定义，转换行号并遵守输出上限', () => {
    const result = runSerena('references', 'formatTokens', '--max-chars', '1000');
    expectSuccess(result);
    expect(result.stdout).toContain('References without surrounding lines');
    expect(result.stdout).toContain('"reference_line":73');
    expect(result.stdout).not.toContain('"reference_line":72');
    expect(result.stdout).toContain('CostTable');

    const atResult = runSerena('references', '--at', 'web/src/format.ts:13');
    expectSuccess(atResult);
    expect(atResult.stdout).toContain('>  73:');
    expect(atResult.stdout).toContain('content_around_reference');
    expect(atResult.stdout).not.toContain('>  72:');
  }, 300_000);

  it('文档模式通过声明行返回 UTF-8 中文注释与签名', () => {
    const result = runSerena('doc', '--at', 'web/src/format.ts:13');
    expectSuccess(result);
    const symbols = parseOutput(result.stdout);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.info).toContain('function formatTokens(n: number): string');
    expect(symbols[0]?.info).toContain('token 数紧凑展示');
    expect(result.stdout).not.toContain('�');
  }, 180_000);

  it('无匹配符号或声明行不唯一时返回明确错误', () => {
    const missingName = runSerena('references', 'serenaSymbolThatDoesNotExist');
    expect(missingName.status).toBe(1);
    expect(missingName.stderr).toContain('No symbol matches');

    const missing = runSerena('definition', '--at', 'web/src/format.ts:5');
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('No symbol declared');

    const ambiguous = runSerena('definition', '--at', 'tests/fixtures/serena-multi.ts:3');
    expect(ambiguous.status).toBe(1);
    expect(ambiguous.stderr).toContain('Multiple symbols declared');
    expect(ambiguous.stderr).toContain('serenaFirst');
    expect(ambiguous.stderr).toContain('serenaSecond');
  }, 240_000);
});
