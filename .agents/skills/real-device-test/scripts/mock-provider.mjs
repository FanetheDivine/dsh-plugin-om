// OM 实机测试 mock provider（参考实现）：无网络，脚本化压缩循环与普通响应。
// 模型：mock-model（默认）与 claude-mock（Anthropic 签名思考，thinking-binding 用）。
// 模式（adapter.modes 按 sessionId）：
//   normal           getHistory → 压缩全部 assistant 条目（含二次确认重试）→ completeCompression
//   truncate-recover 前两次输出纯文本 + max-tokens 截断，之后 normal
//   truncate-always  始终纯文本 + max-tokens（触发连续 3 轮截断失败）
//   transient-recover 首次压缩请求抛 fetch failed，之后 normal
//   5xx-recover      首次压缩请求 finish error status 503，之后 normal
//   state-check      压缩首条 assistant 条目后再次 getHistory（验证当前状态投影）
//   failure          压缩请求直接失败（非瞬时）
//   rewrite          旧验收的 ask 重写脚本（回归）
// 普通请求按最新用户文本标记分支：ASK_CASE / RECALL_CASE / REASON_CASE / LONG_CASE。
// 每次响应都发 usage（inputTokens = 请求估算 tokens × usageMultiplier，token 换算测试用）。

import { execSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// 自定位：脚本被复制到 profile 目录后运行；env 可覆盖。
export const root = process.env.OM_PROFILE_DIR ?? dirname(fileURLToPath(import.meta.url));
const dshPkg =
  process.env.OM_DSH_PKG ??
  join(execSync('npm root -g', { encoding: 'utf8' }).trim(), '@deepseek-ai', 'dsh', 'package.json');
const require = createRequire(dshPkg);
const { LlmAdapter } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')));
export const name = 'om-test-mock';
export const inject = ['llm', 'sessions'];
function blockTexts(content) {
  return (content ?? []).flatMap((b) =>
    b.type === 'text' ? [b.text ?? ''] : b.type === 'tool-result' ? blockTexts(b.content) : [],
  );
}
export function plain(messages) {
  return messages
    .filter(Boolean)
    .flatMap((m) => blockTexts(m.content))
    .join('\n');
}
export function systemText(request) {
  return plain(request.messages.filter((m) => m.role === 'system'));
}
const questions = [
  {
    id: 'deploy',
    question: '部署到哪里？\n必须保留 <xml> & 字面值',
    options: [
      { label: '本地', description: '不上传数据，离线运行' },
      { label: '云端', description: '上传数据，由云服务运行' },
    ],
  },
  {
    id: 'checks',
    question: '执行哪些检查？',
    multi_select: true,
    options: [
      { label: '单元测试', description: '执行全部单元用例' },
      { label: '集成测试', description: '验证真实宿主链路' },
    ],
  },
  { id: 'comment', question: '还有其他要求吗？' },
];
export function qaFor(mode = 'rewrite') {
  return [
    {
      ordinal: 3,
      q: questions[2].question,
      a: mode === 'semantic-negative' ? '用户已批准上传全部数据' : '(未回答)',
    },
    {
      ordinal: 1,
      q: questions[0].question,
      a:
        mode === 'semantic-negative'
          ? '第一个'
          : '在本地部署，不上传数据，离线运行；条件：仅测试，保留 ]]> 与 <xml> &',
    },
    {
      ordinal: 2,
      q: questions[1].question,
      a: '执行全部单元用例，并验证真实宿主链路；只读检查，不修改代码',
    },
  ];
}
// 从 getHistory 产物提取可压缩 assistant 条目的调用参数（index 或 start/end）
function assistantSpans(xml) {
  const spans = [];
  for (const m of xml.matchAll(/<assistant (index="(\d+)"|start="(\d+)" end="(\d+)")/g)) {
    if (m[2] !== undefined) spans.push({ index: Number(m[2]) });
    else spans.push({ start: Number(m[3]), end: Number(m[4]) });
  }
  return spans;
}
function lastHistoryText(messages) {
  // getHistory 工具结果返回条目 XML（无 <history> 根标签），按条目元素识别
  const texts = messages
    .filter((m) => m.role === 'tool')
    .map((m) => plain([m]))
    .filter(
      (t) =>
        t.includes('<assistant') ||
        t.includes('<user_message') ||
        t.includes('<history') ||
        t.includes('<skill_content') ||
        t.includes('<ask-user-question'),
    );
  return texts.at(-1) ?? '';
}
export function apply(ctx) {
  class Mock extends LlmAdapter {
    calls = [];
    modes = new Map();
    usageMultiplier = new Map();
    ordinaryCounts = new Map();
    compactionAttempts = new Map();
    recallUsed = new Set();
    captures = new Map();
    providerInfo(id) {
      return { id, name: 'OM test mock (no network)' };
    }
    async listModels(provider) {
      return [
        { provider, id: 'mock-model', name: 'mock-model', inputModalities: ['text'] },
        { provider, id: 'claude-mock', name: 'claude-mock', inputModalities: ['text'] },
      ];
    }
    // claude-mock 暴露思考等级元数据，供 resolveCompressionEffort 校验
    async resolveModel(provider, model) {
      const info = { provider, id: model, name: model, inputModalities: ['text'] };
      if (model === 'claude-mock')
        return {
          ...info,
          reasoning: {
            efforts: [
              { id: 'low', name: 'Low' },
              { id: 'medium', name: 'Medium' },
              { id: 'high', name: 'High' },
            ],
          },
        };
      return info;
    }
    cap(sid, key, value) {
      const c = this.captures.get(sid) ?? {};
      c[key] = value;
      this.captures.set(sid, c);
      return c;
    }
    async *stream(o) {
      if (o.signal?.aborted) {
        yield {
          type: 'finish',
          reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } },
        };
        return;
      }
      this.calls.push(o);
      try {
        appendFileSync(
          `${root}/requests.jsonl`,
          `${JSON.stringify(o, (k, v) => (k === 'signal' ? undefined : v))}\n`,
        );
      } catch {}
      const sid = o.sessionId ?? '';
      const mode = this.modes.get(sid) ?? 'normal';
      const mult = this.usageMultiplier.get(sid) ?? 1;
      const reqChars =
        plain(o.messages).length +
        (typeof o.system === 'string' ? o.system.length : 0) +
        JSON.stringify(o.tools ?? []).length;
      const usageChunk = (outChars) => ({
        type: 'usage',
        usage: {
          inputTokens: Math.max(1, Math.round(Math.ceil(reqChars / 4) * mult)),
          outputTokens: Math.max(1, Math.ceil(outChars / 4)),
        },
      });
      const textOut = (text) => ({ type: 'block-end', index: 0, block: { type: 'text', text } });
      const toolOut = (commands) =>
        commands.map(([name, args], index) => ({
          type: 'block-end',
          index,
          block: {
            type: 'tool-call',
            id: `mock-${this.calls.length}-${index}`,
            name,
            arguments: JSON.stringify(args),
          },
        }));
      if (o.purpose === 'compaction') {
        const att = (this.compactionAttempts.get(sid) ?? 0) + 1;
        this.compactionAttempts.set(sid, att);
        const round = o.messages.filter((m) => m.role === 'assistant').length;
        if (att > 12) throw new Error('MOCK_SAFETY_LIMIT: too many compaction attempts');
        const xml = lastHistoryText(o.messages);
        if (round >= 1 && xml) {
          const hist = this.captures.get(sid)?.hist ?? [];
          if (!hist.includes(xml)) {
            hist.push(xml);
            this.cap(sid, 'hist', hist);
          }
        }
        let commands = null;
        if (mode === 'failure') {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { message: 'Injected mock compaction failure', code: 'MOCK_FAILURE' },
            },
          };
          return;
        }
        if (mode === 'truncate-always') {
          yield textOut(`TRUNCATED_OUTPUT_ROUND_${att}`);
          yield usageChunk(40);
          yield { type: 'finish', reason: { kind: 'max-tokens' } };
          return;
        }
        if (mode === 'truncate-recover') {
          const nudges = o.messages.filter(
            (m) => m.role === 'user' && plain([m]).includes('上一轮输出因长度上限被截断'),
          ).length;
          if (nudges < 2) {
            yield textOut(`TRUNCATED_OUTPUT_ROUND_${att}`);
            yield usageChunk(40);
            yield { type: 'finish', reason: { kind: 'max-tokens' } };
            return;
          }
        }
        if (mode === 'transient-recover' && att === 1) throw new Error('fetch failed');
        if (mode === '5xx-recover' && att === 1) {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { message: 'mock upstream 503', code: 'MOCK_503', status: 503 },
            },
          };
          return;
        }
        if (
          mode === 'rewrite' ||
          mode === 'direct' ||
          mode === 'same-round-direct' ||
          mode === 'semantic-negative'
        ) {
          const hasAsk = o.tools.some((t) => t.name === 'rewriteAskUserQuestion');
          const asks = [...xml.matchAll(/<ask-user-question index="(\d+)">/g)].map((m) =>
            Number(m[1]),
          );
          const ordinary = [
            ...xml.matchAll(/<assistant index="(\d+)"(?![^>]*type="toolcall")/g),
          ].map((m) => Number(m[1]));
          if (round === 0) {
            commands = hasAsk
              ? [
                  ['completeCompression', {}],
                  ['getHistory', {}],
                ]
              : [['getHistory', {}]];
          } else if (round === 1 && hasAsk) {
            commands = asks.flatMap((index) => [
              ['rewriteAskUserQuestion', { index, qa: qaFor(mode).slice(0, 2) }],
              [
                'rewriteAskUserQuestion',
                { index, qa: qaFor(mode).map((q) => ({ ...q, options: [] })) },
              ],
              [
                'rewriteAskUserQuestion',
                { index, qa: qaFor(mode).map((q) => ({ ...q, a: 'o1:残留选项' })) },
              ],
              ['rewriteAskUserQuestion', { index, qa: qaFor(mode) }],
            ]);
            commands.push(
              ...ordinary.map((index) => ['compressHistory', { index, content: '保留任务结论。' }]),
              ['completeCompression', {}],
              ['rewriteAskUserQuestion', { index: asks[0], qa: qaFor(mode) }],
            );
          } else {
            commands = [
              ...ordinary.map((index) => [
                'compressHistory',
                { index, content: '压缩摘要：已保留任务结论与产出。' },
              ]),
              ['completeCompression', {}],
            ];
          }
        } else if (mode === 'state-check') {
          if (round === 0) commands = [['getHistory', {}]];
          else if (round === 1) {
            const spans = assistantSpans(xml);
            const first = spans[0];
            commands = first
              ? [
                  ['compressHistory', { ...first, content: 'SUMMARY_MARKER_A' }],
                  ['getHistory', {}],
                ]
              : [['completeCompression', {}]];
          } else {
            // 不再重压已替换区间，直接完成，最终块应反映当前状态（SUMMARY_MARKER_A）
            commands = [['completeCompression', {}]];
          }
        } else {
          // normal：round0 查看；round1 全部压缩后再查看（触发 skill/ask 二次确认）；round2+ 再压缩并完成
          if (round === 0) commands = [['getHistory', {}]];
          else if (round === 1)
            commands = [
              ...assistantSpans(xml).map((span) => [
                'compressHistory',
                { ...span, content: `摘要：保留结论（span ${JSON.stringify(span)}）。` },
              ]),
              ['getHistory', {}],
            ];
          else
            commands = [
              ...assistantSpans(xml).map((span) => [
                'compressHistory',
                { ...span, content: '摘要：保留结论。' },
              ]),
              ['completeCompression', {}],
            ];
        }
        const chunks = toolOut(commands);
        for (const chunk of chunks) yield chunk;
        yield usageChunk(chunks.length * 40);
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      // 普通请求
      const n = (this.ordinaryCounts.get(sid) ?? 0) + 1;
      this.ordinaryCounts.set(sid, n);
      // 当前轮用户消息批次（最后一条 assistant 之后）：系统提醒会拼接在真实用户消息后，
      // 只按本轮批次识别标记，避免历史标记误触发
      const lastA = o.messages.map((m) => m.role).lastIndexOf('assistant');
      const text = plain(o.messages.slice(lastA + 1).filter((m) => m.role === 'user'));
      if (text.includes('ASK_CASE') && n === 1) {
        const chunks = toolOut([['ask_user_question', { questions }]]);
        for (const chunk of chunks) yield chunk;
        yield usageChunk(80);
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (text.includes('RECALL_CASE') && !this.recallUsed.has(sid)) {
        this.recallUsed.add(sid);
        const chunks = toolOut([['recall', { start: 0, end: 0 }]]);
        for (const chunk of chunks) yield chunk;
        yield usageChunk(80);
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (text.includes('REASON_CASE')) {
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'reasoning', text: `REASONING_MARKER_${n} 内部思考过程` },
        };
        yield { type: 'block-end', index: 1, block: { type: 'text', text: `REASON_REPLY_${n}` } };
        yield usageChunk(60);
        const signed = o.model === 'claude-mock';
        yield {
          type: 'finish',
          reason: { kind: 'stop' },
          ...(signed
            ? {
                replayState: {
                  response: { api: 'anthropic-messages', id: `msg_mock_${sid}_${n}` },
                  blocks: [
                    { type: 'reasoning', thinkingSignature: `SIG_${sid}_${n}` },
                    { type: 'text' },
                  ],
                },
              }
            : {}),
        };
        return;
      }
      let out;
      if (text.includes('LONG_CASE'))
        out = `原始详细背景：${'用于压缩的真实会话历史。'.repeat(600)}`;
      else if (mode === 'state-check') out = `ASSIST_TEXT_${n} 该轮结论已确认。`;
      else out = `mock：已收到输入（第 ${n} 轮），继续任务。`;
      yield textOut(out);
      yield usageChunk(out.length);
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const adapter = new Mock();
  ctx.llm.registerAdapter(['mock'], adapter);
  ctx.provide('omTestMock', adapter);
  ctx.on('user-questions/request', async (request, next) => {
    if (!request.agent?.session.id.startsWith('omtest-')) return next();
    if (adapter.modes.get(request.agent.session.id) === 'cancelled') {
      const error = new Error('Mock user closed the question');
      error.code = 'ASK_ABORTED';
      throw error;
    }
    return {
      answers: [
        { id: 'comment', selected: [] },
        { id: 'checks', selected: ['单元测试', '集成测试'], custom: '只读检查，不修改代码' },
        { id: 'deploy', selected: ['本地'], custom: '条件：仅测试，保留 ]]> 与 <xml> &' },
      ],
    };
  });
}
