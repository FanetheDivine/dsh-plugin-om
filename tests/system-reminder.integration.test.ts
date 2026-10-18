// 真实 Cordis、Loader 与 Agent 集成测试：验证进度提醒作为 system-reminder
// 用户消息进入请求，且不修改系统提示词；覆盖开关、召回工具描述、子会话、热更新、重复请求、
// 工具 step 自动重发、文本重置、压缩遮蔽与卸载行为。
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
  type ContentBlock,
  createUserMessage,
  type GenerateOptions,
  LlmAdapter,
  LlmRuntime,
  type StreamChunk,
  type ToolCallId,
} from '@deepseek-ai/dsh-llm';
import { type SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { renderPrompt, SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { TokenMeter } from '@deepseek-ai/dsh-token-meter';
import { defineTool, ToolRuntime } from '@deepseek-ai/dsh-tools';
import { describe, expect, it } from 'vitest';
import type { PluginConfig } from '../src/config.ts';
import { COMPLETE_MESSAGE_DEFINITION } from '../src/constants.ts';
import { apply, Config, inject, name } from '../src/index.ts';
import { PROGRESS_REMINDER, type SystemReminder } from '../src/system-reminder.ts';

/** 回放指定顶层内容，工具调用由真实 ToolRuntime 接手。 */
function modelReply(content: ContentBlock[]): StreamChunk[] {
  return [
    ...content.map((block, index): StreamChunk => ({ type: 'block-end', index, block })),
    {
      type: 'finish',
      reason: { kind: content.some((block) => block.type === 'tool-call') ? 'tool-calls' : 'stop' },
    },
  ];
}

/** 每个工具 step 都带 reasoning；只有显式传入的顶层 text 才能重置进度。 */
function toolStep(step: number, count: number, text?: string): StreamChunk[] {
  return modelReply([
    { type: 'reasoning', text: '已经分析工具结果，继续执行下一步。' },
    ...(text === undefined ? [] : [{ type: 'text' as const, text }]),
    ...Array.from(
      { length: count },
      (_, index): ContentBlock => ({
        type: 'tool-call',
        id: `progress-${step}-${index}` as ToolCallId,
        name: 'progressProbe',
        arguments: JSON.stringify({ label: `${step}:${index}` }),
      }),
    ),
  ]);
}

/** 仅回放模型回复；请求组装、会话和生命周期由真实宿主完成。 */
class RecordingAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = [];

  constructor(private readonly script: readonly (readonly StreamChunk[])[] = []) {
    super();
  }

  /** 记录模型边界请求，按脚本回放；未配置脚本时结束当前回合。 */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const index = this.calls.length;
    this.calls.push(options);
    if (this.script.length === 0) {
      yield* modelReply([{ type: 'text', text: '已完成当前任务。' }]);
      return;
    }
    const reply = this.script[index];
    if (!reply) throw new Error(`非预期的模型请求：${index + 1}`);
    yield* reply;
  }
}

/** 保持历史低于压缩阈值，禁用需要下载模型的语义增强。 */
function pluginConfig(
  omEnabled: boolean,
  extra: Partial<PluginConfig> = {},
): Partial<PluginConfig> {
  return {
    omEnabled,
    observeThresholdTokens: 1000000,
    reflectThresholdTokens: 1000000,
    semanticRecallEnabled: false,
    debug: false,
    ...extra,
  };
}

/** 用真实 Loader 加载插件，并创建可由 inbox 驱动的主 Agent。 */
async function stackPromptHost(
  omEnabled: boolean,
  script: readonly (readonly StreamChunk[])[] = [],
  extra: Partial<PluginConfig> = {},
) {
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
    const adapter = new RecordingAdapter(script);
    const toolRuns: string[] = [];
    if (script.length > 0) {
      app.tools.register(
        defineTool({
          name: 'progressProbe',
          description: '回放测试中的无外部副作用工具。',
          parameters: { label: { type: 'string', required: true } },
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
          },
          async execute({ label }, exec) {
            exec.signal.throwIfAborted();
            toolRuns.push(label);
            exec.deferContext(
              createUserMessage({
                content: [{ type: 'text', text: '工具附加上下文不替代模型进度记录。' }],
                source: { kind: 'plugin:dsh-plugin-om' },
              }),
            );
            return `工具结果 ${label}：已经取得中间结论并规划下一步。`;
          },
        }),
      );
    }
    app.llm.registerAdapter(['mock'], adapter);
    app.loader.builtins[name] = { name, inject, Config, apply };
    const entryId = await app.loader.create({
      name: `cordis:${name}`,
      config: pluginConfig(omEnabled, extra),
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
    return { app, adapter, entry, handle, toolRuns };
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

/** 条件 2 预期送达的提醒，保持同一个 source kind。 */
const urgentReminder: SystemReminder = {
  kind: PROGRESS_REMINDER.kind,
  text: PROGRESS_REMINDER.text.replace(
    '\n</system-reminder>',
    '\n你应当*立刻*输出一条记录\n</system-reminder>',
  ),
};

/** 请求中作为 user 消息出现的指定提醒数量（缺省为进度提醒）。 */
function requestReminders(request: GenerateOptions, reminder = PROGRESS_REMINDER): number {
  return request.messages.filter(
    (message) =>
      message.role === 'user' &&
      message.content.some((block) => block.type === 'text' && block.text === reminder.text),
  ).length;
}

/** 会话日志中指定提醒消息事件的数量（缺省为进度提醒）。 */
function loggedReminders(agent: Agent, reminder: SystemReminder = PROGRESS_REMINDER): number {
  return agent.session
    .snapshotEvents()
    .filter((event) => event.type === 'user/message' && event.data.source.kind === reminder.kind)
    .length;
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

/** 验证回放完整通过宿主 step 生命周期与真实工具运行时。 */
function expectCompletedToolLoop(
  agent: Agent,
  adapter: RecordingAdapter,
  toolRuns: readonly string[],
  requests: number,
  tools: number,
): void {
  expect(adapter.calls).toHaveLength(requests);
  expect(toolRuns).toHaveLength(tools);
  expect(new Set(toolRuns).size).toBe(tools);
  const events = agent.session.snapshotEvents();
  expect(events.filter((event) => event.type === 'step/end').map((event) => event.data)).toEqual(
    Array.from({ length: requests }, (_, index) => ({ turn: 1, step: index + 1 })),
  );
  const results = events.filter((event) => event.type === 'tool/result');
  expect(results).toHaveLength(tools);
  expect(results.every((event) => !event.data.message.isError)).toBe(true);
  expect(events.filter((event) => event.type === 'turn/end').map((event) => event.data)).toEqual([
    { turn: 1, reason: { kind: 'completed' } },
  ]);
  for (const request of adapter.calls) {
    expect(request.sessionId).toBe(agent.session.id);
    expect(request.purpose).toBeUndefined();
    expect(request.tools?.some((tool) => tool.name === 'progressProbe')).toBe(true);
    expectSystemUntouched(requestSystem(request));
  }
}

/** 系统提示词保持宿主原文，不含任何提醒文本。 */
function expectSystemUntouched(system: string): void {
  expect(system).toContain('You are an AI agent powered by DeepSeek Harness.');
  expect(system).not.toContain(PROGRESS_REMINDER.text);
  expect(system).not.toContain(COMPLETE_MESSAGE_DEFINITION);
  expect(system).not.toContain('<system-reminder>');
}

describe('system-reminder 的真实宿主集成', () => {
  it('omEnabled=true 且未发生过压缩时，只注入进度提醒，不注入定义提醒', async () => {
    const { app, adapter, handle } = await stackPromptHost(true);
    try {
      expectSystemUntouched(await assembledSystem(app, handle.agent));
      const request = await runTurn(adapter, handle.agent, '请完成一个简短任务。');
      expectSystemUntouched(requestSystem(request));
      expect(requestReminders(request)).toBe(1);
      expect(loggedReminders(handle.agent)).toBe(1);
    } finally {
      await handle.dispose();
      await app.fiber.dispose();
    }
  });

  it('omEnabled=false 时不注入任何提醒，recall 仍注册且描述携带完整消息定义', async () => {
    const { app, adapter, handle } = await stackPromptHost(false);
    try {
      expectSystemUntouched(await assembledSystem(app, handle.agent));
      const request = await runTurn(adapter, handle.agent, '请完成一个简短任务。');
      expectSystemUntouched(requestSystem(request));
      expect(requestReminders(request)).toBe(0);
      expect(loggedReminders(handle.agent)).toBe(0);
      expect(JSON.stringify(request.messages)).not.toContain(COMPLETE_MESSAGE_DEFINITION);
      const recall = request.tools?.find((tool) => tool.name === 'recall');
      expect(recall?.description).toContain(COMPLETE_MESSAGE_DEFINITION);
    } finally {
      await handle.dispose();
      await app.fiber.dispose();
    }
  });

  it('进度提醒是持久化在会话表层中的用户消息，位于用户任务之后', async () => {
    const { app, adapter, handle } = await stackPromptHost(true);
    try {
      const request = await runTurn(adapter, handle.agent, '请完成一个简短任务。');
      const userTexts = request.messages
        .filter((message) => message.role === 'user')
        .map((message) =>
          message.content.map((block) => (block.type === 'text' ? block.text : '')).join(''),
        );
      expect(userTexts).toEqual(['请完成一个简短任务。', PROGRESS_REMINDER.text]);
      const session = handle.agent.session;
      const visible = session.surface.nodes
        .map((seq) => session.eventAt(seq))
        .filter(
          (event) =>
            event?.type === 'user/message' && event.data.source.kind === PROGRESS_REMINDER.kind,
        );
      expect(visible).toHaveLength(1);
    } finally {
      await handle.dispose();
      await app.fiber.dispose();
    }
  });

  it('完整 scoped 系统提示词预设保持原文，提醒仍以用户消息送达', async () => {
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
      expect(requestReminders(request)).toBe(1);
    } finally {
      await handle.dispose();
      await app.fiber.dispose();
    }
  });

  it('真实子会话没有提醒，主会话仍有', async () => {
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
      const childRequest = await runTurn(adapter, child.agent, '执行委派任务。');
      expect(requestReminders(childRequest)).toBe(0);
      expect(loggedReminders(child.agent)).toBe(0);
      const mainRequest = await runTurn(adapter, handle.agent, '汇总主会话任务。');
      expect(requestReminders(mainRequest)).toBe(1);
    } finally {
      await child?.dispose();
      await handle.dispose();
      await app.fiber.dispose();
    }
  });

  it.each([true, false])(
    'Loader volatile 从 %s 反复切换：开启后的下个请求补发一条，之后不叠加',
    async (initial) => {
      const { app, adapter, entry, handle } = await stackPromptHost(initial);
      try {
        const fiber = entry.fiber;
        if (!fiber) throw new Error('缺少 OM 插件 fiber');
        const config = fiber.config as ReturnType<typeof Config>;
        let everEnabled = false;
        for (const [index, enabled] of [initial, !initial, initial, !initial].entries()) {
          if (index > 0) {
            await entry.update({ config: pluginConfig(enabled) });
            await app.loader.await();
            expect(entry.fiber).toBe(fiber);
            expect(config.omEnabled.get()).toBe(enabled);
          }
          // 已写入历史的提醒无法撤回：关闭只停止补发
          everEnabled ||= enabled;
          const request = await runTurn(adapter, handle.agent, `第 ${index + 1} 轮任务。`);
          expectSystemUntouched(requestSystem(request));
          const count = everEnabled ? 1 : 0;
          expect(requestReminders(request)).toBe(count);
          expect(loggedReminders(handle.agent)).toBe(count);
        }
      } finally {
        await handle.dispose();
        await app.fiber.dispose();
      }
    },
  );

  it('同一主会话多轮请求进度提醒只保留一条', async () => {
    const { app, adapter, handle } = await stackPromptHost(true);
    try {
      for (let index = 0; index < 3; index += 1) {
        const request = await runTurn(adapter, handle.agent, `重复任务 ${index}。`);
        expect(requestReminders(request)).toBe(1);
      }
      expect(loggedReminders(handle.agent)).toBe(1);
    } finally {
      await handle.dispose();
      await app.fiber.dispose();
    }
  });

  it('真实 Agent 的工具循环在至少四个已结束 step 且超过十次调用后重发，并从重发 step 重计', async () => {
    const counts = [5, 4, 2, 1, 5, 4, 2, 1];
    const script = [
      ...counts.map((count, index) => toolStep(index + 1, count, ' \n\t ')),
      modelReply([{ type: 'text', text: '已完成所有工具检查。' }]),
    ];
    const { app, adapter, handle, toolRuns } = await stackPromptHost(true, script, {
      progressReminderIdleEnabled: true,
    });
    try {
      handle.agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: '连续执行工具检查，最后汇总。' }],
          source: { kind: 'user' },
        }),
      );
      await handle.agent.whenIdle();
      expectCompletedToolLoop(handle.agent, adapter, toolRuns, script.length, 24);
      expect(adapter.calls.map((request) => requestReminders(request, urgentReminder))).toEqual([
        0, 0, 0, 0, 1, 1, 1, 1, 2,
      ]);
      expect(adapter.calls.map((request) => requestReminders(request))).toEqual(
        Array.from({ length: script.length }, () => 1),
      );
      expect(loggedReminders(handle.agent)).toBe(3);
    } finally {
      await handle.dispose();
      await app.fiber.dispose();
    }
  });

  it('progressReminderEnabled=false 时 OM 仍开启也不注入进度提醒', async () => {
    const { app, adapter, handle } = await stackPromptHost(true, [], {
      progressReminderEnabled: false,
    });
    try {
      const request = await runTurn(adapter, handle.agent, '不需要提醒的任务。');
      expect(requestReminders(request)).toBe(0);
      expect(loggedReminders(handle.agent)).toBe(0);
    } finally {
      await handle.dispose();
      await app.fiber.dispose();
    }
  });

  it('自定义阈值 steps≥2 且 toolCalls>1 时更早重发，并从重发 step 重计', async () => {
    const script = [
      ...[1, 1, 1, 1].map((count, index) => toolStep(index + 1, count)),
      modelReply([{ type: 'text', text: '已完成自定义阈值检查。' }]),
    ];
    const { app, adapter, handle, toolRuns } = await stackPromptHost(true, script, {
      progressReminderIdleEnabled: true,
      progressReminderIdleSteps: 2,
      progressReminderIdleToolCalls: 1,
    });
    try {
      handle.agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: '连续执行四次工具检查。' }],
          source: { kind: 'user' },
        }),
      );
      await handle.agent.whenIdle();
      expectCompletedToolLoop(handle.agent, adapter, toolRuns, script.length, 4);
      expect(adapter.calls.map((request) => requestReminders(request, urgentReminder))).toEqual([
        0, 0, 1, 1, 2,
      ]);
      expect(loggedReminders(handle.agent)).toBe(3);
    } finally {
      await handle.dispose();
      await app.fiber.dispose();
    }
  });

  it('progressReminderIdleEnabled=false 时静默活动不重发，只保留一条提醒', async () => {
    const script = [
      ...Array.from({ length: 6 }, (_, index) => toolStep(index + 1, 3)),
      modelReply([{ type: 'text', text: '已完成静默检查。' }]),
    ];
    const { app, adapter, handle, toolRuns } = await stackPromptHost(true, script, {
      progressReminderIdleEnabled: false,
    });
    try {
      handle.agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: '静默执行十八次工具检查。' }],
          source: { kind: 'user' },
        }),
      );
      await handle.agent.whenIdle();
      expectCompletedToolLoop(handle.agent, adapter, toolRuns, script.length, 18);
      expect(adapter.calls.map((request) => requestReminders(request, urgentReminder))).toEqual(
        Array.from({ length: script.length }, () => 0),
      );
      expect(adapter.calls.map((request) => requestReminders(request))).toEqual(
        Array.from({ length: script.length }, () => 1),
      );
      expect(loggedReminders(handle.agent)).toBe(1);
    } finally {
      await handle.dispose();
      await app.fiber.dispose();
    }
  });

  it('Loader volatile 热更新：运行中开启活动重发并调低阈值，下一个请求即生效', async () => {
    const first = [
      ...[1, 2, 3, 4].map((step) => toolStep(step, 3)),
      modelReply([{ type: 'text', text: '第一轮完成。' }]),
    ];
    const second = [
      ...[11, 12].map((step) => toolStep(step, 1)),
      modelReply([{ type: 'text', text: '第二轮完成。' }]),
    ];
    const { app, adapter, entry, handle } = await stackPromptHost(true, [...first, ...second], {
      progressReminderIdleEnabled: false,
    });
    try {
      const run = async (text: string) => {
        const before = adapter.calls.length;
        handle.agent.followup(
          createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
        );
        await handle.agent.whenIdle();
        return adapter.calls
          .slice(before)
          .map((request) => requestReminders(request, urgentReminder));
      };
      expect(await run('关闭重发时执行十二次检查。')).toEqual([0, 0, 0, 0, 0]);
      await entry.update({
        config: pluginConfig(true, {
          progressReminderIdleEnabled: true,
          progressReminderIdleSteps: 2,
          progressReminderIdleToolCalls: 1,
        }),
      });
      await app.loader.await();
      expect(await run('开启重发并降低阈值后执行两次检查。')).toEqual([0, 0, 1]);
    } finally {
      await handle.dispose();
      await app.fiber.dispose();
    }
  });

  it('真实 Agent 四个已结束工具 step 恰好十次调用时不重发，超过十次才重发', async () => {
    const script = [
      ...[3, 3, 3, 1, 1].map((count, index) => toolStep(index + 1, count)),
      modelReply([{ type: 'text', text: '已完成边界检查。' }]),
    ];
    const { app, adapter, handle, toolRuns } = await stackPromptHost(true, script, {
      progressReminderIdleEnabled: true,
    });
    try {
      handle.agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: '执行十一次工具检查。' }],
          source: { kind: 'user' },
        }),
      );
      await handle.agent.whenIdle();
      expectCompletedToolLoop(handle.agent, adapter, toolRuns, script.length, 11);
      expect(adapter.calls.map((request) => requestReminders(request, urgentReminder))).toEqual([
        0, 0, 0, 0, 0, 1,
      ]);
      expect(loggedReminders(handle.agent)).toBe(2);
    } finally {
      await handle.dispose();
      await app.fiber.dispose();
    }
  });

  it('真实 Agent 的非空顶层 text 重置进度，从下一 step 累计后仍会重发', async () => {
    const script = [
      toolStep(1, 4),
      toolStep(2, 4),
      toolStep(3, 3, '  已确认前几步结果，接下来继续检查剩余项目。\n'),
      toolStep(4, 3),
      toolStep(5, 3),
      toolStep(6, 3),
      toolStep(7, 2),
      modelReply([{ type: 'text', text: '检查已全部完成。' }]),
    ];
    const { app, adapter, handle, toolRuns } = await stackPromptHost(true, script, {
      progressReminderIdleEnabled: true,
    });
    try {
      handle.agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: '持续检查，并记录中间进展。' }],
          source: { kind: 'user' },
        }),
      );
      await handle.agent.whenIdle();
      expectCompletedToolLoop(handle.agent, adapter, toolRuns, script.length, 22);
      expect(adapter.calls.map((request) => requestReminders(request, urgentReminder))).toEqual([
        0, 0, 0, 0, 0, 0, 0, 1,
      ]);
      expect(loggedReminders(handle.agent)).toBe(2);
    } finally {
      await handle.dispose();
      await app.fiber.dispose();
    }
  });

  it('表层保留同 kind 旧进度提醒时不补发当前文本，后续请求不重复补发', async () => {
    const { app, adapter, handle } = await stackPromptHost(true);
    try {
      const previousReminder: SystemReminder = {
        kind: PROGRESS_REMINDER.kind,
        text: [
          '<system-reminder>',
          '在工作过程中同步输出文本，简洁记录关键结论与后续规划。思考内容不计入记录。',
          '- 每个阶段性工作开始前记录一次，一个阶段通常是 1-5 个工具调用',
          '- 禁止连续 10 个以上工具调用而无记录',
          '- 记录后在同一回复中继续调用工具，不要停下等待',
          '- 最终答案仅总结结果，不能替代这些记录',
          '</system-reminder>',
        ].join('\n'),
      };
      handle.agent.session.append(
        'user/message',
        createUserMessage({
          content: [{ type: 'text', text: previousReminder.text }],
          source: { kind: previousReminder.kind, form: 'instructions' },
        }),
        { surfaceOp: 'append' },
      );

      for (let index = 0; index < 2; index += 1) {
        const request = await runTurn(adapter, handle.agent, `保留旧提醒的任务 ${index}。`);
        expectSystemUntouched(requestSystem(request));
        expect(requestReminders(request, previousReminder)).toBe(1);
        expect(loggedReminders(handle.agent)).toBe(1);
      }
    } finally {
      await handle.dispose();
      await app.fiber.dispose();
    }
  });

  it('提醒被表层替换遮蔽后，下个请求补发一条且请求中仍只有一条', async () => {
    const { app, adapter, handle } = await stackPromptHost(true);
    try {
      await runTurn(adapter, handle.agent, '第一轮任务。');
      const session = handle.agent.session;
      const nodes = [...session.surface.nodes];
      const reminderSeq = nodes.find((seq) => {
        const event = session.eventAt(seq);
        return event?.type === 'user/message' && event.data.source.kind === PROGRESS_REMINDER.kind;
      });
      if (reminderSeq === undefined) throw new Error('第一轮后表层缺少提醒');
      // 与 OM 压缩一致：以替换检查点遮蔽包含提醒的区间（节点 0 是系统提示词，不可替换）
      const first = nodes[1];
      if (first === undefined) throw new Error('表层缺少可遮蔽区间');
      session.append(
        'user/message',
        createUserMessage({
          content: [{ type: 'text', text: '<history>摘要</history>' }],
          source: { kind: 'plugin:dsh-plugin-om' },
        }),
        {
          surfaceOp: { op: 'replace', startSeq: first, endSeq: reminderSeq },
          sourceEventSeqs: nodes.slice(1, nodes.indexOf(reminderSeq) + 1),
        },
      );
      const request = await runTurn(adapter, handle.agent, '第二轮任务。');
      expect(requestReminders(request)).toBe(1);
      expect(loggedReminders(handle.agent)).toBe(2);
    } finally {
      await handle.dispose();
      await app.fiber.dispose();
    }
  });

  it('Loader 卸载插件后不再向现有主 Agent 补发提醒', async () => {
    const { app, adapter, entry, handle } = await stackPromptHost(true);
    try {
      const before = await runTurn(adapter, handle.agent, '插件卸载前的任务。');
      expect(requestReminders(before)).toBe(1);
      const fiber = entry.fiber;
      if (!fiber) throw new Error('缺少待卸载的 OM 插件 fiber');
      app.loader.remove(entry.id);
      await fiber.dispose();
      const after = await runTurn(adapter, handle.agent, '插件卸载后的任务。');
      expect(requestReminders(after)).toBe(1);
      expect(loggedReminders(handle.agent)).toBe(1);
    } finally {
      await handle.dispose();
      await app.fiber.dispose();
    }
  });
});
