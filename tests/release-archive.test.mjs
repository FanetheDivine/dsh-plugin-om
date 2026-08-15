// release-archive 归档计划单测：条目提取 / 归档文件内容 / 提交计划不变式。
// 回归保障：有条目时，"归档文件 + CHANGELOG 重置" 必须出现在同一提交计划里，
// 否则清空 CHANGELOG.md 的改动会遗留在工作区（历史 bug：reset 发生在 commit 之后）。
import { describe, expect, it } from 'vitest';
import { planArchive } from '../scripts/release-archive.mjs';

describe('planArchive', () => {
  it('有条目：归档文件 + CHANGELOG 重置进同一提交计划', () => {
    const { body, files } = planArchive(
      '# Changelog\n\n- 修复甲\n- 新增乙\n',
      '1.2.3',
      '2026-01-02',
    );
    expect(body).toBe('- 修复甲\n- 新增乙');
    expect(files).toEqual([
      {
        rel: 'changelogs/CHANGE.1.2.3.md',
        content: '# Changelog\n\n## [1.2.3] - 2026-01-02\n\n- 修复甲\n- 新增乙\n',
      },
      { rel: 'CHANGELOG.md', content: '# Changelog\n' },
    ]);
  });

  it('无条目：空提交计划（不产生归档/清空/提交）', () => {
    const { body, files } = planArchive('# Changelog\n', '1.2.3', '2026-01-02');
    expect(body).toBe('');
    expect(files).toEqual([]);
  });

  it('CRLF 换行：条目提取与重置判定不受影响', () => {
    const { body, files } = planArchive('# Changelog\r\n\r\n- 条目\r\n', '0.1.0', '2026-01-02');
    expect(body).toBe('- 条目');
    expect(files).toHaveLength(2);
    expect(files[1].rel).toBe('CHANGELOG.md');
  });
});
