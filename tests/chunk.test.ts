// 观察分块单元测试：chunkCompleteMessages（token 边界切块 / 完整消息不跨块）与
// mergeChunkReports（剥离外壳合并为单个 <history> 块，可再经 extractSummaryLog 校验）。
import { describe, expect, it } from 'vitest';

import { chunkCompleteMessages, mergeChunkReports } from '../src/compress.ts';
import { indexCompleteMessages } from '../src/log-index.ts';
import { extractSummaryLog } from '../src/summarize.ts';
import type { SessionEvent } from '../src/types.ts';
import { makeMessage, makeSession, textBlock } from './helpers.ts';

/** 构造一个会话：给定文本序列 → 每条一个 user/message 事件。 */
function userSession(texts: string[]) {
  return makeSession({
    events: texts.map(
      (text) =>
        ({
          type: 'user/message' as const,
          data: makeMessage({ role: 'user', content: [textBlock(text)] }),
        }) as unknown as SessionEvent,
    ),
  });
}

/** 固定估算器：每条完整消息按给定 token 数计（忽略实际内容）。 */
function fixedTokens(tokens: number) {
  return () => tokens;
}

describe('chunkCompleteMessages（观察分块）', () => {
  it('空输入返回空数组', () => {
    const session = userSession([]);
    expect(chunkCompleteMessages(session, [], 30000, fixedTokens(10))).toEqual([]);
  });

  it('未超界时全部消息为一块', () => {
    const session = userSession(['m0', 'm1', 'm2']);
    const cms = indexCompleteMessages(session);
    const chunks = chunkCompleteMessages(session, cms, 100, fixedTokens(10));
    expect(chunks).toHaveLength(1);
    const first = chunks[0];
    expect(first?.map((cm) => cm.index)).toEqual([0, 1, 2]);
  });

  it('按 token 边界切块：30 tokens 边界下 4×10 tokens 切成 3+1', () => {
    const session = userSession(['m0', 'm1', 'm2', 'm3']);
    const cms = indexCompleteMessages(session);
    const chunks = chunkCompleteMessages(session, cms, 30, fixedTokens(10));
    expect(chunks.map((c) => c.map((cm) => cm.index))).toEqual([[0, 1, 2], [3]]);
  });

  it('累计恰好等于边界时不切块（> 边界才切）', () => {
    const session = userSession(['m0', 'm1', 'm2', 'm3']);
    const cms = indexCompleteMessages(session);
    const chunks = chunkCompleteMessages(session, cms, 40, fixedTokens(10));
    expect(chunks.map((c) => c.map((cm) => cm.index))).toEqual([[0, 1, 2, 3]]);
  });

  it('完整消息不跨块：单条超界的消息独立成块', () => {
    const session = userSession(['m0', 'm1', 'm2']);
    const cms = indexCompleteMessages(session);
    // 第一条 50 tokens（超界），后两条各 10 tokens
    const chunks = chunkCompleteMessages(session, cms, 30, (message: unknown) => {
      const text = String(
        (message as { content?: Array<{ text?: unknown }> }).content?.[0]?.text ?? '',
      );
      return text.includes('m0') ? 50 : 10;
    });
    expect(chunks.map((c) => c.map((cm) => cm.index))).toEqual([[0], [1, 2]]);
  });

  it('分块保持完整消息的相对顺序与覆盖（全部消息、无遗漏）', () => {
    const session = userSession(['m0', 'm1', 'm2', 'm3', 'm4']);
    const cms = indexCompleteMessages(session);
    const chunks = chunkCompleteMessages(session, cms, 25, fixedTokens(10));
    const flat = chunks.flat().map((cm) => cm.index);
    expect(flat).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('mergeChunkReports（分块摘要合并）', () => {
  it('剥离各块 <history> 外壳拼接为单个带 tip 的 <history> 块（块内容原样保留）', () => {
    const p0 = [
      '<history>',
      '<user_message index="0">',
      '消息A（足够长的内容占位）',
      '</user_message>',
      '</history>',
    ].join('\n');
    const p1 = [
      '<history>',
      '<user_message index="1">',
      '消息B（足够长的内容占位）',
      '</user_message>',
      '</history>',
    ].join('\n');
    const merged = mergeChunkReports([p0, p1]);
    expect(merged.startsWith('<history tip="')).toBe(true);
    expect(merged.endsWith('</history>')).toBe(true);
    expect(merged).toContain('<user_message index="0">');
    expect(merged).toContain('<user_message index="1">');
    expect(merged.match(/<history/g)).toHaveLength(1); // 只有合并后的一个开标签
  });

  it('合并结果结构合法：去掉 tip 属性后可再经 extractSummaryLog 解析（index 连续）', () => {
    const p0 = [
      '<history>',
      '<user_message index="0">',
      '较早块：第一段内容占位文本',
      '</user_message>',
      '</history>',
    ].join('\n');
    const p1 = [
      '<history>',
      '<user_message index="1">',
      '最后块：第二段内容占位文本',
      '</user_message>',
      '</history>',
    ].join('\n');
    const merged = mergeChunkReports([p0, p1]);
    const plain = merged.replace(/^<history[^>]*>/, '<history>');
    expect(extractSummaryLog(plain)).not.toBeNull();
  });

  it('块内容原样保留（含格式说明注释）', () => {
    const p0 = [
      '<history>',
      '<!-- 块内注释 -->',
      '<user_message index="0">',
      '注释保留内容占位',
      '</user_message>',
      '</history>',
    ].join('\n');
    const merged = mergeChunkReports([p0]);
    expect(merged).toContain('<!-- 块内注释 -->');
  });

  it('无外壳的块原样保留', () => {
    const merged = mergeChunkReports(['<user_message index="0">', '内容占位', '</user_message>']);
    expect(merged).toContain('<user_message index="0">');
  });
});
