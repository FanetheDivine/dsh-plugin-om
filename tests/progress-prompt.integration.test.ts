// 真实 Cordis、Loader 与 Agent 集成测试：验证进度规划提示的请求、组装、热更新及卸载行为。
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import {
  type Agent,
  type AgentHandle,
  AgentRegistry,
  assembleContextFor,
} from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import {
  createUserMessage,
  type GenerateOptions,
  LlmAdapter,
  LlmRuntime,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import { type SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { renderPrompt, SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { TokenMeter } from '@deepseek-ai/dsh-token-meter';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { describe, expect, it } from 'vitest';
import type { PluginConfig } from '../src/config.ts';
import { apply, Config, inject, name } from '../src/index.ts';

/** 主会话应收到的关键节点规划与结果说明。 */
const PROGRESS_GUIDANCE =
  '在任务推进的关键节点，简要输出后续规划，并在执行后说明对应结果；无需逐次播报工具调用。';

/** 仅回放模型回复；请求组装、会话和生命周期由真实宿主完成。 */
class RecordingAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = [];

  /** 记录真正到达模型边界的请求并结束当前回合。 */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options);
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '已完成当前任务。' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

/** 保持历史低于压缩阈值，禁用需要下载模型的召回功能。 */
function pluginConfig(omEnabled: boolean): Partial<PluginConfig> {
  return {
    omEnabled,
    observeThresholdTokens: 1000000,
    reflectThresholdTokens: 1000000,
    recallEnabled: false,
    semanticRecallEnabled: false,
    debug: false,
  };
}

/** 用真实 Loader 加载插件，并创建可由 inbox 驱动的主 Agent。 */
async function stackPromptHost(omEnabled: boolean) {
  const app = new Context();
  let handle: AgentHandle | undefined;
  try {
    await app.plugin(SessionStore);
    await app.plugin(SessionProjectionRegistry);
    await app.plugin(LlmRuntime);
    await app.plugin(TokenMeter);
    await app.plugin(SystemPrompt);
    await app.plugin(ToolRuntime);
    await app.plugin(AgentRegistry);
    await app.plugin(AgentLoop);
    await app.plugin(Loader);
    const adapter = new RecordingAdapter();
    app.llm.registerAdapter(['mock'], adapter);
    app.loader.builtins[name] = { name, inject, Config, apply };
    const entryId = await app.loader.create({
      name: `cordis:${name}`,
      config: pluginConfig(omEnabled),
    });
    await app.loader.await();
    const entry = app.loader.resolve(entryId);
    if (!entry.fiber) throw new Error('Loader 未创建 OM 插件 fiber');
    await entry.fiber.await();
    entry.fiber.assertActive();
    handle = await app.agents.create({
      sessionId: 'it-progress-main' as SessionId,
      agentOptions: { provider: 'mock', model: 'mock-model' },
    });
    return { app, adapter, entry, handle };
  } catch (error) {
    await handle?.dispose();
    await app.fiber.dispose();
    throw error;
  }
}

/** 使用宿主的 Agent/scope 绑定上下文进行真实组装与渲染。 */
async function assembledSystem(app: Context, agent: Agent): Promise<string> {
  return renderPrompt(await app.systemPrompt.assemble(assembleContextFor(agent)));
}

/** 普通 Agent 请求的系统提示来自 system-role 消息，不使用一次性请求的 system 字段。 */
function requestSystem(request: GenerateOptions): string {
  return request.messages
    .filter((message) => message.role === 'system')
    .flatMap((message) => message.content)
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n');
}

/** 交给真实 inbox 运行一轮，并读取该 Agent 新产生的唯一模型请求。 */
async function runTurn(adapter: RecordingAdapter, agent: Agent, text: string) {
  const before = adapter.calls.length;
  agent.followup(
    createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  );
  await agent.whenIdle();
  const calls = adapter.calls.slice(before);
  expect(calls).toHaveLength(1);
  const request = calls[0];
  if (!request) throw new Error('真实 Agent 没有产生模型请求');
  expect(request.sessionId).toBe(agent.session.id);
  expect(request.purpose).toBeUndefined();
  expect(request.provider).toBe('mock');
  expect(request.model).toBe('mock-model');
  return request;
}

/** 按完整句计数，同时验证宿主身份提示仍存在。 */
function expectGuidance(system: string, enabled: boolean): void {
  expect(system).toContain('You are an AI agent powered by DeepSeek Harness.');
  expect(system.split(PROGRESS_GUIDANCE).length - 1).toBe(enabled ? 1 : 0);
}

describe('进度规划提示的真实宿主集成', () => {
  it.each([true, false])('omEnabled=%s 时主会话组装和实际模型请求一致', async (enabled) => {
    const { app, adapter, handle } = await stackPromptHost(enabled);
    try {
      expectGuidance(await assembledSystem(app, handle.agent), enabled);
      const request = await runTurn(adapter, handle.agent, '请完成一个简短任务。');
      expectGuidance(requestSystem(request), enabled);
    } finally {
      await handle.dispose();
      await app.fiber.dispose();
    }
  });

  it('完整 scoped 系统提示词预设保持原文，不追加进度规划提示', async () => {
    const { app, adapter, handle } = await stackPromptHost(true);
    try {
      handle.agent.ctx.systemPrompt.section({
        name: 'test:complete-preset',
        order: app.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
        text: '完整系统提示词预设',
        complete: true,
      });
      expect(await assembledSystem(app, handle.agent)).toBe('完整系统提示词预设');
      const request = await runTurn(adapter, handle.agent, '按完整预设执行任务。');
      expect(requestSystem(request)).toBe('完整系统提示词预设');
    } finally {
      await handle.dispose();
      await app.fiber.dispose();
    }
  });

  it('启用 OM 时真实子会话不包含提示，主会话仍包含', async () => {
    const { app, adapter, handle } = await stackPromptHost(true);
    let child: AgentHandle | undefined;
    try {
      child = await handle.agent.ctx.agents.create({
        sessionId: 'it-progress-child' as SessionId,
        parentAgent: handle.agent,
        meta: {
          parentSession: handle.agent.session.id,
          origin: 'subagent',
          delegationDepth: 1,
        },
        agentOptions: { provider: 'mock', model: 'mock-model' },
      });
      expect(child.agent.session.header.origin).toBe('subagent');
      expect(child.agent.session.header.parentSession).toBe(handle.agent.session.id);
      expectGuidance(await assembledSystem(app, child.agent), false);
      const childRequest = await runTurn(adapter, child.agent, '执行委派任务。');
      expectGuidance(requestSystem(childRequest), false);
      expectGuidance(await assembledSystem(app, handle.agent), true);
      const mainRequest = await runTurn(adapter, handle.agent, '汇总主会话任务。');
      expectGuidance(requestSystem(mainRequest), true);
    } finally {
      await child?.dispose();
      await handle.dispose();
      await app.fiber.dispose();
    }
  });

  it.each([true, false])(
    'Loader volatile 从 %s 反复切换，立即更新同一 Agent 的组装和新模型请求',
    async (initial) => {
      const { app, adapter, entry, handle } = await stackPromptHost(initial);
      try {
        const fiber = entry.fiber;
        if (!fiber) throw new Error('缺少 OM 插件 fiber');
        const config = fiber.config as ReturnType<typeof Config>;
        const state = fiber.state;
        for (const [index, enabled] of [initial, !initial, initial, !initial].entries()) {
          if (index > 0) {
            await entry.update({ config: pluginConfig(enabled) });
            await app.loader.await();
            const updated = entry.fiber;
            if (!updated) throw new Error('热更新丢失 OM 插件 fiber');
            expect(updated).toBe(fiber);
            expect(updated.config).toBe(config);
            expect(config.omEnabled.get()).toBe(enabled);
            expect(updated.state).toBe(state);
          }
          expectGuidance(await assembledSystem(app, handle.agent), enabled);
          const request = await runTurn(adapter, handle.agent, `第 ${index + 1} 轮任务。`);
          expectGuidance(requestSystem(request), enabled);
        }
      } finally {
        await handle.dispose();
        await app.fiber.dispose();
      }
    },
  );

  it('同一主会话重复组装与请求不叠加提示，已组装结果不被后续组装修改', async () => {
    const { app, adapter, handle } = await stackPromptHost(true);
    try {
      const first = await app.systemPrompt.assemble(assembleContextFor(handle.agent));
      const firstSystem = renderPrompt(first);
      for (let index = 0; index < 3; index += 1) {
        expectGuidance(await assembledSystem(app, handle.agent), true);
        const request = await runTurn(adapter, handle.agent, `重复组装任务 ${index}。`);
        expectGuidance(requestSystem(request), true);
        expect(renderPrompt(first)).toBe(firstSystem);
      }
      expectGuidance(firstSystem, true);
    } finally {
      await handle.dispose();
      await app.fiber.dispose();
    }
  });

  it('Loader 卸载插件后清除现有主 Agent 的组装和后续请求提示', async () => {
    const { app, adapter, entry, handle } = await stackPromptHost(true);
    try {
      const before = await runTurn(adapter, handle.agent, '插件卸载前的任务。');
      expectGuidance(requestSystem(before), true);
      const fiber = entry.fiber;
      if (!fiber) throw new Error('缺少待卸载的 OM 插件 fiber');
      app.loader.remove(entry.id);
      await fiber.dispose();
      expectGuidance(await assembledSystem(app, handle.agent), false);
      const after = await runTurn(adapter, handle.agent, '插件卸载后的任务。');
      expectGuidance(requestSystem(after), false);
    } finally {
      await handle.dispose();
      await app.fiber.dispose();
    }
  });
});
