// compaction-eval skill 脚本单元测试：多帧 zstd 日志读取、会话日志 zip 读取、压缩日志解析（阶段、区间、模型、
// 失败标记、逐轮模型耗时、含缓存的 token、completeCompression 产物、原文视图）、分组选择、原文视图
// 选择、候选列表、盲化产物、按区间终点定位的后续轨迹（过滤系统注入、只取正文）、分段行号、
// 区间三等分、可复现洗牌，以及 aggregate 的双评审均值、四维评分、评审校验报错与按模型汇总。

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';

import {
  modelSummary,
  positionChars,
  referenceVariants,
  scoreAll,
  weightedRatio,
} from '../.agents/skills/compaction-eval/scripts/aggregate.ts';
import { type FactList, factsHash } from '../.agents/skills/compaction-eval/scripts/judging.ts';
import {
  blindProduct,
  buckets,
  buildAfter,
  type CompactionLog,
  formatCandidates,
  type Phase,
  parseLog,
  pickSource,
  prepareEvalDir,
  segmentLines,
  selectGroup,
  shuffle,
} from '../.agents/skills/compaction-eval/scripts/prepare.ts';
import {
  loadLog,
  readZip,
  type SessionEvent,
} from '../.agents/skills/compaction-eval/scripts/session-source.ts';
import { INITIAL_HISTORY_HEADER, SKILL_INVOCATION_KIND } from '../src/constants.ts';
import type { SessionEvent as SrcEvent } from '../src/types.ts';
import {
  buildToolCallFlow,
  historyMessage,
  hostLog,
  makeMessage,
  textBlock,
  twoCallFlow,
} from './helpers.ts';

/** 测试用临时目录。 */
const dirs: string[] = [];

/** 新建临时目录。 */
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'ce-test-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 文本 content。 */
const txt = (text: string): { type: 'text'; text: string }[] => [{ type: 'text', text }];

/**
 * 构造一个两次 getHistory、两轮 usage 的压缩日志。
 * 两轮 step/start→assistant/message 分别为 1s 与 0.5s，中间 1s 视为限流等待；
 * completeCompression 的 result 用 message.toolCallId 关联（真实日志形态），
 * 其后还有一个被补「未执行」记录的调用，产物必须取自 completeCompression。
 */
function compactionEvents(): SessionEvent[] {
  return [
    { type: 'session', id: 'om-compaction-log-x', parentSession: 'session-main', createdAt: 5 },
    {
      type: 'subagent/descriptor',
      time: 1000,
      data: { label: 'OM会话(0-9)-反思-重压缩' },
    },
    { type: 'user/message', time: 1000, data: { content: txt('压缩 区间 [0..9] 的消息') } },
    { type: 'step/start', time: 1000 },
    {
      type: 'tool/call',
      time: 1200,
      data: { callId: 'c1', name: 'getHistory', arguments: '{"start":0,"end":4}' },
    },
    { type: 'tool/result', time: 1300, data: { callId: 'c1', message: { content: txt('part') } } },
    {
      type: 'tool/call',
      time: 1400,
      data: { callId: 'c2', name: 'getHistory', arguments: '{}' },
    },
    { type: 'tool/result', time: 1500, data: { callId: 'c2', message: { content: txt('full') } } },
    {
      type: 'assistant/message',
      time: 2000,
      data: { message: { content: txt('ok') }, usage: { inputTokens: 10, outputTokens: 2 } },
    },
    { type: 'step/start', time: 3000 },
    {
      type: 'tool/call',
      time: 3000,
      data: { callId: 'c3', name: 'completeCompression', arguments: '{}' },
    },
    {
      type: 'tool/result',
      time: 3000,
      data: { message: { content: txt('<history>产物</history>'), toolCallId: 'c3' } },
    },
    {
      type: 'tool/call',
      time: 3000,
      data: { callId: 'c4', name: 'getHistory', arguments: '{}' },
    },
    {
      type: 'tool/result',
      time: 3000,
      data: {
        message: {
          content: txt('压缩循环未执行此工具调用'),
          toolCallId: 'c4',
          isError: true,
        },
      },
    },
    {
      type: 'assistant/message',
      time: 3500,
      data: {
        message: { content: txt('压缩使用模型 p/glm-5（max），原始消息 100 字符') },
        usage: { inputTokens: 20, outputTokens: 3, cacheReadTokens: 200, cacheWriteTokens: 100 },
      },
    },
  ];
}

describe('prepare', () => {
  it('loadLog 读取追加写入的多帧 zstd', () => {
    const d = tmp();
    const f = join(d, 'session.v4.jsonl.zstd');
    const frames = ['{"type":"a"}\n', '{"type":"b"}\n', '{"type":"c"}\n'].map((s) =>
      zstdCompressSync(Buffer.from(s)),
    );
    writeFileSync(f, Buffer.concat(frames));
    expect(loadLog(f).map((e) => e.type)).toEqual(['a', 'b', 'c']);
  });

  /** 写出会话日志 zip，内容为 路径 → 事件列表或原始文本。 */
  function writeZip(entries: Record<string, SessionEvent[] | string>): string {
    const f = join(tmp(), 'dsh-session-x.zip');
    const files = Object.fromEntries(
      Object.entries(entries).map(([name, v]) => [
        name,
        strToU8(typeof v === 'string' ? v : v.map((e) => JSON.stringify(e)).join('\n')),
      ]),
    );
    writeFileSync(f, zipSync(files));
    return f;
  }

  it('readZip 取根日志为主会话，只收 subagents 下的压缩日志', () => {
    const log = (id: string): SessionEvent[] => [
      { ...compactionEvents()[0], type: 'session', id },
      ...compactionEvents().slice(1),
    ];
    const f = writeZip({
      'session.v4.jsonl': [{ type: 'session', id: 'session-main' }, { type: 'user/message' }],
      'subagents/om-compaction-log-a/session.v4.jsonl': log('om-compaction-log-a'),
      'subagents/om-compaction-log-b/session.v4.jsonl': log('om-compaction-log-b'),
      'subagents/session-helper/session.v4.jsonl': [{ type: 'session', id: 'session-helper' }],
      'media/img.png': 'binary',
    });
    const { main, logs } = readZip(f);
    expect(main.map((e) => e.type)).toEqual(['session', 'user/message']);
    const parsed = logs.map(parseLog);
    expect(parsed.map((x) => x.id).sort()).toEqual(['om-compaction-log-a', 'om-compaction-log-b']);
    expect(parsed[0]).toMatchObject({ parent: 'session-main', phase: 'reflect', range: [0, 9] });
  });

  it('readZip 缺压缩日志或根日志时报错', () => {
    const noLogs = writeZip({ 'session.v4.jsonl': [{ type: 'session', id: 'session-main' }] });
    expect(() => readZip(noLogs)).toThrow('subagents');
    const noMain = writeZip({
      'subagents/om-compaction-log-a/session.v4.jsonl': compactionEvents(),
    });
    expect(() => readZip(noMain)).toThrow('根会话日志');
  });

  it('parseLog 提取阶段、区间、模型、耗时、token、产物与视图', () => {
    const log = parseLog(compactionEvents());
    expect(log).toMatchObject({
      id: 'om-compaction-log-x',
      parent: 'session-main',
      phase: 'reflect',
      failed: false,
      range: [0, 9],
      model: 'p/glm-5',
      effort: 'max',
      recompress: true,
      wall_sec: 2.5,
      model_sec: 1.5,
      requests: 2,
      tokens_in: 330,
      tokens_cache_read: 200,
      tokens_cache_write: 100,
      tokens_out: 5,
      product: '<history>产物</history>',
    });
    expect(log.views.map(([, v]) => v)).toEqual(['part', 'full']);
  });

  it('parseLog 只收集首次成功 compressHistory 之前的视图，压缩后视图不作原文', () => {
    const call = (callId: string, name: string, args: string): SessionEvent => ({
      type: 'tool/call',
      time: 1450,
      data: { callId, name, arguments: args },
    });
    const result = (callId: string, text: string, isError = false): SessionEvent => ({
      type: 'tool/result',
      time: 1450,
      data: { callId, message: { content: txt(text), isError } },
    });
    const indexAfter = (ev: SessionEvent[], callId: string): number =>
      ev.findIndex((e) => e.type === 'tool/result' && e.data?.callId === callId) + 1;
    const ev = compactionEvents();
    // 失败的压缩不改变状态，其后的视图仍是原文
    ev.splice(
      indexAfter(ev, 'c1'),
      0,
      call('x1', 'compressHistory', '{"start":5,"end":4,"content":"x"}'),
      result('x1', 'start 5 不能大于 end 4', true),
    );
    // 成功压缩后的视图显示本次摘要
    ev.splice(
      indexAfter(ev, 'c2'),
      0,
      call('x2', 'compressHistory', '{"start":1,"end":4,"content":"摘要"}'),
      result('x2', '已压缩'),
      call('x3', 'getHistory', '{}'),
      result('x3', 'after'),
    );
    expect(parseLog(ev).views.map(([, v]) => v)).toEqual(['part', 'full']);
    // 压缩前只有部分视图：压缩后的全区间视图也不作原文
    const log = parseLog(ev.filter((e) => e.data?.callId !== 'c2'));
    expect(log.views.map(([, v]) => v)).toEqual(['part']);
    expect(pickSource([log], 0, 9)).toBe('part');
  });

  it('parseLog 把首条消息预注入的区间条目作为全区间原文视图', () => {
    const ev = compactionEvents().map((e) =>
      e.type === 'user/message'
        ? {
            ...e,
            data: {
              content: txt(`压缩 区间 [0..9] 的消息\n\n${INITIAL_HISTORY_HEADER}\ninjected`),
            },
          }
        : e,
    );
    const log = parseLog(ev);
    expect(log.range).toEqual([0, 9]);
    expect(log.views.map(([, v]) => v)).toEqual(['injected', 'part', 'full']);
    expect(pickSource([log], 0, 9)).toBe('injected');
  });

  it('parseLog 识别默认思考等级、失败后缀与缺失产物', () => {
    const ev = compactionEvents();
    ev[1] = {
      type: 'subagent/descriptor',
      time: 1000,
      data: { label: 'OM会话-观察-失败' },
    };
    const info = ev.findLast((e) => e.type === 'assistant/message');
    if (info?.data?.message)
      info.data.message.content = txt('压缩使用模型 p/glm-5（默认思考等级），原始消息 100 字符');
    for (const e of ev) {
      if (e.data?.message?.toolCallId === 'c3') e.data.message.isError = true;
    }
    expect(parseLog(ev)).toMatchObject({
      phase: 'observe',
      failed: true,
      model: 'p/glm-5',
      effort: '默认思考等级',
      product: '',
    });
  });

  it('prepareEvalDir 清除旧候选与评分，已有评审产物时拒绝写入', () => {
    const dir = join(tmp(), 'eval-x');
    prepareEvalDir(dir);
    expect(readdirSync(dir)).toEqual([]);
    for (const n of ['V1.xml', 'V12.xml', 'scores.json', 'scores.md', 'source.xml', 'notes.txt'])
      writeFileSync(join(dir, n), 'x');
    prepareEvalDir(dir);
    // 候选变少时旧 V*.xml 不能残留，旧评分不能对上新编号
    expect(readdirSync(dir).sort()).toEqual(['notes.txt', 'source.xml']);

    for (const review of ['facts.json', 'judge-V1-1.json', 'parts']) {
      const d = tmp();
      writeFileSync(join(d, 'V1.xml'), 'x');
      if (review === 'parts') mkdirSync(join(d, review));
      else writeFileSync(join(d, review), '{}');
      expect(() => prepareEvalDir(d)).toThrow(new RegExp(`已有评审产物 ${review}.*先删除该目录`));
      // 报错时不动任何文件
      expect(readdirSync(d).sort()).toEqual(['V1.xml', review].sort());
    }
  });

  it('selectGroup 按阶段分组，同区间多阶段需显式指定', () => {
    const base = parseLog(compactionEvents());
    const mk = (phase: Phase, created: number, range: [number, number]): CompactionLog => ({
      ...base,
      phase,
      created,
      range,
    });
    const logs = [
      mk('observe', 1, [0, 9]),
      mk('reflect', 2, [0, 9]),
      mk('observe', 3, [10, 20]),
      mk('observe', 4, [10, 20]),
    ];
    expect(() => selectGroup(logs, '0..9')).toThrow(/--phase/);
    expect(selectGroup(logs, '0..9', 'reflect')).toMatchObject({ phase: 'reflect', lo: 0, hi: 9 });
    expect(selectGroup(logs, '0..9', '反思').logs).toHaveLength(1);
    expect(selectGroup(logs)).toMatchObject({ phase: 'observe', lo: 10, hi: 20 });
    expect(selectGroup(logs, undefined, 'observe')).toMatchObject({
      phase: 'observe',
      lo: 10,
      hi: 20,
    });
    expect(selectGroup(logs, undefined, 'observe').logs).toHaveLength(2);
    expect(() => selectGroup(logs, undefined, 'x')).toThrow(/observe\/reflect/);
    expect(() => selectGroup(logs, '30..40')).toThrow(/没有匹配/);
  });

  it('pickSource 优先覆盖全区间的原始压缩视图', () => {
    const base = parseLog(compactionEvents());
    const original: CompactionLog = {
      ...base,
      recompress: false,
      views: [[{ start: 0, end: 9 }, 'orig']],
    };
    expect(pickSource([base, original], 0, 9)).toBe('orig');
    expect(pickSource([base], 0, 9)).toBe('full');
    const partial: CompactionLog = { ...base, views: [[{ start: 0, end: 4 }, 'ab']] };
    expect(pickSource([partial], 0, 9)).toBe('ab');
  });

  it('blindProduct 去注释并省略 skill 原文', () => {
    const out = blindProduct('<!-- 提示 --><skill_content name="s">长文</skill_content>摘要');
    expect(out).toBe('<skill_content name="s">[skill 原文逐字保留，已省略]</skill_content>摘要');
  });

  it('buildAfter 从区间终点完整消息之后截取，过滤系统注入且只取助手正文', () => {
    const extra: SrcEvent[] = [
      historyMessage('旧摘要'),
      {
        type: 'user/message',
        data: makeMessage({
          content: [textBlock('真实指令')],
          source: { kind: SKILL_INVOCATION_KIND, name: 'grilling' },
        }),
      } as unknown as SrcEvent,
      {
        type: 'user/message',
        data: makeMessage({
          content: [textBlock('运行时注入')],
          source: { kind: 'runtime-context' },
        }),
      } as unknown as SrcEvent,
      {
        type: 'assistant/message',
        data: {
          message: makeMessage({
            role: 'assistant',
            content: [{ type: 'reasoning', text: '内心独白' }, textBlock('正文回复')],
            source: { kind: 'model', provider: 'p', model: 'm' },
          }),
        },
      } as unknown as SrcEvent,
      ...buildToolCallFlow({
        code: 'x()',
        description: '后续调用',
        callId: 'k9',
        resultText: 'done',
      }),
      { type: 'compaction/start', data: {} } as unknown as SrcEvent,
    ];
    // twoCallFlow 折叠为完整消息 0..5，终点 5 的最大 seq 为 7
    const main = hostLog([...twoCallFlow(), ...extra]);
    const { text, start } = buildAfter(main, 5, 100000);
    expect(start).toBe(8);
    expect(text).toContain('[SKILL grilling] 真实指令');
    expect(text).toContain('[ASSISTANT] 正文回复');
    expect(text).toContain('[TOOL run_code]');
    expect(text).toContain('===== compaction/start =====');
    expect(text).not.toContain('旧摘要');
    expect(text).not.toContain('运行时注入');
    expect(text).not.toContain('内心独白');
    expect(text).not.toContain('[USER] 运行时注入');
    // 区间内与终点前的内容不进入后续轨迹
    expect(text).not.toContain('第一次');
    expect(text).not.toContain('out1');
    // 截断上限生效
    expect(buildAfter(main, 5, 60).text).toContain('已截断');
  });

  it('buildAfter 区间终点超出主会话完整消息时报错', () => {
    expect(() => buildAfter(hostLog(twoCallFlow()), 99, 60)).toThrow(/完整消息 99/);
  });

  it('buildAfter 支持文本终点与同一 assistant 事件内终点，无后续时为空', () => {
    const main = hostLog(twoCallFlow());
    // 终点 1 为 assistant 文本条目：其后同一 assistant 事件的 tool-call 也要进入轨迹
    const fromText = buildAfter(main, 1, 100000);
    expect(fromText.start).toBe(2);
    expect(fromText.text).toContain('第一次');
    expect(fromText.text).toContain('out2');
    // 终点 4 为第二条流程的 assistant 文本条目（同一事件还承载 tool-call 条目 5）
    const midEvent = buildAfter(main, 4, 100000);
    expect(midEvent.start).toBe(6);
    expect(midEvent.text).toContain('[TOOL run_code]');
    expect(midEvent.text).not.toContain('第一次');
    // 终点 5 为最后一条完整消息，其后无事件
    const none = buildAfter(main, 5, 100000);
    expect(none.start).toBe(8);
    expect(none.text).toBe('');
  });

  it('segmentLines 给出各分段在 source.xml 中的行区间，空分段为 null', () => {
    const xml = [
      '<reasoning><![CDATA[想]]></reasoning>',
      '<user_message index="0"><![CDATA[u0]]></user_message>',
      '<assistant index="1"><![CDATA[a1]]></assistant>',
      '<reasoning><![CDATA[想2]]></reasoning>',
      '<assistant index="2"><![CDATA[a2]]></assistant>',
    ].join('\n');
    // reasoning 无 index，随其后第一个有 index 的条目分段（开头的 reasoning 归 head，行 4 的归 tail）
    expect(segmentLines(xml, buckets(0, 2))).toEqual({
      head: [1, 2],
      mid: [3, 3],
      tail: [4, 5],
    });
    const skipMid = [
      '<user_message index="0"><![CDATA[u0]]></user_message>',
      '<user_message index="1"><![CDATA[u1]]></user_message>',
      '<assistant index="4"><![CDATA[a4]]></assistant>',
    ].join('\n');
    expect(segmentLines(skipMid, buckets(0, 4))).toEqual({
      head: [1, 2],
      mid: null,
      tail: [3, 3],
    });
    // CDATA 内伪造的 index 标签不计入条目
    const fake = '<user_message index="0"><![CDATA[<assistant index="9">内]]></user_message>';
    expect(segmentLines(fake, buckets(0, 2)).tail).toBeNull();
  });

  it('formatCandidates 按区间列出候选与含缓存的 token', () => {
    const base = parseLog(compactionEvents());
    const logs: CompactionLog[] = [
      { ...base, model: 'p/glm-5', effort: 'max', recompress: false },
      { ...base, model: 'q/m-1', effort: 'high', recompress: true },
    ];
    const lines = formatCandidates(logs).join('\n');
    expect(lines).toContain('区间 [0..9] reflect：2 个候选');
    expect(lines).toContain('原始 p/glm-5（max）in=330');
    expect(lines).toContain('缓存读 200/写 100');
    expect(lines).toContain('重压缩 q/m-1（high）in=330');
  });

  it('buckets 三等分区间且首尾相接', () => {
    expect(buckets(0, 42)).toEqual({ head: [0, 14], mid: [15, 28], tail: [29, 42] });
    expect(buckets(43, 77)).toEqual({ head: [43, 54], mid: [55, 65], tail: [66, 77] });
  });

  it('shuffle 同种子可复现且为排列', () => {
    const xs = [1, 2, 3, 4, 5, 6];
    expect(shuffle(xs, 7)).toEqual(shuffle(xs, 7));
    expect([...shuffle(xs, 7)].sort()).toEqual(xs);
    expect(xs).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('aggregate', () => {
  it('weightedRatio 按 A/B/C 权重加权，歪曲为负分', () => {
    expect(
      weightedRatio([
        ['A', 1],
        ['C', 0],
      ]),
    ).toBe(75);
    expect(
      weightedRatio([
        ['A', -1],
        ['B', 1],
      ]),
    ).toBe(-20);
  });

  it('positionChars 把区间条目字符均摊到覆盖的 assistant index', () => {
    const bk = buckets(0, 5);
    const xml =
      '<assistant start="0" end="5"><![CDATA[abcdef]]></assistant><assistant index="5"><![CDATA[xyz]]></assistant>';
    expect(positionChars(xml, bk, new Set([1, 5]))).toEqual({ head: 3, mid: 0, tail: 6 });
  });

  it('scoreAll 双评审取均值，计算保留、精简、无关、耗时、后续依据保留率与凭据泄漏', () => {
    const d = tmp();
    writeEvalDir(d);
    const { variants, disagreements } = scoreAll(d);
    expect(variants.V1).toMatchObject({
      retention: 100,
      retention_after: 100,
      after_facts: 1,
      irrelevant: 100,
      conciseness: 100,
      time: 100,
      composite: 100,
      credential_leak: false,
      by_category: { A: 100, B: null, C: 100 },
      by_position: { head: 100, mid: null, tail: 100 },
      tokens_cache_read: 40,
      chars: { head: 0, mid: 0, tail: 4 },
      product_chars: 4,
      compression: { head: 0, mid: null, tail: null },
    });
    expect(variants.V2).toMatchObject({
      retention: -75,
      retention_after: 50,
      A_failed: ['F1'],
      irrelevant: 0,
      conciseness: 50,
      time: 50,
      composite: -47.5,
      credential_leak: true,
      unsupported_claims: 1,
    });
    expect(disagreements).toEqual([{ variant: 'V2', id: 'F1', verdicts: ['丢失', '歪曲'] }]);
  });

  it('referenceVariants 解析 original 与 provider/model[:effort] 选择器', () => {
    const k = {
      id: 'x',
      wall_sec: 1,
      model_sec: 1,
      requests: 1,
      tokens_in: 1,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      tokens_out: 1,
    };
    const key = {
      V1: { ...k, model: 'p/m', effort: 'high', recompress: false },
      V2: { ...k, model: 'p/m', effort: 'max', recompress: true },
      V3: { ...k, model: 'p/n', effort: 'high', recompress: true },
    };
    expect(referenceVariants(key, 'original')).toEqual(['V1']);
    expect(referenceVariants(key, 'p/m')).toEqual(['V1', 'V2']);
    expect(referenceVariants(key, 'p/m:max')).toEqual(['V2']);
    expect(referenceVariants(key, 'x/y')).toEqual([]);
  });

  it('scoreAll 参考候选照常计保留率，精简与耗时按参与候选折算并封顶 100', () => {
    const d = tmp();
    writeEvalDir(d);
    const key = JSON.parse(readFileSync(join(d, '_blind_key.json'), 'utf8')) as Record<
      string,
      object
    >;
    key.V2 = { ...key.V2, model: 'r', effort: 'high' };
    writeFileSync(join(d, '_blind_key.json'), JSON.stringify(key));
    writeFileSync(join(d, 'V2.xml'), '<assistant index="2"><![CDATA[t]]></assistant>');
    const { variants } = scoreAll(d, ['r:high']);
    expect(variants.V1?.reference).toBe(false);
    expect(variants.V2?.reference).toBe(true);
    expect(variants.V1).toMatchObject({ conciseness: 100, time: 100 });
    expect(variants.V2).toMatchObject({ conciseness: 100, time: 50, retention: -75 });
    const pool = Object.fromEntries(Object.entries(variants).filter(([, x]) => !x.reference));
    expect(modelSummary(pool)).toEqual([]);
  });

  it('参考选择器未匹配候选或全部候选为参考时报错', () => {
    const d = tmp();
    writeEvalDir(d);
    expect(() => scoreAll(d, ['nope/model'])).toThrow(/参考选择器 nope\/model 未匹配任何候选/);
    expect(() => scoreAll(d, ['m'])).toThrow(/全部候选都被设为参考/);
  });

  it('评审文件基于旧版 facts.json 时报错', () => {
    const d = tmp();
    writeEvalDir(d);
    const j = JSON.parse(readFileSync(join(d, 'judge-V1-1.json'), 'utf8')) as {
      facts_sha?: string;
    };
    delete j.facts_sha;
    writeFileSync(join(d, 'judge-V1-1.json'), JSON.stringify(j));
    expect(() => scoreAll(d)).toThrow(/基于旧版 facts\.json/);
  });

  it('modelSummary 输出同模型多变体的综合分均值与标准差', () => {
    const d = tmp();
    writeEvalDir(d);
    const { variants } = scoreAll(d);
    expect(modelSummary(variants)).toEqual([{ model: 'm max', n: 2, mean: 26.3, std: 104.3 }]);
    const single = Object.fromEntries(Object.entries(variants).slice(0, 1));
    expect(modelSummary(single)).toEqual([]);
  });

  it('评审文件缺失、覆盖不全或判定词非法时报错', () => {
    const d = tmp();
    writeEvalDir(d);
    rmSync(join(d, 'judge-V1-2.json'));
    expect(() => scoreAll(d)).toThrow(/缺少评审文件 judge-V1-2\.json/);

    writeEvalDir(d);
    const j = JSON.parse(readFileSync(join(d, 'judge-V1-1.json'), 'utf8'));
    j.facts = j.facts.filter((x: { id: string }) => x.id !== 'F2');
    writeFileSync(join(d, 'judge-V1-1.json'), JSON.stringify(j));
    expect(() => scoreAll(d)).toThrow(/未覆盖事实 F2/);

    writeEvalDir(d);
    const j2 = JSON.parse(readFileSync(join(d, 'judge-V1-1.json'), 'utf8'));
    j2.facts[0].verdict = '也许';
    writeFileSync(join(d, 'judge-V1-1.json'), JSON.stringify(j2));
    expect(() => scoreAll(d)).toThrow(/事实 F1 判定词非法/);

    writeEvalDir(d);
    const j3 = JSON.parse(readFileSync(join(d, 'judge-V1-1.json'), 'utf8'));
    j3.irrelevant = [];
    writeFileSync(join(d, 'judge-V1-1.json'), JSON.stringify(j3));
    expect(() => scoreAll(d)).toThrow(/未覆盖无关信息 D1/);
  });
});

/** 写入一套固定的评估目录夹具：两变体、双评审、V2 有分歧与凭据泄漏。 */
function writeEvalDir(d: string): void {
  const w = (n: string, v: object | string) =>
    writeFileSync(join(d, n), typeof v === 'string' ? v : JSON.stringify(v));
  w('meta.json', { session: 's', phase: 'observe', range: [0, 2], buckets: buckets(0, 2) });
  const entry = { model: 'm', effort: 'max', recompress: true, requests: 1 };
  w('_blind_key.json', {
    V1: {
      ...entry,
      id: 'a',
      wall_sec: 10,
      model_sec: 10,
      tokens_in: 1,
      tokens_cache_read: 40,
      tokens_cache_write: 10,
      tokens_out: 1,
    },
    V2: {
      ...entry,
      id: 'b',
      wall_sec: 20,
      model_sec: 20,
      tokens_in: 1,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      tokens_out: 1,
    },
  });
  const facts: FactList = {
    facts: [
      {
        id: 'F1',
        fact: 'a',
        category: 'A',
        position: 'head',
        source_indices: [0],
        check_hint: 'h1',
      },
      {
        id: 'F2',
        fact: 'b',
        category: 'C',
        position: 'tail',
        source_indices: [1],
        check_hint: 'h2',
        evidence_after: 'after.md 第 3 行',
      },
    ],
    irrelevant: [{ id: 'D1', fact: 'd', is_credential: true }],
  };
  w('facts.json', facts);
  w('source.xml', '<assistant index="0"><![CDATA[s]]></assistant>');
  w('V1.xml', '<assistant index="2"><![CDATA[tail]]></assistant>');
  w('V2.xml', '<assistant index="2"><![CDATA[tailtail]]></assistant>');
  const sha = factsHash(facts);
  const judge = (facts: object[], irrelevant: object[], extra?: object) => ({
    facts,
    irrelevant,
    facts_sha: sha,
    ...extra,
  });
  w(
    'judge-V1-1.json',
    judge(
      [
        { id: 'F1', verdict: '保留' },
        { id: 'F2', verdict: '保留' },
      ],
      [{ id: 'D1', verdict: '已省略' }],
    ),
  );
  w(
    'judge-V1-2.json',
    judge(
      [
        { id: 'F1', verdict: '保留' },
        { id: 'F2', verdict: '保留' },
      ],
      [{ id: 'D1', verdict: '已省略' }],
    ),
  );
  w(
    'judge-V2-1.json',
    judge(
      [
        { id: 'F1', verdict: '丢失' },
        { id: 'F2', verdict: '部分' },
      ],
      [{ id: 'D1', verdict: '详细保留' }],
      { unsupported_claims: [{ quote: 'q1' }, { quote: 'q2' }] },
    ),
  );
  w(
    'judge-V2-2.json',
    judge(
      [
        { id: 'F1', verdict: '歪曲' },
        { id: 'F2', verdict: '部分' },
      ],
      [{ id: 'D1', verdict: '详细保留' }],
    ),
  );
}
