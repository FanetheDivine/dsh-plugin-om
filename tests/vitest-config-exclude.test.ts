/**
 * vitest 收集范围的回归测试：worktree 副本目录下的测试不得被收集。
 * 用 Node `path.matchesGlob` 验证配置里排除式的真实匹配结果，而非比对配置字符串。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../vitest.config';

const exclude = config.test?.exclude ?? [];

/** 相对路径是否命中任一排除模式 */
function isExcluded(rel: string): boolean {
  return exclude.some((pattern) => path.matchesGlob(rel, pattern));
}

describe('vitest 排除范围', () => {
  it('worktree 副本内的测试被排除', () => {
    expect(isExcluded('.agents/worktrees/serena-symbol-cli/tests/volatile.test.ts')).toBe(true);
    expect(isExcluded('.dsh/worktrees/om/tests/volatile.test.ts')).toBe(true);
  });

  it('仓库自身测试与 skill 脚本不被排除', () => {
    expect(isExcluded('tests/volatile.test.ts')).toBe(false);
    expect(isExcluded('.agents/skills/compaction-eval/scripts/view.ts')).toBe(false);
  });
});
