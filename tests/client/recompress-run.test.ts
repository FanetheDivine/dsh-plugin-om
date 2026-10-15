// 重压缩客户端提交：命令行拼装与远程结果归一化。

import { describe, expect, it, vi } from 'vitest';
import {
  type DirectoryModel,
  effortUnion,
  expandRecompressChoices,
  recompressLine,
  submitRecompress,
} from '../../src/client/recompress-run.ts';

/** 构造带等级元数据的目录模型。 */
function model(id: string, name: string, efforts: string[] = []): DirectoryModel {
  return {
    id,
    name,
    ...(efforts.length === 0
      ? {}
      : { reasoning: { efforts: efforts.map((e) => ({ id: e, name: e.toUpperCase() })) } }),
  };
}

describe('effortUnion', () => {
  it('返回所选模型等级的并集，按 id 去重并保序', () => {
    const selected = [
      { provider: 'p1', model: model('a', 'A', ['low', 'high']) },
      { provider: 'p1', model: model('b', 'B', ['high', 'max']) },
      { provider: 'p2', model: model('c', 'C') },
    ];
    expect(effortUnion(selected).map((e) => e.id)).toEqual(['low', 'high', 'max']);
    expect(effortUnion([])).toEqual([]);
  });
});

describe('expandRecompressChoices', () => {
  const selected = [
    { provider: 'p1', model: model('a', 'A', ['low', 'high']) },
    { provider: 'p2', model: model('b', 'B', ['high', 'max']) },
    { provider: 'p2', model: model('plain', 'Plain') },
  ];

  it('带等级模型：勾默认则先出默认组合，再按模型等级顺序出勾选且被支持的等级', () => {
    const choices = expandRecompressChoices(selected, {
      useDefault: true,
      effortIds: new Set(['high', 'max']),
    });
    expect(choices).toEqual([
      { provider: 'p1', model: 'a' },
      { provider: 'p1', model: 'a', reasoningEffort: 'high' },
      { provider: 'p2', model: 'b' },
      { provider: 'p2', model: 'b', reasoningEffort: 'high' },
      { provider: 'p2', model: 'b', reasoningEffort: 'max' },
      { provider: 'p2', model: 'plain' },
    ]);
  });

  it('不支持的勾选等级被跳过；默认未勾选时不生成默认组合', () => {
    const choices = expandRecompressChoices(selected, {
      useDefault: false,
      effortIds: new Set(['low', 'max']),
    });
    expect(choices).toEqual([
      { provider: 'p1', model: 'a', reasoningEffort: 'low' },
      { provider: 'p2', model: 'b', reasoningEffort: 'max' },
      { provider: 'p2', model: 'plain' },
    ]);
  });

  it('无等级模型固定只生成一个默认组合，与等级勾选无关', () => {
    const plainOnly = [{ provider: 'p', model: model('plain', 'Plain') }];
    for (const picks of [
      { useDefault: true, effortIds: new Set(['high']) },
      { useDefault: false, effortIds: new Set<string>() },
    ]) {
      expect(expandRecompressChoices(plainOnly, picks)).toEqual([
        { provider: 'p', model: 'plain' },
      ]);
    }
  });

  it('顺序按模型选择顺序，等级顺序按模型元数据顺序', () => {
    const reordered = [selected[2], selected[0], selected[1]].filter(
      (s): s is (typeof selected)[number] => s !== undefined,
    );
    const choices = expandRecompressChoices(reordered, {
      useDefault: false,
      effortIds: new Set(['max', 'high']),
    });
    expect(choices).toEqual([
      { provider: 'p2', model: 'plain' },
      { provider: 'p1', model: 'a', reasoningEffort: 'high' },
      { provider: 'p2', model: 'b', reasoningEffort: 'high' },
      { provider: 'p2', model: 'b', reasoningEffort: 'max' },
    ]);
  });

  it('什么都没勾且无无等级模型时返回空数组', () => {
    expect(
      expandRecompressChoices(
        [selected[0], selected[1]].filter((s): s is (typeof selected)[number] => s !== undefined),
        { useDefault: false, effortIds: new Set() },
      ),
    ).toEqual([]);
  });
});

describe('recompressLine', () => {
  it('按 id、provider、model 顺序拼装，思考等级缺省时省略', () => {
    expect(recompressLine('om:1', { provider: 'alt', model: 'big-1' })).toBe(
      '/om-recompress om:1 alt big-1',
    );
  });

  it('带思考等级时追加在末尾', () => {
    expect(recompressLine('om:1', { provider: 'alt', model: 'a/b', reasoningEffort: 'high' })).toBe(
      '/om-recompress om:1 alt a/b high',
    );
  });
});

describe('submitRecompress', () => {
  const choice = { provider: 'alt', model: 'big-1' };

  it('把命令行发往指定会话，success 结果返回 ok 与文本', async () => {
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      value: { result: { kind: 'success', text: '重压缩完成' } },
    });
    await expect(submitRecompress(execute, 's-1', 'om:1', choice)).resolves.toEqual({
      ok: true,
      text: '重压缩完成',
    });
    expect(execute).toHaveBeenCalledExactlyOnceWith('s-1', '/om-recompress om:1 alt big-1');
  });

  it('命令 error 结果返回失败与原因', async () => {
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      value: { result: { kind: 'error', text: '找不到压缩' } },
    });
    await expect(submitRecompress(execute, 's-1', 'om:1', choice)).resolves.toEqual({
      ok: false,
      text: '找不到压缩',
    });
  });

  it('远程拒绝与抛错都归一为失败', async () => {
    const rejected = vi.fn().mockResolvedValue({ ok: false, error: { message: 'denied' } });
    await expect(submitRecompress(rejected, 's-1', 'om:1', choice)).resolves.toEqual({
      ok: false,
      text: 'denied',
    });
    const thrown = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(submitRecompress(thrown, 's-1', 'om:1', choice)).resolves.toEqual({
      ok: false,
      text: 'boom',
    });
  });
});
