// summarize.ts 单元测试：共享压缩提示词 buildHistoryPrompt、历史解析 parseHistoryEntries /
// historyContinuity、摘要日志提取 extractSummaryLog、子代理摘要 runSummarySubagent、
// 消息渲染 renderMessages（含 <sys> 系统消息块）。
import { describe, expect, it } from 'vitest';

import { COMPACTION_ABORTED_ERROR, HISTORY_TAG, HISTORY_TIP } from '../src/constants.ts';
import {
  buildHistoryPrompt,
  extractSummaryLog,
  HISTORY_FORMAT_NOTE,
  historyContinuity,
  parseHistoryEntries,
  renderMessages,
  runSummarySubagent,
} from '../src/summarize.ts';
import type { SessionEvent } from '../src/types.ts';
import {
  buildToolCallFlow,
  makeCtx,
  makeMessage,
  makeSession,
  textBlock,
  twoCallFlow,
} from './helpers.ts';

describe('共享提示词 buildHistoryPrompt（观察/反思同一套）', () => {
  it('定义 history 块 / 完整消息定义串 / 压缩要求（a-f）/ 输出格式 / 数据源', () => {
    const prompt = buildHistoryPrompt();
    // 任务声明：压缩下方 <history> 记录
    expect(prompt).toContain('压缩 <history> 消息记录。你应当输出**单个**合法的 <history> 块');
    expect(prompt).not.toContain('停止一切现有任务');
    // history 块定义（条目标签语义）
    expect(prompt).toContain('<history> 是历史消息的记录块');
    expect(prompt).toContain('<user_message index="N">：用户消息条目');
    expect(prompt).toContain('<sys type="(kind)" index="N">：系统消息条目');
    expect(prompt).toContain('<reasoning>：模型的思考过程，仅作压缩参考，产物中不要出现');
    expect(prompt).toContain('<assistant index="N">：单条完整消息');
    expect(prompt).toContain('<assistant start="A" end="B">：多条连续完整消息聚合的模块');
    // 压缩要求：用户/系统条目从输入逐条保留（含 XML 转义形式，不解码）
    expect(prompt).toContain('条目从输入中逐条保留，不做任何处理');
    expect(prompt).toContain('<reasoning> 只作参考，输出产物中不包含 <reasoning> 块');
    // 具有关联性的 assistant 块合并；块内描述行为逻辑，强调结论/产出/任务，文件保留完整路径
    expect(prompt).toContain('将具有关联性的 <assistant> 消息');
    expect(prompt).toContain('内在逻辑连贯性');
    expect(prompt).toContain('描述**行为逻辑**');
    expect(prompt).toContain('强调关键的**结论、产出和任务**');
    expect(prompt).toContain('保留完整路径');
    // 单条重要消息单独呈现
    expect(prompt).toContain('单条重要的完整消息以 <assistant index=""> 单独呈现');
    // 加载的 skill：独立块且不过多省略
    expect(prompt).toContain('加载的 skill 属于**关键信息**：应当产出独立块且不过多省略');
    // index/start/end 必须连续
    expect(prompt).toContain('index/start/end 必须连续');
    expect(prompt).toContain('不跳号、不重叠、不遗漏');
    // 输出格式：一个合法 <history> 块（无 reasoning），含 <sys> 空块示例
    expect(prompt).toContain('【输出格式】输出单个合法的 <history> 块，**不包含其他任何内容**');
    expect(prompt).toContain('<user_message index="(index)">');
    expect(prompt).toContain('<sys type="(kind)" index="(index)"></sys>');
    expect(prompt).toContain('<assistant start="(起始 index)" end="(结束 index)">');
    expect(prompt).toContain('<assistant index="(index)">');
    // 数据源说明
    expect(prompt).toContain('【数据源】下方的 <history> 消息记录是本次要压缩的全部消息');
    expect(prompt).not.toContain('message_id');
    expect(prompt).not.toContain('[interrupted]');
  });

  it('摘要粒度：越往后越细（靠前简略、靠后详细），用户消息不受约束', () => {
    const prompt = buildHistoryPrompt();
    expect(prompt).toContain('【摘要粒度】');
    expect(prompt).toContain('越往后越细');
    expect(prompt).toContain('靠近末尾（最近）的完整消息保留更多细节');
    expect(prompt).toContain('开头（较早）的完整消息可适当从简');
    expect(prompt).toContain('用户消息不受此约束：始终逐条保留原文，不做概括与省略');
  });
});

describe('history 条目解析与连续性 parseHistoryEntries / historyContinuity', () => {
  it('解析 user_message/assistant index 与 assistant start..end（合法 <history> 块内）', () => {
    const text = [
      '<history>',
      '<user_message index="0">',
      'x',
      '</user_message>',
      '<assistant start="1" end="2">',
      'm',
      '</assistant>',
      '<assistant index="3">',
      'y',
      '</assistant>',
      '</history>',
    ].join('\n');
    expect(parseHistoryEntries(text)).toEqual([
      { kind: 'user', index: 0 },
      { kind: 'assistant', start: 1, end: 2 },
      { kind: 'assistant', index: 3 },
    ]);
  });

  it('解析 sys 系统消息条目（index 参与连续性校验）', () => {
    const text = [
      '<history>',
      '<sys type="agent-instructions" index="0"></sys>',
      '<user_message index="1">',
      'x',
      '</user_message>',
      '<assistant start="2" end="3">',
      'm',
      '</assistant>',
      '</history>',
    ].join('\n');
    expect(parseHistoryEntries(text)).toEqual([
      { kind: 'sys', index: 0 },
      { kind: 'user', index: 1 },
      { kind: 'assistant', start: 2, end: 3 },
    ]);
    // sys 按单条 index 参与连续性
    expect(
      historyContinuity([
        { kind: 'sys', index: 0 },
        { kind: 'user', index: 1 },
        { kind: 'assistant', start: 2, end: 3 },
      ]),
    ).toEqual({ start: 0, end: 3 });
  });

  it('连续性：单条与模块按序相接（后一条 lo = 前一条 hi + 1）', () => {
    expect(
      historyContinuity([
        { kind: 'user', index: 0 },
        { kind: 'assistant', start: 1, end: 2 },
        { kind: 'assistant', index: 3 },
      ]),
    ).toEqual({ start: 0, end: 3 });
    expect(
      historyContinuity([
        { kind: 'assistant', start: 5, end: 8 },
        { kind: 'assistant', index: 9 },
      ]),
    ).toEqual({ start: 5, end: 9 });
  });

  it('不连续（跳号/重叠）/ 非法范围 / 空条目返回 null', () => {
    expect(historyContinuity([])).toBeNull();
    expect(
      historyContinuity([
        { kind: 'user', index: 0 },
        { kind: 'user', index: 2 },
      ]),
    ).toBeNull(); // 跳号
    expect(
      historyContinuity([
        { kind: 'user', index: 0 },
        { kind: 'user', index: 0 },
      ]),
    ).toBeNull(); // 重叠
    expect(
      historyContinuity([
        { kind: 'user', index: 1 },
        { kind: 'user', index: 0 },
      ]),
    ).toBeNull(); // 乱序不接
    expect(historyContinuity([{ kind: 'assistant', start: 2, end: 1 }])).toBeNull(); // start > end
  });
});

describe('摘要日志提取 extractSummaryLog', () => {
  /** 构造合法日志块（inner 长度足够）。 */
  function block(inner: string): string {
    return `<${HISTORY_TAG}>\n${inner}\n</${HISTORY_TAG}>`;
  }

  it('合法块：取首个 <history> 到最后一个 </history>（含首尾），开标签带 tip 属性，块顶插入格式说明注释', () => {
    const raw = [
      '前置说明不要',
      block('<user_message index="0">\n请帮我完成一个任务\n</user_message>'),
      '尾部多余文字',
    ].join('\n');
    const out = extractSummaryLog(raw);
    expect(out).not.toBeNull();
    expect(out?.startsWith(`<${HISTORY_TAG} tip="${HISTORY_TIP}">`)).toBe(true);
    expect(out?.endsWith(`</${HISTORY_TAG}>`)).toBe(true);
    // tip 属性即对 AI 的提醒；格式说明注释插在带 tip 的开标签之后（块顶）
    expect(out).toContain(`<${HISTORY_TAG} tip="${HISTORY_TIP}">\n${HISTORY_FORMAT_NOTE}`);
    expect(out).toContain('<user_message index="0">');
    expect(out).not.toContain('前置说明不要');
    expect(out).not.toContain('尾部多余文字');
  });

  it('含 <sys> 系统消息空块的日志合法（type/index 保留，连续性含 sys）', () => {
    const raw = block(
      '<sys type="agent-instructions" index="0"></sys>\n<user_message index="1">\nA\n</user_message>',
    );
    const out = extractSummaryLog(raw);
    expect(out).not.toBeNull();
    expect(out).toContain('<sys type="agent-instructions" index="0"></sys>');
    expect(out).toContain('<user_message index="1">');
    // 缺 index 的 <sys> 条目视为不合法
    expect(extractSummaryLog(block('<sys type="agent-instructions"></sys>'))).toBeNull();
  });

  it('多块输出（块间夹杂杂文）按条目模糊合并，index 连续即合法', () => {
    const raw = [
      block('<user_message index="0">\nA\n</user_message>'),
      '这里是第二块：',
      block('<user_message index="1">\nB\n</user_message>'),
    ].join('\n');
    const out = extractSummaryLog(raw);
    expect(out).not.toBeNull();
    expect(out).toContain('<user_message index="0">');
    expect(out).toContain('<user_message index="1">');
    expect(out).not.toContain('这里是第二块：');
  });

  it('条目可恢复的非法 XML 不再整体拒绝（标签不匹配 / 未知元素 / 裸 <）', () => {
    // 标签不匹配：条目按开闭就近配对恢复
    expect(
      extractSummaryLog('<history><user_message index="0">A</assistant></history>'),
    ).not.toBeNull();
    // 未知顶层元素被忽略，其余条目保留
    expect(
      extractSummaryLog(
        '<history><user_message index="0">A</user_message><unknown>x</unknown></history>',
      ),
    ).not.toBeNull();
    // 文本中的裸 < / & 正常接受
    expect(
      extractSummaryLog('<history><user_message index="0">a < b & c</user_message></history>'),
    ).not.toBeNull();
  });

  it('整块非法 XML 时按条目模糊提取重建为合法块', () => {
    // 末尾未闭合条目以文本末尾收口，条目保留
    expect(
      extractSummaryLog(block('<user_message index="0">A</user_message><assistant index="1">B')),
    ).not.toBeNull();
    // 模糊重建统一 XML 转义：已有转义形式解码后重新转义保持不变，杂文与未知元素丢弃
    const out = extractSummaryLog(
      block('<user_message index="0">a &lt; b &amp; c</user_message><extra>占位</extra>'),
    );
    expect(out).not.toBeNull();
    expect(out).toContain('a &lt; b &amp; c');
    expect(out).not.toContain('<extra>');
    expect(out).not.toContain('占位');
  });

  it('开标签携带属性 / 尾部多余闭标签时仍可定位提取', () => {
    const attrs = extractSummaryLog(
      '说明：\n<history lang="zh">\n<user_message index="0">\nA\n</user_message>\n</history>\n完',
    );
    expect(attrs).not.toBeNull();
    expect(attrs?.startsWith(`<${HISTORY_TAG} tip="${HISTORY_TIP}">`)).toBe(true);
    // 尾部出现 </history> 字样时按最后一个闭标签切分，条目仍可恢复且杂文丢弃
    const tail = extractSummaryLog(
      `${block('<user_message index="0">\nA\n</user_message>')}\n以上即 </history> 格式说明`,
    );
    expect(tail).not.toBeNull();
    expect(tail).not.toContain('格式说明');
  });

  it('模糊提取路径同样拒绝产物中的 <reasoning> 块', () => {
    expect(
      extractSummaryLog(
        '<history><user_message index="0">A</assistant><reasoning>思考</reasoning></history>',
      ),
    ).toBeNull();
  });

  it('找不到标签 / 顺序颠倒返回 null', () => {
    expect(extractSummaryLog('没有标签的纯文本')).toBeNull();
    expect(extractSummaryLog(`</${HISTORY_TAG}>\n<${HISTORY_TAG}>`)).toBeNull(); // 闭标签在开标签前
    expect(extractSummaryLog(`只有开标签 <${HISTORY_TAG}> 内容`)).toBeNull();
    expect(extractSummaryLog(`只有闭标签 </${HISTORY_TAG}>`)).toBeNull();
  });

  it('中间内容过短（< MIN_HISTORY_LENGTH）视为不合法', () => {
    expect(extractSummaryLog(block('太短'))).toBeNull();
    expect(extractSummaryLog(block(''))).toBeNull();
    expect(extractSummaryLog(`<${HISTORY_TAG}>\n   \n</${HISTORY_TAG}>`)).toBeNull(); // 空白不算
    expect(extractSummaryLog(block('<user_message index="0">\nX\n</user_message>'))).not.toBeNull(); // 合法条目（长度足够）通过
  });

  it('产物包含 <reasoning> 块视为不合法（仅作参考，输出没有）', () => {
    expect(
      extractSummaryLog(
        block('<user_message index="0">\nA\n</user_message>\n<reasoning>\n思考\n</reasoning>'),
      ),
    ).toBeNull();
    expect(
      extractSummaryLog(
        block('<user_message index="0">\nA\n</user_message>\n<reasoning>思考</reasoning>'),
      ),
    ).toBeNull();
  });

  it('index/start/end 不连续视为不合法', () => {
    expect(extractSummaryLog(block('<user_message index="0">\nA\n</user_message>'))).not.toBeNull();
    // 跳号（0 后直接 2）
    expect(
      extractSummaryLog(
        block(
          '<user_message index="0">\nA\n</user_message>\n<user_message index="2">\nC\n</user_message>',
        ),
      ),
    ).toBeNull();
    // 模块与单条重叠
    expect(
      extractSummaryLog(
        block(
          '<assistant start="0" end="1">\nM\n</assistant>\n<assistant index="1">\nX\n</assistant>',
        ),
      ),
    ).toBeNull();
  });

  it('expected 覆盖区间校验：与预期 start/end 不一致视为不合法', () => {
    const raw = block('<user_message index="0">\nA\n</user_message>');
    expect(extractSummaryLog(raw, { start: 0 })).not.toBeNull();
    expect(extractSummaryLog(raw, { start: 0, end: 0 })).not.toBeNull();
    expect(extractSummaryLog(raw, { start: 1 })).toBeNull(); // 起始 index 不符
    expect(extractSummaryLog(raw, { start: 0, end: 1 })).toBeNull(); // 覆盖区间不符
    // 非 0 起始的观察块（续接旧摘要）：expected.start = 8
    const continued = block('<user_message index="8">\nA\n</user_message>');
    expect(extractSummaryLog(continued, { start: 8, end: 8 })).not.toBeNull();
    // 模糊恢复的条目同样受 expected 区间约束
    expect(
      extractSummaryLog('<history><user_message index="0">A</assistant></history>', { start: 1 }),
    ).toBeNull();
  });
});

describe('runSummarySubagent 结构化结果', () => {
  /** 直连调用的固定入参（agent 仅承载 session 的最小桩，整体按签名断言）。 */
  function callArgs(ctx: ReturnType<typeof makeCtx>, signal?: AbortSignal) {
    const agent = { session: makeSession({ events: twoCallFlow() }) };
    const target = { provider: 'test', model: 'test-model' };
    return [
      ctx,
      agent,
      buildHistoryPrompt(),
      '<history>\n<user_message index="0">旧内容</user_message>\n</history>',
      undefined,
      target,
      false,
      signal,
      { maxAttempts: 2, expected: { start: 0, end: 0 } },
    ] as unknown as Parameters<typeof runSummarySubagent>;
  }

  it('每次尝试的结果/报错始终写日志：成功 info、失败 warn（不受 debug 影响）', async () => {
    let attempts = 0;
    const ctx = makeCtx({
      llmStream: {
        [Symbol.iterator]() {
          attempts += 1;
          const current = attempts;
          return (function* () {
            if (current === 1) throw new Error('网络抖动');
            yield {
              type: 'text-delta',
              text: '<history><user_message index="0">旧内容</user_message></history>',
            };
          })();
        },
      },
    });
    const result = await runSummarySubagent(...callArgs(ctx));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('应成功');
    expect(result.attemptCount).toBe(2);
    const warns = ctx._loggerCalls.filter((c) => c.level === 'warn').map((c) => String(c.args[0]));
    const infos = ctx._loggerCalls.filter((c) => c.level === 'info').map((c) => String(c.args[0]));
    expect(warns.some((w) => w.includes('摘要调用失败（第 1/2 次，网络抖动），将重试'))).toBe(true);
    expect(infos.some((s) => s.includes('摘要调用成功（第 2/2 次'))).toBe(true);
  });

  it('全部尝试耗尽：返回失败结果，error 为最后一次尝试的实际报错', async () => {
    const ctx = makeCtx({
      llmStream: {
        [Symbol.iterator]() {
          return {
            next() {
              throw new Error('额度不足');
            },
          };
        },
      },
    });
    const result = await runSummarySubagent(...callArgs(ctx));
    expect(result).toEqual({
      ok: false,
      error: '额度不足',
      aborted: false,
      diagnosticSessionId: expect.any(String),
    });
    const warns = ctx._loggerCalls.filter((c) => c.level === 'warn').map((c) => String(c.args[0]));
    expect(
      warns.some((w) => w.includes('摘要调用最终失败（已尝试 2 次，最后错误：额度不足）')),
    ).toBe(true);
  });

  it('校验失败耗尽：error 为具体问题说明（非解析器原始报错）', async () => {
    const ctx = makeCtx({
      llmStream: [{ type: 'text-delta', text: '没有 history 块的输出' }],
    });
    const result = await runSummarySubagent(...callArgs(ctx));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('应失败');
    expect(result.aborted).toBe(false);
    expect(result.error).toContain('找不到完整的 <history> 块');
    expect(result.error).not.toMatch(/xmldom|ParseError/i); // 不携带解析器原始报错
  });

  it('signal 中止：返回 aborted=true，error 为共享中止标识', async () => {
    const controller = new AbortController();
    const ctx = makeCtx({
      llmStream: {
        [Symbol.iterator]() {
          return {
            next() {
              controller.abort(); // 第一次尝试失败后中止，第二次尝试前检测到
              throw new Error('模拟失败');
            },
          };
        },
      },
    });
    const result = await runSummarySubagent(...callArgs(ctx, controller.signal));
    expect(result).toEqual({
      ok: false,
      error: COMPACTION_ABORTED_ERROR,
      aborted: true,
      diagnosticSessionId: expect.any(String),
    });
  });
});

describe('runSummarySubagent 最终失败的诊断子会话落盘', () => {
  /** 直连调用的固定入参（phase 反思；agent 仅承载 session 的最小桩）。 */
  function callArgsWithPhase(ctx: ReturnType<typeof makeCtx>, signal?: AbortSignal) {
    const agent = { session: makeSession({ events: twoCallFlow() }) };
    const target = { provider: 'test', model: 'test-model' };
    return [
      ctx,
      agent,
      buildHistoryPrompt(),
      '<history>\n<user_message index="0">旧内容</user_message>\n</history>',
      undefined,
      target,
      false,
      signal,
      { maxAttempts: 2, expected: { start: 0, end: 0 }, phase: 'reflect' as const },
    ] as unknown as Parameters<typeof runSummarySubagent>;
  }

  it('校验失败耗尽：每次尝试的完整提示词与模型原始输出落盘为诊断子会话', async () => {
    const ctx = makeCtx({
      llmStream: [{ type: 'text-delta', text: '没有 history 块的输出' }],
    });
    const result = await runSummarySubagent(...callArgsWithPhase(ctx));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('应失败');
    const created = ctx._createdSessions[0];
    expect(created).toBeDefined();
    expect(result.diagnosticSessionId).toBe(created?.id);
    const child = created?.session;
    expect(child?.events[0]?.type).toBe('subagent/descriptor');
    expect(child?.events[0]?.data).toMatchObject({
      version: 2,
      mode: 'one-shot',
      provider: 'om-compaction-log',
      label: 'OM 压缩失败日志（反思 · 2 次尝试）',
    });
    // 每次尝试一对消息：提示词（system 指令 + 渲染输入拼接）与原始输出原样
    expect(child?.events).toHaveLength(5);
    for (let i = 0; i < 2; i += 1) {
      const user = child?.events[1 + i * 2];
      const assistant = child?.events[2 + i * 2];
      const userText = (user?.data as { content?: Array<{ text?: string }> } | undefined)
        ?.content?.[0]?.text;
      expect(userText).toBe(
        `${buildHistoryPrompt()}\n\n<history>\n<user_message index="0">旧内容</user_message>\n</history>`,
      );
      const rawText = (
        assistant?.data as { message?: { content?: Array<{ text?: string }> } } | undefined
      )?.message?.content?.[0]?.text;
      expect(rawText).toBe('没有 history 块的输出');
    }
  });

  it('流异常后中止：异常尝试的部分输出也进入诊断子会话，中止结果同样落盘', async () => {
    const controller = new AbortController();
    const ctx = makeCtx({
      llmStream: {
        [Symbol.iterator]() {
          return {
            next() {
              controller.abort(); // 第一次尝试流中途失败后中止，第二次尝试前检测到
              throw new Error('模拟失败');
            },
          };
        },
      },
    });
    const result = await runSummarySubagent(...callArgsWithPhase(ctx, controller.signal));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('应失败');
    expect(result.aborted).toBe(true);
    // 仅第一次尝试有消息组；第二次尝试在请求前中止，不产生消息
    const created = ctx._createdSessions[0];
    expect(created).toBeDefined();
    expect(result.diagnosticSessionId).toBe(created?.id);
    const child = created?.session;
    expect(child?.events).toHaveLength(3);
    const partial = (
      child?.events[2]?.data as { message?: { content?: Array<{ text?: string }> } } | undefined
    )?.message?.content?.[0]?.text;
    expect(partial).toBe('');
  });

  it('signal 预先中止（0 次尝试）：仍落盘仅含 descriptor 的诊断子会话', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = makeCtx();
    const result = await runSummarySubagent(...callArgsWithPhase(ctx, controller.signal));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('应失败');
    expect(result.aborted).toBe(true);
    expect(result.diagnosticSessionId).toBe(ctx._createdSessions[0]?.id);
    expect(ctx._createdSessions[0]?.session.events).toHaveLength(1);
    expect(ctx._createdSessions[0]?.session.events[0]?.type).toBe('subagent/descriptor');
  });
});

describe('消息渲染 renderMessages', () => {
  it('完整消息渲染：<user_message index> + <assistant index>（文本与 toolcall 分条）', () => {
    const flow = buildToolCallFlow({
      code: 'a()',
      description: '任务A',
      callId: 'c1',
      resultText: 'r1',
      userMessageId: 'u1',
      assistantMessageId: 'a1',
      resultMessageId: 'r1m',
    });
    const session = makeSession({ events: flow }); // 表层 [0,1,3]
    const text = renderMessages(session, [0, 1, 3]);
    // 输入输出都是合法的 <history> 块
    expect(text.startsWith('<history>\n')).toBe(true);
    expect(text.endsWith('\n</history>')).toBe(true);
    // 用户消息 → <user_message index="0">（原文完整保留，仅文本）
    expect(text).toContain('<user_message index="0">');
    expect(text).toContain('请帮我完成一个任务');
    expect(text).toContain('</user_message>');
    // 文本与 toolcall 拆开：文本 index=1，toolcall（调用+结果）index=2（内容原样）
    expect(text).toContain('<assistant index="1">');
    expect(text).toContain('我来执行代码');
    expect(text).toContain('<assistant index="2">');
    expect(text).toContain('[tool-call run_code id=c1]');
    expect(text).toContain('r1');
    expect(text).toContain('[result]');
    expect(text).not.toContain('message_id');
  });

  it('用户消息图片/文件块以注释补充（文本原样），assistant reasoning 输出 <reasoning> 参考条目', () => {
    const events = [
      {
        type: 'user/message',
        data: makeMessage({
          content: [
            textBlock('看图说话'),
            {
              type: 'image',
              attachment: {
                attachmentId: 'att-1',
                mediaType: 'image/png',
                bytes: 1024,
                width: 800,
                height: 600,
                name: '图.png',
              },
            },
            { type: 'file', name: 'a.txt' } as never, // 未知块类型走通用注释
          ],
          id: 'u-img',
        }),
      } as unknown as SessionEvent,
      {
        type: 'assistant/message',
        data: {
          message: makeMessage({
            role: 'assistant',
            content: [{ type: 'reasoning', text: '先看图再回答' }, textBlock('这是答案')],
            source: { kind: 'model', provider: 'test', model: 'test-model' },
            id: 'a-think',
          }),
        },
      } as unknown as SessionEvent,
    ];
    const session = makeSession({ events });
    const text = renderMessages(session, [0, 1]);
    // 用户消息：文本原样 + 图片注释（名称/媒体类型/尺寸/字节数）+ 通用块注释
    expect(text).toContain('<user_message index="0">');
    expect(text).toContain('看图说话');
    expect(text).toContain('<!-- 图片附件：图.png（image/png 800×600，1024 bytes） -->');
    expect(text).toContain('<!-- file 块 -->');
    // reasoning 参考条目（产物中没有，但输入保留；DOM 序列化紧凑、文本自动转义）；assistant 文本原样
    expect(text).toContain('<reasoning>先看图再回答</reasoning>');
    expect(text).toContain('<assistant index="1">');
    expect(text).toContain('这是答案');
    // reasoning 不是完整消息：不占 index（assistant 文本仍为 index 1）
    expect(text).toContain('<user_message index="0">');
    expect(text).toContain('<assistant index="1">');
  });

  it('相邻用户消息各占一条（index 0/1）；区间外完整消息不渲染', () => {
    const session = makeSession({
      events: [
        {
          type: 'user/message',
          data: makeMessage({ content: [textBlock('你好')], id: 'u1' }),
        } as unknown as SessionEvent,
        {
          type: 'user/message',
          data: makeMessage({ content: [textBlock('再见')], id: '' }),
        } as unknown as SessionEvent,
        {
          type: 'user/message',
          data: makeMessage({ content: [textBlock('区间外')], id: 'u3' }),
        } as unknown as SessionEvent,
      ],
    });
    const text = renderMessages(session, [0, 1]);
    expect(text.startsWith('<history>\n')).toBe(true);
    expect(text).toContain('<user_message index="0">');
    expect(text).toContain('你好');
    expect(text).toContain('<user_message index="1">');
    expect(text).toContain('再见');
    expect(text).not.toContain('区间外'); // 不在遮蔽集合内
  });

  it('用户消息中的 <system-reminder> 文本按普通文本转义（不再特殊保留）', () => {
    const reminder = [
      '<system-reminder>',
      'The following workspace instructions may be relevant.',
      'Instructions from: AGENTS.md',
      '</system-reminder>',
    ].join('\n');
    const session = makeSession({
      events: [
        {
          type: 'user/message',
          data: makeMessage({ content: [textBlock(`我的问题\n${reminder}\n请继续`)], id: 'u-sr' }),
        } as unknown as SessionEvent,
      ],
    });
    const text = renderMessages(session, [0]);
    // 标签转义为实体，内容文本原样（普通字符不转义）
    expect(text).toContain('&lt;system-reminder&gt;');
    expect(text).toContain('The following workspace instructions may be relevant.');
    expect(text).toContain('Instructions from: AGENTS.md');
    expect(text).toContain('&lt;/system-reminder&gt;');
    expect(text).not.toContain('<system-reminder>');
    // 块外文本原样保留
    expect(text).toContain('我的问题');
    expect(text).toContain('请继续');
  });

  it('含 <system-reminder> 标签的残缺/非法文本也整体转义（统一按文本处理）', () => {
    const noClose = makeSession({
      events: [
        {
          type: 'user/message',
          data: makeMessage({
            content: [textBlock('<system-reminder>no closing')],
            id: 'u-sr1',
          }),
        } as unknown as SessionEvent,
      ],
    });
    expect(renderMessages(noClose, [0])).toContain('&lt;system-reminder&gt;no closing');
    const invalidContent = makeSession({
      events: [
        {
          type: 'user/message',
          data: makeMessage({
            content: [textBlock('<system-reminder><inner></system-reminder>')],
            id: 'u-sr2',
          }),
        } as unknown as SessionEvent,
      ],
    });
    expect(renderMessages(invalidContent, [0])).toContain(
      '&lt;system-reminder&gt;&lt;inner&gt;&lt;/system-reminder&gt;',
    );
  });
});

describe('系统消息渲染（<sys> 空块）', () => {
  it('非 kind:user 的 user_message 渲染为 <sys type="KIND" index="N"></sys> 空块，内容不进入输入', () => {
    const session = makeSession({
      events: [
        {
          type: 'user/message',
          data: makeMessage({
            content: [textBlock('宿主注入的工作区指令，内容很长不需要进入压缩输入')],
            source: { kind: 'agent-instructions' },
            id: 's1',
          }),
        } as unknown as SessionEvent,
        {
          type: 'user/message',
          data: makeMessage({ content: [textBlock('真正的用户消息')], id: 'u1' }),
        } as unknown as SessionEvent,
      ],
    });
    const text = renderMessages(session, [0, 1]);
    // sys 空块：type=source.kind、index=完整消息序号；用户消息照常渲染
    expect(text).toContain('<sys type="agent-instructions" index="0"></sys>');
    expect(text).toContain('<user_message index="1">');
    expect(text).toContain('真正的用户消息');
    // 系统消息内容不进入压缩输入
    expect(text).not.toContain('宿主注入的工作区指令');
  });

  it('无 source.kind 的 user_message 归为系统消息，渲染为 <sys type="" index="N"></sys>', () => {
    const session = makeSession({
      events: [
        {
          type: 'user/message',
          data: { id: 's0', role: 'user', content: [textBlock('x')] },
        } as unknown as SessionEvent,
      ],
    });
    expect(renderMessages(session, [0])).toContain('<sys type="" index="0"></sys>');
  });
});
