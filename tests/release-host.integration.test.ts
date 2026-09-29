// DSH 0.2 发布物集成：真实宿主工具、浏览器 bundle 与 npm 包内容。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { Context } from '@deepseek-ai/cordis';
import { LlmRuntime, type MessageId, type ToolCallId } from '@deepseek-ai/dsh-llm';
import { type SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { TokenMeter } from '@deepseek-ai/dsh-token-meter';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = '0.2.0-rc.2';

/** 在项目根目录运行发布构建或 npm 打包命令。 */
function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

/** 读取实际测试时加载的宿主包版本。 */
function installedVersion(name: string): string {
  const pkg = JSON.parse(
    readFileSync(path.join(ROOT, 'node_modules', '@deepseek-ai', name, 'package.json'), 'utf8'),
  ) as { version: string };
  return pkg.version;
}

interface BrowserPlugin {
  inject: string[];
  apply(ctx: {
    effect(register: () => void, label: string): void;
    locale: { register(namespace: string, dictionaries: object): void };
    uiConversation: { events: { register(definition: { kind: string }): void } };
    slots: {
      inject(slot: string, register: () => void): void;
      register(options: { key: string }, component: () => void): void;
    };
  }): void;
}

describe('发布构建与 DSH 0.2 宿主集成', () => {
  beforeAll(() => {
    run('pnpm', ['build']);
  }, 120_000);

  it('发布的 Node 入口挂载真实宿主服务并通过 ToolRuntime 召回会话原文', async () => {
    const { name, inject, apply } = await import(
      pathToFileURL(path.join(ROOT, 'dist/index.mjs')).href
    );
    const app = new Context();
    try {
      await app.plugin(SessionStore);
      await app.plugin(SessionProjectionRegistry);
      await app.plugin(LlmRuntime);
      await app.plugin(TokenMeter);
      await app.plugin(SystemPrompt);
      await app.plugin(ToolRuntime);
      await app.plugin({ name, inject, apply }, { omEnabled: false, semanticRecallEnabled: false });
      const session = app.sessions.create('release-host-integration' as SessionId);
      session.append(
        'user/message',
        {
          id: 'release-original' as MessageId,
          role: 'user',
          content: [{ type: 'text', text: '发布物实际宿主集成原文' }],
          source: { kind: 'user' },
        },
        { surfaceOp: 'append' },
      );
      const result = await app.tools.execute({
        callId: 'release-recall' as ToolCallId,
        name: 'recall',
        arguments: { start: 0, end: 0 },
        agent: { session } as NonNullable<Parameters<typeof app.tools.execute>[0]['agent']>,
        signal: new AbortController().signal,
      });
      expect(result.isError).toBe(false);
      expect(result.content).toContainEqual(
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('发布物实际宿主集成原文'),
        }),
      );
      expect(installedVersion('dsh-tools')).toBe(RELEASE);
      expect(installedVersion('dsh-session')).toBe(RELEASE);
    } finally {
      await app.fiber.dispose();
    }
  }, 30_000);

  it('发布的浏览器 bundle 在模块加载器中注册，并由宿主注入服务注册卡片', () => {
    const source = readFileSync(path.join(ROOT, 'dist/client.js'), 'utf8');
    let plugin: BrowserPlugin | undefined;
    const loaded: string[] = [];
    const nodeRequire = createRequire(import.meta.url);
    runInNewContext(source, {
      window: {
        __ModuleLoader__: {
          load({
            id,
            factory,
          }: {
            id: string;
            factory: (require: (id: string) => object) => BrowserPlugin;
          }) {
            loaded.push(id);
            plugin = factory((moduleId) =>
              moduleId === '@deepseek-ai/dsh-client-ui-primitives'
                ? { DisclosureRow: () => null, IconBrowseOutlineRegular: () => null }
                : nodeRequire(moduleId),
            );
          },
        },
      },
    });
    expect(loaded).toEqual(['dsh-plugin-om']);
    if (!plugin) throw new Error('client bundle 没有导出插件');
    const namespaces: string[] = [];
    const definitions: string[] = [];
    const renderers: string[] = [];
    plugin.apply({
      effect: (register) => register(),
      locale: { register: (namespace) => namespaces.push(namespace) },
      uiConversation: { events: { register: (definition) => definitions.push(definition.kind) } },
      slots: {
        inject: (_slot, register) => register(),
        register: (options) => renderers.push(options.key),
      },
    });
    expect(plugin.inject).toEqual(expect.arrayContaining(['slots', 'uiConversation', 'locale']));
    expect(namespaces).toHaveLength(1);
    expect(definitions).toHaveLength(2);
    expect(renderers).toEqual(['om-compaction', 'om-warning']);
    expect(installedVersion('dsh-client-ui-conversation')).toBe(RELEASE);
  }, 30_000);

  it('npm 发布包包含可加载的 Node 与浏览器入口', () => {
    const report = JSON.parse(run('npm', ['pack', '--dry-run', '--json'])) as Array<{
      files: Array<{ path: string }>;
    }>;
    const paths = new Set(report.flatMap((item) => item.files.map((file) => file.path)));
    for (const file of [
      'dist/index.mjs',
      'dist/index.d.ts',
      'dist/client.js',
      'dist/client/index.d.ts',
    ]) {
      expect(paths.has(file), file).toBe(true);
    }
    expect(installedVersion('dsh-agent')).toBe(RELEASE);
  }, 30_000);
});
