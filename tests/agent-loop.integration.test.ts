// 真实 DSH agent loop 与 mock AI 集成测试：验证 OM 压缩、召回、持久化导出和回合生命周期。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { type AgentHandle, AgentRegistry } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local';
import {
  createUserMessage,
  type GenerateOptions,
  LlmAdapter,
  LlmRuntime,
  type StreamChunk,
  type ToolCallId,
} from '@deepseek-ai/dsh-llm';
import { type SessionEvent, type SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import {
  apply as applySessionLogExport,
  inject as exportInject,
  name as exportName,
  SESSION_LOG_EXPORT_PATH,
  SESSION_LOG_FILENAME,
} from '@deepseek-ai/dsh-session-log-export';
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { TokenMeter } from '@deepseek-ai/dsh-token-meter';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { unzipSync } from 'fflate';
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

/** 宿主注册的 HEAD/GET 导出 handler；只替换网络接入层。 */
interface ExportRoute {
  path: string;
  methods: readonly string[];
  fetch: (request: Request) => Promise<Response>;
}

/** 堆叠完整宿主服务、插件和真实 Agent，按资源所有权逆序释放。 */
async function stackAgentLoop(mode: 'success' | 'failure', storageRoot?: string) {
  const app = new Context();
  let handle: AgentHandle | undefined;
  let exportRoute: ExportRoute | undefined;
  try {
    if (storageRoot !== undefined) {
      await app.plugin(JsonlSessionPersistence, {
        root: join(storageRoot, 'sessions'),
        compression: 'none',
      });
    }
    await app.plugin(SessionStore);
    if (storageRoot !== undefined) {
      await app.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'never' });
      await app.plugin(LocalAttachmentStore, { dshHome: storageRoot });
      // HTTP 服务仅提供路由注册；fetch handler、查询、持久化和附件均来自真实宿主。
      app.provide('commands', { register: () => () => {} });
      app.provide('connection', {
        fetch: {
          register(route: ExportRoute) {
            exportRoute = route;
            return () => {
              exportRoute = undefined;
            };
          },
        },
      });
      await app.plugin(
        { name: exportName, inject: exportInject, apply: applySessionLogExport },
        {
          compressionLevel: 0,
        },
      );
    }
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
    if (storageRoot !== undefined && exportRoute === undefined) {
      throw new Error('宿主未注册会话导出路由');
    }
    return { app, handle, adapter, exportRoute };
  } catch (error) {
    await handle?.dispose();
    await app.fiber.dispose();
    throw error;
  }
}

/** 将 ZIP 中的一条真实会话日志解析为 header 与事件序列。 */
function archivedLog(zip: Record<string, Uint8Array>, path: string) {
  const bytes = zip[path];
  if (!bytes) throw new Error(`导出 ZIP 缺少 ${path}`);
  const [headerLine, ...eventLines] = new TextDecoder().decode(bytes).trimEnd().split('\n');
  if (!headerLine) throw new Error(`导出 ZIP 中 ${path} 缺少 header`);
  return {
    header: JSON.parse(headerLine) as {
      type: 'session';
      id: string;
      parentSession?: string;
      origin?: string;
    },
    events: eventLines.map((line) => JSON.parse(line) as SessionEvent),
  };
}

describe('真实 agent loop + mock AI', () => {
  it('在真实回合中完成压缩、通过模型调用召回并以摘要继续对话', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-om-agent-success-'));
    const { app, handle, adapter } = await stackAgentLoop('success', root);
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
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it('压缩请求失败时保留原表层并将真实回合标为 blocked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-om-agent-failure-'));
    const { app, handle, adapter } = await stackAgentLoop('failure', root);
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
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it.each(['success', 'failure'] as const)(
    '持久化 %s 压缩后通过真实宿主 HEAD/GET 导出父子会话日志',
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), 'dsh-om-export-'));
      let stack: Awaited<ReturnType<typeof stackAgentLoop>> | undefined;
      try {
        stack = await stackAgentLoop(mode, root);
        const { app, handle, exportRoute } = stack;
        if (!exportRoute) throw new Error('宿主没有注册导出 handler');
        const session = handle.agent.session;
        handle.agent.followup(prompt('首轮：请保留详细背景资料。'));
        await handle.agent.whenIdle();
        handle.agent.followup(prompt('次轮：自动压缩后继续。'));
        await handle.agent.whenIdle();

        const compaction = session
          .snapshotEvents()
          .find((event) => event.type === 'compaction/end');
        if (compaction?.type !== 'compaction/end') throw new Error('缺少真实压缩回合');
        const childId =
          'diagnosticSessionId' in compaction.data
            ? compaction.data.diagnosticSessionId
            : undefined;
        if (typeof childId !== 'string') throw new Error('缺少压缩子会话 id');

        expect(exportRoute.path).toBe(SESSION_LOG_EXPORT_PATH);
        expect(exportRoute.methods).toEqual(expect.arrayContaining(['HEAD', 'GET']));
        const url = `http://localhost${SESSION_LOG_EXPORT_PATH}?sessionId=${encodeURIComponent(session.id)}&includeDescendants=true`;
        const head = await exportRoute.fetch(new Request(url, { method: 'HEAD' }));
        expect(head.status).toBe(200);
        expect(head.headers.get('content-type')).toBe('application/zip');
        expect(head.body).toBeNull();
        const get = await exportRoute.fetch(new Request(url, { method: 'GET' }));
        expect(get.status).toBe(200);
        expect(get.headers.get('content-type')).toBe(head.headers.get('content-type'));
        expect(get.headers.get('content-disposition')).toBe(
          head.headers.get('content-disposition'),
        );
        const zip = unzipSync(new Uint8Array(await get.arrayBuffer()));
        const childPath = `subagents/${childId}/${SESSION_LOG_FILENAME}`;
        expect(Object.keys(zip)).toEqual(expect.arrayContaining([SESSION_LOG_FILENAME, childPath]));
        const parent = archivedLog(zip, SESSION_LOG_FILENAME);
        const child = archivedLog(zip, childPath);
        expect(parent.header).toMatchObject({ type: 'session', id: session.id });
        expect(child.header).toMatchObject({
          type: 'session',
          id: childId,
          parentSession: session.id,
          origin: 'subagent',
        });
        expect(child.events[0]).toMatchObject({
          type: 'subagent/descriptor',
          data: { provider: 'om-compaction-log' },
        });
        expect(parent.events).toContainEqual(
          expect.objectContaining({
            type: 'compaction/end',
            data: expect.objectContaining({ diagnosticSessionId: childId }),
          }),
        );
        expect(JSON.stringify(parent.events)).toContain(ORIGINAL);
        expect(JSON.stringify(child.events)).toContain('【压缩统计】');
        expect(child.events.some((event) => event.type === 'user/message')).toBe(true);
        if (mode === 'success') {
          expect(child.events.some((event) => event.type === 'tool/result')).toBe(true);
          expect(JSON.stringify(child.events)).toContain(ORIGINAL);
          expect(JSON.stringify(parent.events)).toContain(SUMMARY);
        } else {
          expect(JSON.stringify(parent.events)).toContain('mock 压缩失败');
          expect(JSON.stringify(child.events)).toContain('失败');
          expect(parent.events.some((event) => event.type === 'compaction/summary')).toBe(false);
        }
        expect(await app.sessionPersistence.stat(childId as SessionId)).toBeDefined();
      } finally {
        if (stack) {
          await stack.handle.dispose();
          await stack.app.fiber.dispose();
        }
        await rm(root, { recursive: true, force: true });
      }
    },
    30000,
  );
});
