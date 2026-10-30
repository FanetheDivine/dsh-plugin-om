// Serena 项目级常驻实例测试：复用、并发启动、安全防护、生命周期与单进程回退。
import { type ChildProcess, execFile, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = mkdtempSync(path.join(tmpdir(), 'serena-daemon-state-'));
const BASE_ENV = {
  ...process.env,
  PYTHONDONTWRITEBYTECODE: '1',
  SERENA_CLI_STATE_DIR: STATE_DIR,
};

/** 实例磁盘状态；token 仅供本机测试请求使用。 */
interface InstanceState {
  root: string;
  pid: number;
  port: number;
  token: string;
  build: string;
}

/** HTTP 测试结果。 */
interface TestResponse {
  status: number;
  body: Record<string, unknown>;
}

/** 执行项目 Serena CLI。 */
function runCli(args: string[], cwd = ROOT, env: NodeJS.ProcessEnv = {}) {
  return spawnSync('uv', ['run', '--script', path.join(ROOT, 'scripts/serena-cli.py'), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...BASE_ENV, ...env },
    maxBuffer: 5 * 1024 * 1024,
    timeout: 120_000,
    windowsHide: true,
  });
}

/** 断言 CLI 成功并保留错误输出。 */
function expectSuccess(result: ReturnType<typeof runCli>) {
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(0);
}

/** 读取指定项目的实例状态。 */
function readState(root: string, stateDir = STATE_DIR): InstanceState | null {
  if (!existsSync(stateDir)) return null;
  for (const name of readdirSync(stateDir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const state = JSON.parse(readFileSync(path.join(stateDir, name), 'utf8')) as InstanceState;
      if (path.resolve(state.root) === path.resolve(root)) return state;
    } catch {
      // 原子替换期间忽略不完整或已删除的状态文件。
    }
  }
  return null;
}

/** 等待实例状态出现。 */
async function waitForState(root: string, stateDir = STATE_DIR): Promise<InstanceState> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = readState(root, stateDir);
    if (state) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`instance state did not appear for ${root}`);
}

/** 等待实例状态消失。 */
async function waitForStopped(root: string, stateDir = STATE_DIR): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!readState(root, stateDir)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`instance did not stop for ${root}`);
}

/** 直接请求回环实例，模拟合法客户端和恶意网页。 */
function request(
  state: InstanceState,
  method: string,
  route: string,
  options: { token?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const headers = { ...options.headers };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.body !== undefined)
      headers['Content-Length'] = String(Buffer.byteLength(options.body));
    const outgoing = http.request(
      { host: '127.0.0.1', port: state.port, method, path: route, headers },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (text += chunk));
        response.on('end', () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(text) as Record<string, unknown>,
            });
          } catch {
            resolve({ status: response.statusCode ?? 0, body: { raw: text } });
          }
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.setTimeout(5_000, () => outgoing.destroy(new Error('request timed out')));
    if (options.body) outgoing.write(options.body);
    outgoing.end();
  });
}

/** 发送可暂停的 JSON 请求，用于覆盖活动请求与优雅退出。 */
function delayedRequest(state: InstanceState) {
  let finish!: () => void;
  const finished = new Promise<TestResponse>((resolve, reject) => {
    const outgoing = http.request(
      {
        host: '127.0.0.1',
        port: state.port,
        method: 'POST',
        path: '/query',
        headers: {
          Authorization: `Bearer ${state.token}`,
          'Content-Type': 'application/json',
          'Content-Length': '2',
        },
      },
      (incoming) => {
        let text = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk: string) => (text += chunk));
        incoming.on('end', () =>
          resolve({
            status: incoming.statusCode ?? 0,
            body: JSON.parse(text) as Record<string, unknown>,
          }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.setTimeout(10_000, () => outgoing.destroy(new Error('delayed request timed out')));
    outgoing.write('{');
    finish = () => outgoing.end('}');
  });
  return { finished, finish };
}

/** 启动一个绑定空项目的内部服务，不创建 SerenaAgent。 */
function startInternal(root: string, stateDir = STATE_DIR, idleTimeout?: string): ChildProcess {
  const log = openSync(path.join(stateDir, `internal-${process.pid}-${Date.now()}.log`), 'a');
  const child = spawn(
    'uv',
    ['run', '--script', path.join(ROOT, 'scripts/serena-cli.py'), '_serve', '--root', root],
    {
      cwd: ROOT,
      env: {
        ...BASE_ENV,
        SERENA_CLI_STATE_DIR: stateDir,
        ...(idleTimeout ? { SERENA_CLI_IDLE_TIMEOUT: idleTimeout } : {}),
      },
      stdio: ['ignore', log, log],
      windowsHide: true,
    },
  );
  closeSync(log);
  return child;
}

/** 通过公开 stop 命令停止内部测试服务。 */
async function stopInternal(
  root: string,
  child: ChildProcess,
  stateDir = STATE_DIR,
): Promise<void> {
  if (child.exitCode === null && readState(root, stateDir)) {
    const result = runCli(['stop'], root, { SERENA_CLI_STATE_DIR: stateDir });
    expectSuccess(result);
  }
  if (child.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  if (child.exitCode === null) child.kill();
}

describe('Serena 项目常驻实例', () => {
  beforeAll(() => {
    const result = runCli(['definition', 'formatTokens']);
    expectSuccess(result);
  }, 180_000);

  afterAll(() => {
    runCli(['stop']);
    rmSync(STATE_DIR, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }, 30_000);

  it('复用同一实例并提供 JSON 状态', () => {
    const first = readState(ROOT);
    expect(first).not.toBeNull();
    const again = runCli(['doc', '--at', 'web/src/format.ts:13']);
    expectSuccess(again);
    expect(readState(ROOT)?.pid).toBe(first?.pid);

    const status = runCli(['status']);
    expectSuccess(status);
    const value = JSON.parse(status.stdout) as Record<string, unknown>;
    expect(value).toMatchObject({ status: 'running', pid: first?.pid, root: ROOT });
    expect(value).not.toHaveProperty('token');
  }, 180_000);

  it('拒绝未鉴权、跨源、伪造 Host 和非 JSON 请求', async () => {
    const state = readState(ROOT);
    expect(state).not.toBeNull();
    if (!state) return;

    expect((await request(state, 'GET', '/heartbeat')).status).toBe(401);
    expect((await request(state, 'GET', '/heartbeat', { token: randomUUID() })).status).toBe(401);
    expect((await request(state, 'GET', '/heartbeat', { token: state.token })).status).toBe(200);
    expect(
      (
        await request(state, 'GET', '/heartbeat', {
          token: state.token,
          headers: { Host: `rebind.invalid:${state.port}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(state, 'GET', '/heartbeat', {
          token: state.token,
          headers: { Origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(state, 'POST', '/query', {
          token: state.token,
          headers: { 'Content-Type': 'text/plain' },
          body: '{}',
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await request(state, 'POST', '/query', {
          token: state.token,
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        })
      ).status,
    ).toBe(400);
    const fixedRoot = await request(state, 'POST', '/query', {
      token: state.token,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        root: 'C:/',
        command: 'definition',
        name_path: 'formatTokens',
        relative_path: null,
        line: null,
        max_chars: 20_000,
      }),
    });
    expect(fixedRoot.status, JSON.stringify(fixedRoot.body)).toBe(200);
    expect(JSON.parse(String(fixedRoot.body.output))).toContainEqual(
      expect.objectContaining({
        relative_path: expect.stringMatching(/web[\\/]src[\\/]format\.ts/),
      }),
    );
    const outside = await request(state, 'POST', '/query', {
      token: state.token,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'doc',
        name_path: null,
        relative_path: '../outside.ts',
        line: 1,
        max_chars: 20_000,
      }),
    });
    expect(outside.status).toBe(400);
  }, 30_000);

  it('stop 幂等且停止后 status 为 stopped', async () => {
    const stopped = runCli(['stop']);
    expectSuccess(stopped);
    expect(JSON.parse(stopped.stdout)).toEqual({ status: 'stopped' });
    await waitForStopped(ROOT);

    expectSuccess(runCli(['stop']));
    const status = runCli(['status']);
    expectSuccess(status);
    expect(JSON.parse(status.stdout)).toEqual({ status: 'stopped' });
  }, 30_000);

  it('不同项目使用不同实例，停止一个不影响另一个', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'serena-isolation-state-'));
    const firstRoot = mkdtempSync(path.join(tmpdir(), 'serena-first-project-'));
    const secondRoot = mkdtempSync(path.join(tmpdir(), 'serena-second-project-'));
    const first = startInternal(firstRoot, stateDir);
    const second = startInternal(secondRoot, stateDir);
    try {
      const [firstState, secondState] = await Promise.all([
        waitForState(firstRoot, stateDir),
        waitForState(secondRoot, stateDir),
      ]);
      expect(firstState.pid).not.toBe(secondState.pid);
      await stopInternal(firstRoot, first, stateDir);
      await waitForStopped(firstRoot, stateDir);
      expect(
        (await request(secondState, 'GET', '/heartbeat', { token: secondState.token })).status,
      ).toBe(200);
    } finally {
      await Promise.all([
        stopInternal(firstRoot, first, stateDir),
        stopInternal(secondRoot, second, stateDir),
      ]);
      rmSync(stateDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      rmSync(firstRoot, { recursive: true, force: true });
      rmSync(secondRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it('空闲超时和项目目录删除都会触发退出', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'serena-timeout-state-'));
    const idleRoot = mkdtempSync(path.join(tmpdir(), 'serena-idle-project-'));
    const deletedRoot = mkdtempSync(path.join(tmpdir(), 'serena-deleted-project-'));
    const idle = startInternal(idleRoot, stateDir, '1');
    const deleted = startInternal(deletedRoot, stateDir, '60');
    try {
      await Promise.all([waitForState(idleRoot, stateDir), waitForState(deletedRoot, stateDir)]);
      rmSync(deletedRoot, { recursive: true });
      await Promise.all([
        waitForStopped(idleRoot, stateDir),
        waitForStopped(deletedRoot, stateDir),
      ]);
    } finally {
      await Promise.all([
        stopInternal(idleRoot, idle, stateDir),
        stopInternal(deletedRoot, deleted, stateDir),
      ]);
      rmSync(stateDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      rmSync(idleRoot, { recursive: true, force: true });
      rmSync(deletedRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it('活动请求不按空闲退出，停止等待响应完整发送', async () => {
    const idleDir = mkdtempSync(path.join(tmpdir(), 'serena-active-idle-state-'));
    const idleRoot = mkdtempSync(path.join(tmpdir(), 'serena-active-idle-project-'));
    const idle = startInternal(idleRoot, idleDir, '1');
    try {
      const state = await waitForState(idleRoot, idleDir);
      const active = delayedRequest(state);
      await new Promise((resolve) => setTimeout(resolve, 1_400));
      expect((await request(state, 'GET', '/heartbeat', { token: state.token })).status).toBe(200);
      active.finish();
      expect((await active.finished).status).toBe(400);
      await waitForStopped(idleRoot, idleDir);
    } finally {
      await stopInternal(idleRoot, idle, idleDir);
      rmSync(idleDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      rmSync(idleRoot, { recursive: true, force: true });
    }

    const stopDir = mkdtempSync(path.join(tmpdir(), 'serena-active-stop-state-'));
    const stopRoot = mkdtempSync(path.join(tmpdir(), 'serena-active-stop-project-'));
    const child = startInternal(stopRoot, stopDir, '60');
    try {
      const state = await waitForState(stopRoot, stopDir);
      const active = delayedRequest(state);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const stopping = execFileAsync(
        'uv',
        ['run', '--script', path.join(ROOT, 'scripts/serena-cli.py'), 'stop'],
        { cwd: stopRoot, env: { ...BASE_ENV, SERENA_CLI_STATE_DIR: stopDir }, windowsHide: true },
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(readState(stopRoot, stopDir)?.pid).toBe(state.pid);
      active.finish();
      expect((await active.finished).status).toBe(400);
      await stopping;
      await waitForStopped(stopRoot, stopDir);
      expectSuccess(runCli(['stop'], stopRoot, { SERENA_CLI_STATE_DIR: stopDir }));
    } finally {
      await stopInternal(stopRoot, child, stopDir);
      rmSync(stopDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      rmSync(stopRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it('不完整 HTTP 头不会永久阻塞实例退出', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'serena-half-open-state-'));
    const root = mkdtempSync(path.join(tmpdir(), 'serena-half-open-project-'));
    const child = startInternal(root, stateDir, '60');
    let socket: net.Socket | undefined;
    try {
      const state = await waitForState(root, stateDir);
      socket = net.connect(state.port, '127.0.0.1');
      await new Promise<void>((resolve, reject) => {
        socket?.once('connect', resolve);
        socket?.once('error', reject);
      });
      socket.write('POST /query HTTP/1.1\r\n');
      await execFileAsync(
        'uv',
        ['run', '--script', path.join(ROOT, 'scripts/serena-cli.py'), 'stop'],
        {
          cwd: root,
          env: { ...BASE_ENV, SERENA_CLI_STATE_DIR: stateDir },
          timeout: 20_000,
          windowsHide: true,
        },
      );
      await waitForStopped(root, stateDir);
    } finally {
      socket?.destroy();
      await stopInternal(root, child, stateDir);
      rmSync(stateDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);

  it('启动与查询传输失败遵守回退边界', () => {
    expectSuccess(
      spawnSync('uv', ['run', '--script', 'tests/serena-runtime.test.py'], {
        cwd: ROOT,
        env: BASE_ENV,
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true,
      }),
    );
  }, 70_000);

  it('显式单进程模式和启动失败回退都不留下实例', () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'serena-fallback-state-'));
    try {
      const direct = runCli(['--no-daemon', 'definition', 'formatTokens'], ROOT, {
        SERENA_CLI_STATE_DIR: stateDir,
      });
      expectSuccess(direct);
      expect(readState(ROOT, stateDir)).toBeNull();

      const environmentDirect = runCli(['definition', 'formatTokens'], ROOT, {
        SERENA_CLI_DAEMON: '0',
        SERENA_CLI_STATE_DIR: stateDir,
      });
      expectSuccess(environmentDirect);
      expect(readState(ROOT, stateDir)).toBeNull();

      const fallback = runCli(['definition', 'formatTokens'], ROOT, {
        SERENA_CLI_START_TIMEOUT: '0.01',
        SERENA_CLI_STATE_DIR: stateDir,
      });
      expectSuccess(fallback);
      expect(fallback.stderr).toContain('daemon unavailable');
      expect(readState(ROOT, stateDir)).toBeNull();

      const blockedState = path.join(stateDir, 'not-a-directory');
      writeFileSync(blockedState, 'file');
      const osFallback = runCli(['definition', 'formatTokens'], ROOT, {
        SERENA_CLI_STATE_DIR: blockedState,
      });
      expectSuccess(osFallback);
      expect(osFallback.stderr).toContain('daemon unavailable');
      expect(readState(ROOT, stateDir)).toBeNull();
    } finally {
      runCli(['stop'], ROOT, { SERENA_CLI_STATE_DIR: stateDir });
      rmSync(stateDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 240_000);

  it('并发首次查询只创建一个项目实例', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'serena-concurrent-state-'));
    const command = [
      'run',
      '--script',
      path.join(ROOT, 'scripts/serena-cli.py'),
      'definition',
      'formatTokens',
    ];
    try {
      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          execFileAsync('uv', command, {
            cwd: ROOT,
            env: { ...BASE_ENV, SERENA_CLI_STATE_DIR: stateDir },
            encoding: 'utf8',
            maxBuffer: 5 * 1024 * 1024,
            timeout: 120_000,
            windowsHide: true,
          }),
        ),
      );
      for (const result of results) expect(result.stdout).toContain('formatTokens');
      const state = readState(ROOT, stateDir);
      expect(state).not.toBeNull();
      const status = runCli(['status'], ROOT, { SERENA_CLI_STATE_DIR: stateDir });
      expect(JSON.parse(status.stdout)).toMatchObject({ pid: state?.pid });
    } finally {
      runCli(['stop'], ROOT, { SERENA_CLI_STATE_DIR: stateDir });
      rmSync(stateDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 180_000);
});
