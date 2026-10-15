// 重压缩客户端提交：命令行拼装与远程结果归一化。

import { describe, expect, it, vi } from 'vitest';
import { recompressLine, submitRecompress } from '../../src/client/recompress-run.ts';

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
