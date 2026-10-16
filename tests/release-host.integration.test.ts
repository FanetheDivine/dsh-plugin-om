// DSH 0.2 发布物集成：真实宿主工具、浏览器 bundle 与 npm 包内容。
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
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

/** 发布的 compaction-eval skill 目录（dist 内）。 */
const SKILL_DIST = path.join(ROOT, 'dist', 'skill', 'compaction-eval');

/** 仓库内 compaction-eval skill 源目录。 */
const SKILL_SOURCE = path.join(ROOT, '.agents', 'skills', 'compaction-eval');

/** 发布契约中的 skill 脚本产物名（tarball 路径）。写死而不由构建脚本推导：
 * 脚本改名或产物缺失时本测试必须报错，而不是跟着源头一起变。
 */
const SKILL_DIST_SCRIPTS = [
  'dist/skill/compaction-eval/scripts/prepare.mjs',
  'dist/skill/compaction-eval/scripts/view.mjs',
  'dist/skill/compaction-eval/scripts/compress.mjs',
  'dist/skill/compaction-eval/scripts/aggregate.mjs',
];

/** bundle 注册的 command/executed 监听回调形状（会话 id、命令名、宿主命令结果）。 */
type ExecutedListener = (
  sessionId: string,
  name: string,
  result: { kind: string; text?: string },
) => void;

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
    effect(register: () => (() => void) | undefined, label: string): void;
    on(type: string, listener: ExecutedListener): () => void;
    uiWorkspace: { openSession(target: string): void };
    locale: { register(namespace: string, dictionaries: object): void };
    uiConversation: { events: { register(definition: { kind: string }): void } };
    configForms: {
      get(id: string): object;
      whileServed(names: string[], register: () => () => void): () => void;
    };
    slots: {
      inject(slot: string, register: () => () => void): () => void;
      register(
        options: {
          key: string;
          inject?: () => { hooks: { omConfigCard: { getSnapshot(): { status: string } } } };
        },
        component: () => void,
      ): () => void;
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
    const platformModules = new Set([
      'react',
      'react/jsx-runtime',
      'react-dom',
      'react-dom/client',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-web-react',
      '@deepseek-ai/dsh-client-ui-primitives',
      '@deepseek-ai/dsh-client-ui-attachment',
      '@deepseek-ai/dsh-client-schema-form',
    ]);
    let disposed = 0;
    class FormModel {
      bind(project: () => object) {
        return { getSnapshot: project, subscribe: () => () => {} };
      }
      shell() {
        return {
          available: true,
          writable: true,
          dirty: false,
          invalid: false,
          saving: false,
          failed: false,
        };
      }
      field() {
        return { text: '', overridden: false, invalid: false };
      }
      actions() {
        return { edit: () => {}, resetField: () => {}, save: () => {}, discard: () => {} };
      }
      dispose() {
        disposed += 1;
      }
    }
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
            plugin = factory((moduleId) => {
              if (!platformModules.has(moduleId)) throw new Error(`未知宿主平台模块: ${moduleId}`);
              if (moduleId === '@deepseek-ai/dsh-client-ui-primitives')
                return {
                  DisclosureRow: () => null,
                  IconBrowseOutlineRegular: () => null,
                  SettingsForm: () => null,
                  SettingsValueField: () => null,
                  Checkbox: () => null,
                  SettingsFormModel: FormModel,
                  settingsTextField: (field: string) => ({ field }),
                };
              return nodeRequire(moduleId);
            });
          },
        },
      },
    });
    expect(loaded).toEqual(['dsh-plugin-om']);
    if (!plugin) throw new Error('client bundle 没有导出插件');
    const namespaces: string[] = [];
    const definitions: string[] = [];
    const renderers: string[] = [];
    const served: string[] = [];
    const scoped: string[] = [];
    const releases: Array<() => void> = [];
    /** bundle 注册的客户端事件监听（type + 回调）。 */
    const events: Array<{ type: string; fn: ExecutedListener }> = [];
    /** uiWorkspace.openSession 收到的跳转目标。 */
    const opened: string[] = [];
    let rowStatus: string | undefined;
    plugin.apply({
      effect: (register) => {
        const release = register();
        if (release) releases.push(release);
      },
      on: (type: string, fn: ExecutedListener) => {
        events.push({ type, fn });
        return () => {};
      },
      uiWorkspace: {
        openSession: (target: string) => {
          opened.push(target);
        },
      },
      locale: {
        register: (namespace) => {
          namespaces.push(namespace);
          return () => {};
        },
      },
      uiConversation: {
        events: {
          register: (definition) => {
            definitions.push(definition.kind);
            return () => {};
          },
        },
      },
      configForms: {
        get: (id) => {
          scoped.push(id);
          return {
            getSnapshot: () => ({
              status: 'ready',
              value: {},
              base: {},
              user: {},
              revision: 4,
              writable: true,
            }),
            subscribe: () => () => {},
            mutate: async () => true,
          };
        },
        whileServed: (names, register) => {
          served.push(...names);
          return register();
        },
      },
      slots: {
        inject: (_slot, register) => register(),
        register: (options) => {
          renderers.push(options.key);
          if (options.key === 'dsh-plugin-om#dsh-plugin-om')
            rowStatus = options.inject?.().hooks.omConfigCard.getSnapshot().status;
          return () => {};
        },
      },
    });
    expect(scoped).toEqual(['dsh-plugin-om']);
    expect(served).toEqual(['dsh-plugin-om']);
    expect(rowStatus).toBe('ready');
    // 发布的 bundle 内含 OM 结果评估跳转：监听 command/executed，只对本命令的成功结果跳转
    expect(events.map((item) => item.type)).toContain('command/executed');
    const jump = events.find((item) => item.type === 'command/executed');
    jump?.fn('s-1', 'om-compaction-eval', {
      kind: 'success',
      text: '已启动 OM 结果分析会话 session-new',
    });
    jump?.fn('s-1', 'om-recompress', { kind: 'success', text: '重压缩完成' });
    expect(opened).toEqual(['session-new']);
    for (const release of releases) release();
    expect(disposed).toBe(1);
    expect(plugin.inject).toEqual(
      expect.arrayContaining(['slots', 'uiConversation', 'locale', 'configForms']),
    );
    expect(namespaces).toHaveLength(1);
    expect(definitions).toHaveLength(2);
    expect(renderers).toEqual(['om-compaction', 'om-warning', 'dsh-plugin-om#dsh-plugin-om']);
    expect(installedVersion('dsh-client-ui-conversation')).toBe(RELEASE);
    expect(installedVersion('dsh-client-ui-settings')).toBe(RELEASE);
    expect(installedVersion('dsh-client-ui-plugin-manager')).toBe(RELEASE);
    const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      dsh: { client: { inject: string[] } };
    };
    expect(manifest.dsh.client.inject).toEqual(
      expect.arrayContaining([
        '@deepseek-ai/dsh-client-ui-settings',
        '@deepseek-ai/dsh-client-ui-plugin-manager',
      ]),
    );
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
      'dist/skill/compaction-eval/SKILL.md',
      'dist/skill/compaction-eval/references/rules.md',
      ...SKILL_DIST_SCRIPTS,
    ]) {
      expect(paths.has(file), file).toBe(true);
    }
    expect(installedVersion('dsh-agent')).toBe(RELEASE);
  }, 30_000);

  it('发布的 skill 文档改为发布版写法，references 原样复制', () => {
    const doc = readFileSync(path.join(SKILL_DIST, 'SKILL.md'), 'utf8');
    // 发布版脚本是自包含 .mjs：文档若残留 .ts 或类型转换标志，用户会照文档跑不存在的源码
    for (const name of ['prepare', 'view', 'compress', 'aggregate']) {
      expect(doc, `${name}.ts`).not.toContain(`${name}.ts`);
      expect(doc, `${name}.mjs`).toContain(`${name}.mjs`);
    }
    expect(doc).not.toContain('--experimental-transform-types');
    expect(doc).not.toContain('dev-only');
    expect(doc).not.toContain('pnpm install');
    for (const name of readdirSync(path.join(SKILL_SOURCE, 'references'))) {
      expect(readFileSync(path.join(SKILL_DIST, 'references', name), 'utf8')).toBe(
        readFileSync(path.join(SKILL_SOURCE, 'references', name), 'utf8'),
      );
    }
  }, 30_000);

  it('发布的 skill 脚本自包含且可执行：无参调用报用法错误而非空跑', () => {
    // 多出共享 chunk 说明多入口拆分复现：被共享的入口只剩转发壳，main() 守卫失效
    expect(readdirSync(path.join(SKILL_DIST, 'scripts')).sort()).toEqual([
      'aggregate.mjs',
      'compress.mjs',
      'prepare.mjs',
      'view.mjs',
    ]);
    for (const rel of SKILL_DIST_SCRIPTS) {
      const res = spawnSync(process.execPath, [path.join(ROOT, rel)], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 60_000,
      });
      const output = `${res.stderr}${res.stdout}`;
      // 能因参数缺失失败，说明 bundle 与 external（@deepseek-ai/*、zod）都解析成功
      expect(res.status, output).not.toBe(0);
      expect(output.trim().length, rel).toBeGreaterThan(0);
    }
    const usage = spawnSync(process.execPath, [path.join(SKILL_DIST, 'scripts', 'compress.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(usage.stderr).toContain('用法：compress.mjs');
  }, 120_000);
});
