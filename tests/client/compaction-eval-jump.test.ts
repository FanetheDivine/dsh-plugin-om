// /om-compaction-eval 跳转目标判定单测：只认本命令的成功结果且文本能反解出新会话 id。
// 回归保障：其他命令、失败结果、缺文本与文本格式变化都不得给出跳转目标，
// 否则会跳到错误会话或把失败当成功。

import type { CommandResult } from '@deepseek-ai/dsh-commands/types';
import { describe, expect, it } from 'vitest';
import { evalJumpTarget } from '../../src/client/compaction-eval-jump.ts';

/** 执行一次判定。 */
function target(name: string, result: CommandResult): string | undefined {
  return evalJumpTarget(name, result);
}

describe('evalJumpTarget', () => {
  it('本命令成功且文本含新会话 id：返回跳转目标', () => {
    expect(
      target('om-compaction-eval', {
        kind: 'success',
        text: '已启动 OM 结果分析会话 session-new',
      }),
    ).toBe('session-new');
  });

  it('其他命令的成功结果不跳转', () => {
    expect(
      target('om-recompress', { kind: 'success', text: '已启动 OM 结果分析会话 session-new' }),
    ).toBeUndefined();
  });

  it('失败结果不跳转，即使文本形似成功', () => {
    expect(
      target('om-compaction-eval', { kind: 'error', text: '已启动 OM 结果分析会话 session-new' }),
    ).toBeUndefined();
  });

  it('成功但缺文本、空 id 或文本格式不符时不跳转', () => {
    expect(target('om-compaction-eval', { kind: 'success' })).toBeUndefined();
    expect(target('om-compaction-eval', { kind: 'success', text: '已启动 OM 结果分析会话 ' })).toBe(
      undefined,
    );
    expect(
      target('om-compaction-eval', { kind: 'success', text: '重压缩完成 字符 1 → 2' }),
    ).toBeUndefined();
  });
});
