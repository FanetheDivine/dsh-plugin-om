// compaction-eval view.ts 单元测试：由宿主格式日志重建真实 Session、列出已有压缩、
// 按 compactionId 重建视图、按完整消息区间复现当时视图（块外原文、块内相交条目、混合时为反思）、
// 区间越界与倒置报错，以及 buildViewFile 携带会话头与来源。

import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { describe, expect, it } from 'vitest';

import {
  type SessionEvent as LogEvent,
  toSession,
} from '../.agents/skills/compaction-eval/scripts/session-source.ts';
import {
  buildViewFile,
  listCompactions,
  rangeView,
} from '../.agents/skills/compaction-eval/scripts/view.ts';
import { resolveConfig } from '../src/config.ts';
import { indexCompleteMessages } from '../src/log-index.ts';
import { compactedLog } from './compaction-eval-fixtures.ts';
import { hostLog, twoCallFlow } from './helpers.ts';

describe('toSession / listCompactions', () => {
  it('由日志重建真实会话，并列出压缩的阶段、区间、成败与模型', async () => {
    const events = await compactedLog();
    const session = toSession(events);
    expect(indexCompleteMessages(session).map((cm) => cm.index)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    const [brief, ...rest] = listCompactions(session);
    expect(rest).toEqual([]);
    expect(brief).toMatchObject({
      phase: 'observe',
      range: [0, 5],
      ok: true,
      error: undefined,
      model: 'test/test-model',
    });
  });

  it('截到某个 seq 时表层停在当时，后续压缩不生效', async () => {
    const events = await compactedLog();
    const atStart = toSession(events, 7);
    expect(listCompactions(atStart)).toEqual([]);
    expect(atStart.surface.nodes).toEqual([0, 1, 3, 4, 5, 7]);
  });
});

/** 给 twoCallFlow 的每条 assistant 消息前插入 reasoning 块。 */
function flowWithReasoning(): LogEvent[] {
  return hostLog(
    twoCallFlow().map((e) => {
      if (e.type !== 'assistant/message') return e;
      const message = e.data.message;
      return {
        ...e,
        data: {
          ...e.data,
          message: {
            ...message,
            content: [{ type: 'reasoning' as const, text: '其他模型的思考' }, ...message.content],
          },
        },
      } as unknown as SessionEvent;
    }),
  );
}

describe('buildViewFile：reasoning 条目', () => {
  it('skipReasoning=true 视图不含 reasoning，false 保留', () => {
    const events = flowWithReasoning();
    const kinds = (skip: boolean) =>
      buildViewFile(events, { range: [0, 5] }, skip).view.entries.map((e) => e.kind);
    expect(kinds(false)).toContain('reasoning');
    expect(kinds(true)).not.toContain('reasoning');
  });

  it('缺省值取插件默认配置 compressSkipReasoning', () => {
    const entries = buildViewFile(flowWithReasoning(), { range: [0, 5] }).view.entries;
    expect(entries.some((e) => e.kind === 'reasoning')).toBe(
      !resolveConfig().compressSkipReasoning,
    );
  });
});

describe('buildViewFile：按 compactionId 重建', () => {
  it('复现该次压缩的原文视图，并带上会话头与来源', async () => {
    const events = await compactedLog();
    const [brief] = listCompactions(toSession(events));
    const file = buildViewFile(events, { compactionId: String(brief?.id) });
    expect(file.phase).toBe('observe');
    expect(file.source).toEqual({ compactionId: brief?.id });
    expect(file.header.id).toBe('session-view-test');
    expect([file.view.minIndex, file.view.maxIndex]).toEqual([0, 5]);
    expect(file.view.entries.some((e) => e.text.includes('firstCode()'))).toBe(true);
  });

  it('未知 compactionId 报错', async () => {
    const events = await compactedLog();
    expect(() => buildViewFile(events, { compactionId: 'nope' })).toThrow();
  });
});

describe('rangeView：按完整消息区间复现视图', () => {
  it('区间全在块外时为观察，条目为原文且严格落在区间内', async () => {
    const events = await compactedLog();
    const replay = rangeView(events, 7, 8, false);
    if ('error' in replay) throw new Error(replay.error);
    expect(replay.phase).toBe('observe');
    expect([replay.view.minIndex, replay.view.maxIndex]).toEqual([7, 8]);
    expect(replay.view.entries.every((e) => e.blockSeq === undefined)).toBe(true);
    expect(replay.view.entries.some((e) => e.text.includes('thirdCode()'))).toBe(true);
    expect(replay.originalChars).toBeGreaterThan(0);
  });

  it('跨越压缩块时为反思：块内取相交条目，块外取原文', async () => {
    const events = await compactedLog();
    const replay = rangeView(events, 4, 7, false);
    if ('error' in replay) throw new Error(replay.error);
    expect(replay.phase).toBe('reflect');
    const inBlock = replay.view.entries.filter((e) => e.blockSeq !== undefined);
    const outside = replay.view.entries.filter((e) => e.blockSeq === undefined);
    expect(inBlock.map((e) => e.lo)).toEqual([4, 5]);
    expect(outside.map((e) => e.lo)).toEqual([6, 7]);
    expect([replay.view.minIndex, replay.view.maxIndex]).toEqual([4, 7]);
  });

  it('区间终点早于压缩时取当时表层，全部为原文', async () => {
    const events = await compactedLog();
    const replay = rangeView(events, 0, 3, false);
    if ('error' in replay) throw new Error(replay.error);
    expect(replay.phase).toBe('observe');
    expect(replay.view.entries.map((e) => e.lo)).toEqual([0, 1, 2, 3]);
  });

  it('区间倒置或越界时返回错误', async () => {
    const events = await compactedLog();
    expect(rangeView(events, 5, 2, false)).toHaveProperty('error');
    expect(rangeView(events, 0, 99, false)).toHaveProperty('error');
  });
});
