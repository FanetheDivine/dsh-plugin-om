// 真实 DSH agent loop 与 mock AI 集成测试：验证 OM 压缩、召回和回合生命周期。
import { Context } from '@deepseek-ai/cordis';
import { type AgentHandle, AgentRegistry } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import {
  createUserMessage,
  type GenerateOptions,
  LlmAdapter,
  LlmRuntime,
  type StreamChunk,
  type ToolCallId,
} from '@deepseek-ai/dsh-llm';
import { type SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { TokenMeter } from '@deepseek-ai/dsh-token-meter';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { describe, expect, it } from 'vitest';
import { PLUGIN_SOURCE_KIND } from '../src/constants.ts';
import { apply, inject, name } from '../src/index.ts';

const ORIGINAL = `原始助手长文本标记：${'用于压缩的真实会话历史。'.repeat(600)}`;
const SUMMARY = '助手摘要标记';

/** 创建一个真实用户输入，交给 Agent inbox 驱动整轮对话。 */
function prompt(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
}

/** 回放一轮模型工具调用，下一轮交给真正的工具运行时。 */
function toolCall(name: string, args: object, id: string): StreamChunk[] {
  return [
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: id as ToolCallId, name, arguments: JSON.stringify(args) },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
}

/** 回放普通助手回复。 */
function textReply(text: string): StreamChunk[] {
  return [
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}

/** 仅模拟模型输出：会话、Agent、工具与压缩都由真实服务执行。 */
class ScriptedAi extends LlmAdapter {
  readonly calls: GenerateOptions[] = [];
  readonly compactionTools: string[] = [];
  private ordinaryCalls = 0;

  constructor(private readonly mode: 'success' | 'failure') {
    super();
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options);
    if (options.purpose === 'compaction') {
      if (this.mode === 'failure') {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { message: 'mock 压缩失败', code: 'MOCK_FAILURE' },
          },
        };
        return;
      }
      const round = this.compactionTools.length;
      const name = ['getHistory', 'compressHistory', 'completeCompression'][round % 3];
      if (!name) throw new Error(`非预期的压缩请求：${round}`);
      const lastText =
        options.messages
          .at(-1)
          ?.content.filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('') ?? '';
      const assistantIndex = /<assistant index="(\d+)"/.exec(lastText)?.[1];
      const args =
        name === 'compressHistory' ? { index: Number(assistantIndex), content: SUMMARY } : {};
      this.compactionTools.push(name);
      yield* toolCall(name, args, `compress-${round}`);
      return;
    }
    this.ordinaryCalls += 1;
    if (this.ordinaryCalls === 1) {
      yield* textReply(ORIGINAL);
    } else if (this.ordinaryCalls === 2) {
      yield* toolCall('recall', { start: 1, end: 1 }, 'recall-1');
    } else if (this.ordinaryCalls === 3) {
      yield* textReply('已查看原文，继续回答。');
    } else {
      throw new Error(`非预期的普通模型请求：${this.ordinaryCalls}`);
    }
  }
}

/** 堆叠完整宿主服务、插件和真实 Agent，按资源所有权逆序释放。 */
async function stackAgentLoop(mode: 'success' | 'failure') {
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
    const adapter = new ScriptedAi(mode);
    app.llm.registerAdapter(['mock'], adapter);
    await app.plugin(
      { name, inject, apply },
      {
        observeThresholdTokens: 100,
        reflectThresholdTokens: 1000000,
        tailMessageCount: 0,
        rateLimitWaitMs: 0,
        recallEnabled: true,
        semanticRecallEnabled: false,
      },
    );
    handle = await app.agents.create({
      sessionId: `it-full-loop-${mode}` as SessionId,
      agentOptions: { provider: 'mock', model: 'mock-model' },
    });
    return { app, handle, adapter };
  } catch (error) {
    await handle?.dispose();
    await app.fiber.dispose();
    throw error;
  }
}

describe('真实 agent loop + mock AI', () => {
  it('在真实回合中完成压缩、通过模型调用召回并以摘要继续对话', async () => {
    const { app, handle, adapter } = await stackAgentLoop('success');
    try {
      const session = handle.agent.session;
      handle.agent.followup(prompt('首轮：请保留详细背景资料。'));
      await handle.agent.whenIdle();
      expect(session.snapshotEvents().filter((event) => event.type === 'turn/end')).toHaveLength(1);
      expect(adapter.calls.filter((call) => call.purpose !== 'compaction')).toHaveLength(1);

      handle.agent.followup(prompt('次轮：请先召回原文，再回答。'));
      await handle.agent.whenIdle();

      const events = session.snapshotEvents();
      const types = events.map((event) => event.type);
      const turn2Start = events.findIndex(
        (event) => event.type === 'turn/start' && event.data.turn === 2,
      );
      const compactStart = events.findIndex((event) => event.type === 'compaction/start');
      const compactEnd = events.findIndex((event) => event.type === 'compaction/end');
      const step2Start = events.findIndex(
        (event) => event.type === 'step/start' && event.data.turn === 2,
      );
      expect(turn2Start).toBeGreaterThan(-1);
      expect(compactStart).toBeGreaterThan(turn2Start);
      expect(types).toContain('compaction/summary');
      expect(compactEnd).toBeGreaterThan(compactStart);
      expect(step2Start).toBeGreaterThan(compactEnd);
      expect(adapter.compactionTools).toEqual([
        'getHistory',
        'compressHistory',
        'completeCompression',
        'getHistory',
        'compressHistory',
        'completeCompression',
      ]);
      expect(adapter.calls.filter((call) => call.purpose === 'compaction')).toHaveLength(6);
      const secondCompactionRequest = adapter.calls.filter(
        (call) => call.purpose === 'compaction',
      )[4];
      const secondCompactionInput =
        secondCompactionRequest?.messages
          .flatMap((message) => message.content)
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('') ?? '';
      expect(secondCompactionInput).toContain(ORIGINAL);
      const successEnd = events.find((event) => event.type === 'compaction/end');
      expect(successEnd?.type).toBe('compaction/end');
      const diagnosticId =
        successEnd?.type === 'compaction/end' && 'diagnosticSessionId' in successEnd.data
          ? successEnd.data.diagnosticSessionId
          : undefined;
      if (typeof diagnosticId !== 'string') throw new Error('缺少成功压缩的诊断会话');
      const child = app.sessions.get(diagnosticId as SessionId);
      expect(
        child
          ?.snapshotEvents()
          .filter((event) => event.type === 'tool/result')
          .map((event) => event.data.message.content),
      ).toContainEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining('原始助手长文本标记') }),
        ]),
      );

      const checkpoint = events.find(
        (event) => event.type === 'user/message' && event.data.source.kind === PLUGIN_SOURCE_KIND,
      );
      expect(checkpoint?.type).toBe('user/message');
      if (checkpoint?.type !== 'user/message') throw new Error('缺少 OM 历史块');
      const history = checkpoint.data.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      expect(history).toContain('<history tip=');
      expect(history).toContain(SUMMARY);
      expect(history).toContain('首轮：请保留详细背景资料。');
      expect(history).not.toContain(ORIGINAL);
      expect(checkpoint.surfaceOp).toMatchObject({ op: 'replace' });

      const normalCalls = adapter.calls.filter((call) => call.purpose !== 'compaction');
      expect(normalCalls).toHaveLength(3);
      expect(
        normalCalls.every((call) => call.provider === 'mock' && call.model === 'mock-model'),
      ).toBe(true);
      const secondRequest =
        normalCalls[1]?.messages
          .flatMap((message) => message.content)
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('') ?? '';
      expect(secondRequest).toContain(SUMMARY);
      expect(secondRequest).toContain('次轮：请先召回原文，再回答。');
      expect(secondRequest).not.toContain(ORIGINAL);

      const recallCall = events.find(
        (event) => event.type === 'tool/call' && event.data.name === 'recall',
      );
      const recallResult = events.find(
        (event) => event.type === 'tool/result' && event.data.message.toolCallId === 'recall-1',
      );
      expect(recallCall).toBeDefined();
      expect(recallResult?.type).toBe('tool/result');
      if (recallResult?.type !== 'tool/result') throw new Error('缺少 recall 工具结果');
      expect(recallResult.data.message.isError).not.toBe(true);
      const recalledText = recallResult.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      expect(recalledText).toContain(ORIGINAL);
      const afterToolRequest =
        normalCalls[2]?.messages
          .flatMap((message) => message.content)
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('') ?? '';
      expect(afterToolRequest.match(/<history tip=/g)).toHaveLength(2);
      expect(afterToolRequest).toContain('次轮：请先召回原文，再回答。');
      expect(afterToolRequest).toContain(SUMMARY);
      expect(afterToolRequest).not.toContain(ORIGINAL);
      expect(events.filter((event) => event.type === 'compaction/summary')).toHaveLength(2);
      const ends = events.filter((event) => event.type === 'turn/end');
      expect(ends).toHaveLength(2);
      expect(ends[1]?.data.reason.kind).toBe('completed');
      expect(
        events.filter((event) => event.type === 'assistant/message').at(-1)?.data.message.content,
      ).toContainEqual({ type: 'text', text: '已查看原文，继续回答。' });
    } finally {
      await handle.dispose();
      await app.fiber.dispose();
    }
  }, 30000);

  it('压缩请求失败时保留原表层并将真实回合标为 blocked', async () => {
    const { app, handle, adapter } = await stackAgentLoop('failure');
    try {
      const session = handle.agent.session;
      handle.agent.followup(prompt('首轮：请保留详细背景资料。'));
      await handle.agent.whenIdle();
      const firstAssistant = session
        .snapshotEvents()
        .find((event) => event.type === 'assistant/message');
      expect(firstAssistant?.type).toBe('assistant/message');

      handle.agent.followup(prompt('次轮：压缩失败后不要继续调用普通模型。'));
      await handle.agent.whenIdle();

      const events = session.snapshotEvents();
      const compaction = events.find((event) => event.type === 'compaction/end');
      expect(compaction?.type).toBe('compaction/end');
      if (compaction?.type !== 'compaction/end') throw new Error('缺少 compaction/end');
      expect(compaction.data.error).toContain('mock 压缩失败');
      const diagnosticId =
        'diagnosticSessionId' in compaction.data ? compaction.data.diagnosticSessionId : undefined;
      expect(typeof diagnosticId).toBe('string');
      if (typeof diagnosticId !== 'string') throw new Error('缺少诊断子会话 id');
      const diagnostic = app.sessions.get(diagnosticId as SessionId);
      expect(diagnostic?.header.parentSession).toBe(session.id);
      expect(diagnostic?.snapshotEvents()[0]).toMatchObject({
        type: 'subagent/descriptor',
        data: { provider: 'om-compaction-log' },
      });

      const ends = events.filter((event) => event.type === 'turn/end');
      expect(ends).toHaveLength(2);
      expect(ends[1]?.data.reason.kind).toBe('blocked');
      expect(
        events.filter((event) => event.type === 'step/start' && event.data.turn === 2),
      ).toHaveLength(0);
      expect(events.filter((event) => event.type === 'compaction/summary')).toHaveLength(0);
      expect(session.surface.replaceGeneration).toBe(0);
      expect(session.surface.nodes).toContain(firstAssistant?.seq);
      expect(adapter.calls.filter((call) => call.purpose === 'compaction')).toHaveLength(1);
      expect(adapter.calls.filter((call) => call.purpose !== 'compaction')).toHaveLength(1);
    } finally {
      await handle.dispose();
      await app.fiber.dispose();
    }
  }, 30000);
});
