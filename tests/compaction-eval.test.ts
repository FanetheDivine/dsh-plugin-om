// compaction-eval skill 脚本单元测试：多帧 zstd 日志读取、会话日志 zip 读取、压缩日志解析（阶段、区间、模型、
// 失败标记、逐轮模型耗时、token、completeCompression 产物、原文视图）、分组选择、原文视图
// 选择、盲化产物、后续轨迹定位与截断、区间三等分、可复现洗牌，
// 以及 aggregate 的双评审均值、保留/精简/无关/耗时四维评分、评审校验报错与按模型汇总。

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';

import {
  modelSummary,
  positionChars,
  scoreAll,
  weightedRatio,
} from '../.agents/skills/compaction-eval/scripts/aggregate.ts';
import {
  blindProduct,
  buckets,
  buildAfter,
  type CompactionLog,
  type Phase,
  parseLog,
  pickSource,
  prepareEvalDir,
  selectGroup,
  shuffle,
} from '../.agents/skills/compaction-eval/scripts/prepare.ts';
import {
  loadLog,
  readZip,
  type SessionEvent,
} from '../.agents/skills/compaction-eval/scripts/session-source.ts';

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
      data: { label: 'OM 压缩会话记录（反思 · 2 轮 · 重压缩 p/glm-5）' },
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
        usage: { inputTokens: 20, outputTokens: 3 },
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
      tokens_in: 30,
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

  it('parseLog 识别默认思考等级、失败日志与缺失产物', () => {
    const ev = compactionEvents();
    ev[1] = {
      type: 'subagent/descriptor',
      time: 1000,
      data: { label: 'OM 压缩失败日志（观察 · 1 轮）' },
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

  it('buildAfter 从区间最后一个工具调用开始并按上限截断', () => {
    const main: SessionEvent[] = [
      { type: 'session', id: 'm' },
      { type: 'user/message', data: { content: txt('早期') } },
      { type: 'tool/call', data: { callId: 'k1', name: 'click', arguments: '{}' } },
      { type: 'tool/result', data: { callId: 'k1', message: { content: txt('done') } } },
      { type: 'assistant/message', data: { message: { content: txt('x'.repeat(50)) } } },
      { type: 'assistant/message', data: { message: { content: txt('不应出现') } } },
    ];
    const { text, start } = buildAfter(main, '<a callId="k1">', 60);
    expect(start).toBe(2);
    expect(text).not.toContain('早期');
    expect(text).toContain('[TOOL click]');
    expect(text).not.toContain('不应出现');
    expect(text).toContain('已截断');
  });

  it('buildAfter 定位不到区间末尾调用时报错', () => {
    const main: SessionEvent[] = [{ type: 'session', id: 'm' }];
    expect(() => buildAfter(main, '没有 callId', 60)).toThrow(/callId/);
    expect(() => buildAfter(main, '<a callId="nope">', 60)).toThrow(/nope/);
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

  it('scoreAll 双评审取均值，计算保留、精简、无关、耗时与凭据泄漏', () => {
    const d = tmp();
    writeEvalDir(d);
    const { variants, disagreements } = scoreAll(d);
    expect(variants.V1).toMatchObject({
      retention: 100,
      irrelevant: 100,
      conciseness: 100,
      time: 100,
      composite: 100,
      credential_leak: false,
      chars: { head: 0, mid: 0, tail: 4 },
      product_chars: 4,
      compression: { head: 0, mid: null, tail: null },
    });
    expect(variants.V2).toMatchObject({
      retention: -75,
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
    V1: { ...entry, id: 'a', wall_sec: 10, model_sec: 10, tokens_in: 1, tokens_out: 1 },
    V2: { ...entry, id: 'b', wall_sec: 20, model_sec: 20, tokens_in: 1, tokens_out: 1 },
  });
  w('facts.json', {
    facts: [
      { id: 'F1', fact: 'a', category: 'A', position: 'head' },
      { id: 'F2', fact: 'b', category: 'C', position: 'tail' },
    ],
    irrelevant: [{ id: 'D1', is_credential: true }],
  });
  w('source.xml', '<assistant index="0"><![CDATA[s]]></assistant>');
  w('V1.xml', '<assistant index="2"><![CDATA[tail]]></assistant>');
  w('V2.xml', '<assistant index="2"><![CDATA[tailtail]]></assistant>');
  const judge = (facts: object[], irrelevant: object[], extra?: object) => ({
    facts,
    irrelevant,
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
