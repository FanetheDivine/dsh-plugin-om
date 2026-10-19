// /om-compaction-eval 命令单元测试：命令定义、skill 文档路径解析、新会话首条消息文本、
// 建会话与投递入参、以及各错误分支（非主会话、缺 cwd、宿主无 sessionController、建会话或投递失败）。
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  buildCompactionEvalCommand,
  parseEvalModelInput,
  skillDocCandidates,
  skillDocPath,
} from '../src/compaction-eval-command.ts';
import {
  buildEvalPrompt,
  EVAL_COMMAND_DESCRIPTION,
  EVAL_COMMAND_NAME,
  evalStartedText,
  parseEvalSessionId,
} from '../src/eval-session-text.ts';
import type { Agent, Session } from '../src/types.ts';
import { makeCtx, makeSession } from './helpers.ts';

/** 仓库根目录（tests/ 的上一级）。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 发布产物入口的模块 URL（skill 文档首选位置的基准）。 */
const DIST_ENTRY = pathToFileURL(path.join(ROOT, 'dist', 'index.mjs')).href;

/** 造一个带 cwd 的主会话。 */
function mainSession(cwd = path.join(ROOT, 'workspace-a')) {
  return makeSession({ header: { cwd } });
}

/** 用给定 mock ctx 与会话执行一次命令（commandId 与 attachments 由宿主填充，测试无关）。 */
function invoke(ctx: ReturnType<typeof makeCtx>, session: Session, rawInput = '') {
  const command = buildCompactionEvalCommand(ctx);
  const invocation = {
    agent: { session } as Agent,
    rawInput,
    signal: new AbortController().signal,
  } as Parameters<typeof command.handler>[0];
  return command.handler(invocation);
}

describe('命令定义', () => {
  it('可选参数 provider/model [思考等级]、描述为 ai分析OM结果', () => {
    const ctx = makeCtx();
    const command = buildCompactionEvalCommand(ctx);
    expect(command.name).toBe(EVAL_COMMAND_NAME);
    expect(command.name).toBe('om-compaction-eval');
    expect(command.description).toBe(EVAL_COMMAND_DESCRIPTION);
    expect(command.description).toBe('ai分析OM结果');
    expect(command.input).toEqual({ hint: '[provider/model [思考等级]]' });
  });

  // 用例内首次导入 src/index.ts 在全量并行时可达数秒，超时放宽到 30s。
  it('apply 在 commands 服务可用时注册两个命令，缺失时不注册也不抛', async () => {
    const { apply } = await import('../src/index.ts');
    const mounted = makeCtx({
      commandsMounted: true,
      sessionControllerMounted: true,
      workspaces: [{ id: 'ws-1', path: '/ws', sessionIds: [] }],
    });
    apply(mounted, { rateLimitWaitMs: 0 });
    expect(mounted._registeredCommands.map((c) => c.name)).toEqual([
      'om-recompress',
      EVAL_COMMAND_NAME,
    ]);

    const missing = makeCtx();
    expect(() => apply(missing, { rateLimitWaitMs: 0 })).not.toThrow();
    expect(missing._registeredCommands).toEqual([]);
  }, 30000);
});

describe('skillDocCandidates / skillDocPath', () => {
  it('候选顺序为发布产物优先、仓库源码兜底', () => {
    expect(skillDocCandidates(DIST_ENTRY)).toEqual([
      path.join(ROOT, 'dist', 'skill', 'compaction-eval', 'SKILL.md'),
      path.join(ROOT, '.agents', 'skills', 'compaction-eval', 'SKILL.md'),
    ]);
  });

  it('返回第一个存在的候选；都不存在时 undefined', () => {
    const found = skillDocPath(DIST_ENTRY);
    expect(found).toBeDefined();
    expect(existsSync(found as string)).toBe(true);
    // 源码位置调用（vitest 下的 import.meta.url）同样能命中仓库内文档
    expect(skillDocPath()).toBe(
      path.join(ROOT, '.agents', 'skills', 'compaction-eval', 'SKILL.md'),
    );
    const empty = pathToFileURL(path.join(ROOT, 'dist', 'nothing', 'index.mjs')).href;
    expect(skillDocPath(empty)).toBeUndefined();
  });
});

describe('新会话首条消息文本', () => {
  it('给出文档路径、工作区路径与 id、会话 id', () => {
    expect(
      buildEvalPrompt({
        docPath: '/pkg/dist/skill/compaction-eval/SKILL.md',
        cwd: 'D:/ws/demo',
        workspaceId: 'ws-1',
        sessionId: 'session-abc',
      }),
    ).toBe(
      '按照 /pkg/dist/skill/compaction-eval/SKILL.md 分析会话。workspace D:/ws/demo workspace_id ws-1 session_id session-abc',
    );
  });

  it('没有工作区 id 时省略 workspace_id 段', () => {
    expect(buildEvalPrompt({ docPath: '/d/SKILL.md', cwd: '/ws', sessionId: 'session-abc' })).toBe(
      '按照 /d/SKILL.md 分析会话。workspace /ws session_id session-abc',
    );
  });

  it('成功文本可反解出新会话 id', () => {
    const text = evalStartedText('session-new');
    expect(text).toBe('已启动 OM 结果分析会话 session-new');
    expect(parseEvalSessionId(text)).toBe('session-new');
    expect(parseEvalSessionId('重压缩完成 字符 1 → 2')).toBeUndefined();
    expect(parseEvalSessionId('')).toBeUndefined();
  });
});

describe('parseEvalModelInput', () => {
  it('无参数沿用当前会话', () => {
    expect(parseEvalModelInput('')).toEqual({ ok: true, model: undefined });
    expect(parseEvalModelInput('  ')).toEqual({ ok: true, model: undefined });
  });

  it('按第一个斜杠切分 provider 与 model，可带思考等级', () => {
    expect(parseEvalModelInput('anthropic/claude-sonnet-4')).toEqual({
      ok: true,
      model: { provider: 'anthropic', model: 'claude-sonnet-4' },
    });
    expect(parseEvalModelInput(' openrouter/anthropic/claude  high ')).toEqual({
      ok: true,
      model: { provider: 'openrouter', model: 'anthropic/claude', reasoningEffort: 'high' },
    });
  });

  it('缺斜杠、provider 或 model 为空、多余参数时返回用法', () => {
    for (const raw of ['gpt-5', '/gpt-5', 'openai/', 'openai/gpt-5 high extra']) {
      const parsed = parseEvalModelInput(raw);
      expect(parsed.ok).toBe(false);
      expect(parsed.ok ? '' : parsed.error).toContain('用法');
    }
  });
});

describe('命令处理：建会话并投递首条消息', () => {
  it('当前会话属于某工作区时按 workspaceId 建会话，并继承 agentPreset', async () => {
    const cwd = path.join(ROOT, 'workspace-a');
    const session = makeSession({
      header: { cwd, agentPreset: 'preset-x' } as { cwd: string; origin?: 'subagent' },
    });
    const ctx = makeCtx({
      sessionControllerMounted: true,
      createdSessionId: 'session-child',
      workspaces: [
        { id: 'ws-other', path: cwd, sessionIds: ['session-elsewhere'] },
        { id: 'ws-1', path: cwd, sessionIds: ['test-session'] },
      ],
    });
    const result = await invoke(ctx, session);
    expect(result).toEqual({
      kind: 'success',
      text: '已启动 OM 结果分析会话 session-child',
    });
    expect(ctx._sessionCreations).toEqual([{ workspaceId: 'ws-1', agentPreset: 'preset-x' }]);
    const prompt = ctx._sessionPrompts[0] as {
      requestId: string;
      sessionId: string;
      mode: string;
      content: Array<{ type: string; text: string }>;
    };
    expect(prompt.sessionId).toBe('session-child');
    expect(prompt.mode).toBe('queue');
    expect(prompt.requestId.length).toBeGreaterThan(0);
    expect(prompt.content).toEqual([
      {
        type: 'text',
        text: buildEvalPrompt({
          docPath: skillDocPath() as string,
          cwd,
          workspaceId: 'ws-1',
          sessionId: 'test-session',
        }),
      },
    ]);
  });

  it('无参数时新会话沿用当前会话的 provider、model 与思考等级，先选模型再投递', async () => {
    const session = makeSession({
      header: { cwd: ROOT },
      requestHeaderValue: {
        config: { provider: 'anthropic', model: 'claude-x', reasoningEffort: 'high' },
      },
    });
    const ctx = makeCtx({ sessionControllerMounted: true, createdSessionId: 'session-child' });
    const result = await invoke(ctx, session);
    expect(result?.kind).toBe('success');
    expect(ctx._modelSelections).toEqual([
      {
        sessionId: 'session-child',
        provider: 'anthropic',
        model: 'claude-x',
        reasoningEffort: 'high',
      },
    ]);
    expect(ctx._sessionPrompts).toHaveLength(1);
  });

  it('当前会话无思考等级时选择不带等级', async () => {
    const ctx = makeCtx({ sessionControllerMounted: true });
    await invoke(ctx, mainSession());
    expect(ctx._modelSelections).toEqual([
      { sessionId: 'session-eval-child', provider: 'test', model: 'test-model' },
    ]);
  });

  it('参数指定模型时覆盖当前会话，不带等级则用模型默认', async () => {
    const session = makeSession({
      header: { cwd: ROOT },
      requestHeaderValue: {
        config: { provider: 'anthropic', model: 'claude-x', reasoningEffort: 'high' },
      },
    });
    const ctx = makeCtx({ sessionControllerMounted: true });
    await invoke(ctx, session, 'openai/gpt-5');
    await invoke(ctx, session, 'openai/gpt-5 low');
    expect(ctx._modelSelections).toEqual([
      { sessionId: 'session-eval-child', provider: 'openai', model: 'gpt-5' },
      {
        sessionId: 'session-eval-child',
        provider: 'openai',
        model: 'gpt-5',
        reasoningEffort: 'low',
      },
    ]);
  });

  it('参数格式错误时返回用法，不建会话', async () => {
    const ctx = makeCtx({ sessionControllerMounted: true });
    const result = await invoke(ctx, mainSession(), 'gpt-5');
    expect(result?.kind).toBe('error');
    expect(result?.text).toContain('用法');
    expect(ctx._sessionCreations).toEqual([]);
  });

  it('宿主拒绝所选模型时返回 error 且不投递首条消息', async () => {
    const ctx = makeCtx({
      sessionControllerMounted: true,
      selectThrows: new Error('model/not-found'),
    });
    const result = await invoke(ctx, mainSession(), 'openai/nope');
    expect(result?.kind).toBe('error');
    expect(result?.text).toContain('model/not-found');
    expect(ctx._sessionPrompts).toEqual([]);
  });

  it('宿主无 workspaceRegistry 或会话不属于任何工作区时按 cwd 建会话', async () => {
    const cwd = path.join(ROOT, 'workspace-b');
    const noRegistry = makeCtx({ sessionControllerMounted: true });
    await invoke(noRegistry, mainSession(cwd));
    expect(noRegistry._sessionCreations).toEqual([{ cwd }]);

    const unmatched = makeCtx({
      sessionControllerMounted: true,
      workspaces: [{ id: 'ws-1', path: cwd, sessionIds: ['session-elsewhere'] }],
    });
    await invoke(unmatched, mainSession(cwd));
    expect(unmatched._sessionCreations).toEqual([{ cwd }]);
    const prompt = unmatched._sessionPrompts[0] as { content: Array<{ text: string }> };
    expect(prompt.content[0]?.text).not.toContain('workspace_id');
  });

  it('非主会话与缺 cwd 时返回 error，不建会话', async () => {
    const ctx = makeCtx({ sessionControllerMounted: true });
    const subagent = makeSession({
      header: { cwd: ROOT, origin: 'subagent' } as { cwd: string; origin: 'subagent' },
    });
    const subResult = await invoke(ctx, subagent);
    expect(subResult?.kind).toBe('error');
    expect(subResult?.text).toContain('主会话');

    const noCwd = makeSession();
    const cwdResult = await invoke(ctx, noCwd);
    expect(cwdResult?.kind).toBe('error');
    expect(cwdResult?.text).toContain('工作区');
    expect(ctx._sessionCreations).toEqual([]);
    expect(ctx._sessionPrompts).toEqual([]);
  });

  it('宿主未提供 sessionController 时返回 error', async () => {
    const ctx = makeCtx();
    const result = await invoke(ctx, mainSession());
    expect(result?.kind).toBe('error');
    expect(result?.text).toContain('sessionController');
  });

  it('建会话或投递失败时返回 error 并带上原因', async () => {
    const createFailed = makeCtx({
      sessionControllerMounted: true,
      createThrows: new Error('workspace/not-found'),
    });
    const createResult = await invoke(createFailed, mainSession());
    expect(createResult?.kind).toBe('error');
    expect(createResult?.text).toContain('workspace/not-found');
    expect(createFailed._sessionPrompts).toEqual([]);

    const promptFailed = makeCtx({
      sessionControllerMounted: true,
      promptThrows: new Error('agent 已归档'),
    });
    const promptResult = await invoke(promptFailed, mainSession());
    expect(promptResult?.kind).toBe('error');
    expect(promptResult?.text).toContain('agent 已归档');
    expect(promptFailed._sessionCreations).toHaveLength(1);
  });
});
