// Serena CLI 真实行为测试：通过 uv 查询仓库 TypeScript 符号并清理测试实例。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/** 仓库根目录。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = mkdtempSync(path.join(tmpdir(), 'serena-query-state-'));
const LIVE_DIR = mkdtempSync(path.join(ROOT, 'tests/fixtures/serena-live-'));
const LIVE_REL = path.relative(ROOT, LIVE_DIR).replaceAll('\\', '/');
writeFileSync(
  path.join(LIVE_DIR, 'a.ts'),
  'export function serenaLiveGreet(): string { return "hello"; }\n',
);
writeFileSync(
  path.join(LIVE_DIR, 'b.ts'),
  'import { serenaLiveGreet } from "./a";\nexport const serenaLiveMessage = serenaLiveGreet();\n',
);

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
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', SERENA_CLI_STATE_DIR: STATE_DIR },
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
  afterAll(() => {
    runSerena('stop');
    rmSync(STATE_DIR, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    rmSync(LIVE_DIR, { recursive: true, force: true });
  }, 30_000);

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

  it('首次初始化只创建一套 TypeScript 语言服务器', () => {
    expectSuccess(runSerena('definition', 'serenaLiveGreet'));
    const name = readdirSync(STATE_DIR).find((entry) => entry.endsWith('.json'));
    if (!name) throw new Error('missing instance state');
    const state = JSON.parse(readFileSync(path.join(STATE_DIR, name), 'utf8')) as { pid: number };
    const probe = spawnSync(
      'uv',
      ['run', '--script', 'tests/serena-runtime.test.py', '--probe', String(state.pid)],
      {
        cwd: ROOT,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true,
      },
    );
    expectSuccess(probe);
    const tree = JSON.parse(probe.stdout) as { typescript_servers: number[] };
    expect(tree.typescript_servers).toHaveLength(1);
  }, 90_000);

  it('外部修改定义、增加和删除文件立即更新查询结果', () => {
    const references = () => {
      const result = runSerena('references', '--at', `${LIVE_REL}/a.ts:1`);
      expectSuccess(result);
      return result.stdout;
    };
    expect(references()).toContain(`${LIVE_REL}/b.ts`);
    writeFileSync(
      path.join(LIVE_DIR, 'a.ts'),
      'export function serenaLiveGreeting(): string { return "new hello"; }\n',
    );
    writeFileSync(
      path.join(LIVE_DIR, 'b.ts'),
      'import { serenaLiveGreeting } from "./a";\nexport const serenaLiveMessage = serenaLiveGreeting();\n',
    );
    const renamed = runSerena('definition', 'serenaLiveGreeting');
    expectSuccess(renamed);
    expect(parseOutput(renamed.stdout)).toContainEqual(
      expect.objectContaining({ name_path: 'serenaLiveGreeting' }),
    );
    const old = runSerena('definition', 'serenaLiveGreet');
    expectSuccess(old);
    expect(parseOutput(old.stdout)).toEqual([]);
    writeFileSync(
      path.join(LIVE_DIR, 'c.ts'),
      'import { serenaLiveGreeting } from "./a";\nexport const serenaLiveAgain = serenaLiveGreeting();\n',
    );
    const added = references();
    expect(added).toContain(`${LIVE_REL}/b.ts`);
    expect(added).toContain(`${LIVE_REL}/c.ts`);
    rmSync(path.join(LIVE_DIR, 'b.ts'));
    rmSync(path.join(LIVE_DIR, 'c.ts'));
    const removed = references();
    expect(removed).not.toContain(`${LIVE_REL}/b.ts`);
    expect(removed).not.toContain(`${LIVE_REL}/c.ts`);
  }, 120_000);

  it('跨工程与松散 JS/MJS 引用完整且不随查询顺序改变', () => {
    const refs = (name: string) => {
      const result = runSerena('references', name);
      expectSuccess(result);
      expect(result.stderr).not.toContain('retry');
      return Object.keys(parseOutput(result.stdout));
    };
    for (let round = 0; round < 2; round++) {
      expect(refs('buildTable')).toEqual(
        expect.arrayContaining(['web/src/App.tsx', 'tests/web/model.test.ts']),
      );
      expect(refs('planArchive')).toEqual(
        expect.arrayContaining(['scripts/release-archive.mjs', 'tests/release-archive.test.mjs']),
      );
      expect(refs('safeJson')).toContain('tests/utils.test.ts');
    }
    expect(refs('serenaFirst')).toEqual([]);
  }, 180_000);

  it('重复引用查询释放临时 JS 缓冲区，退出释放工程锚点', () => {
    const result = spawnSync(
      'uv',
      ['run', '--script', 'tests/serena-reference-lifecycle.test.py'],
      {
        cwd: ROOT,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        encoding: 'utf8',
        timeout: 120_000,
        windowsHide: true,
      },
    );
    expectSuccess(result);
    const output = JSON.parse(result.stdout) as {
      persistent_buffers: number;
      before: number;
      after: number;
    };
    expect(output.persistent_buffers).toBeGreaterThan(0);
    expect(output.after).toBe(output.before);
  }, 150_000);

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
