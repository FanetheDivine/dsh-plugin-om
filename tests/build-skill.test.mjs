// build-skill 渲染单测：发布版 SKILL.md 由源码版确定性改写而来。
// 回归保障：脚本名必须换成 .mjs、dev-only 段必须整段消失，
// 否则用户环境会照文档去跑不存在的 TS 源码（发布包里没有 src/ 与 fzstd）。
import { describe, expect, it } from 'vitest';
import { renderPackagedSkill, SKILL_SCRIPTS } from '../scripts/build-skill.mjs';

/** 含两类改写点的源码版片段（与仓库内 SKILL.md 同形）。 */
const SOURCE = [
  '# compaction-eval',
  '',
  '- 输入为本地会话 id 或 DSH 导出的 zip，未指明时向用户确认。zip 导出时需包含 subagents。',
  '<!-- dev-only -->',
  '- 源码版脚本是 TS，先在仓库根 `pnpm install`，再用 `node` 直接运行。',
  '<!-- /dev-only -->',
  '- 盲评完成前不读 `_blind_key.json`。',
  '',
  '判定标准见 [rules.md](references/rules.md)，计分由 `aggregate.ts` 完成。',
  '',
  '```sh',
  'node $S/view.ts --session <id>                  # 列出已有压缩',
  'node $S/compress.ts v.json <provider/model> --out <重压缩目录>',
  'node $S/prepare.ts --session <id> [--range A..B]',
  '```',
  '',
].join('\n');

describe('renderPackagedSkill', () => {
  it('四个脚本名改扩展名，代码块与散文都覆盖', () => {
    const out = renderPackagedSkill(SOURCE);
    for (const name of SKILL_SCRIPTS) {
      expect(out).not.toContain(`${name}.ts`);
    }
    expect(out).toContain('node $S/view.mjs --session <id>                  # 列出已有压缩');
    expect(out).toContain('node $S/compress.mjs v.json <provider/model> --out <重压缩目录>');
    expect(out).toContain('node $S/prepare.mjs --session <id> [--range A..B]');
    expect(out).toContain('计分由 `aggregate.mjs` 完成');
  });

  it('运行器与非脚本行原样保留', () => {
    const out = renderPackagedSkill(SOURCE);
    expect(out).toContain(
      '- 输入为本地会话 id 或 DSH 导出的 zip，未指明时向用户确认。zip 导出时需包含 subagents。',
    );
    expect(out).toContain('- 盲评完成前不读 `_blind_key.json`。');
    expect(out).toContain('[rules.md](references/rules.md)');
    // 脚本行仍以 node 开头，改写只动扩展名
    expect(out.split('\n').filter((line) => line.startsWith('node $S/'))).toHaveLength(3);
  });

  it('dev-only 段连同标记整段删除，不留空行', () => {
    const out = renderPackagedSkill(SOURCE);
    expect(out).not.toContain('dev-only');
    expect(out).not.toContain('pnpm install');
    // 标记之间的行全部消失，前后两行直接相邻
    const lines = out.split('\n');
    expect(lines.indexOf('- 盲评完成前不读 `_blind_key.json`。')).toBe(
      lines.indexOf(
        '- 输入为本地会话 id 或 DSH 导出的 zip，未指明时向用户确认。zip 导出时需包含 subagents。',
      ) + 1,
    );
  });

  it('CRLF 文档同样改写', () => {
    const out = renderPackagedSkill(SOURCE.replaceAll('\n', '\r\n'));
    expect(out).toContain('node $S/view.mjs --session <id>');
    expect(out).not.toContain('dev-only');
    expect(out).not.toContain('pnpm install');
    expect(out).toContain('\r\n');
  });

  it('已是发布版的文档再渲染保持不变', () => {
    const once = renderPackagedSkill(SOURCE);
    expect(renderPackagedSkill(once)).toBe(once);
  });

  it('行内 dev-only 标记：单行注释形式也被删除', () => {
    const out = renderPackagedSkill(
      ['前', '<!-- dev-only -->仅源码版说明<!-- /dev-only -->', '后'].join('\n'),
    );
    expect(out).not.toContain('仅源码版说明');
    expect(out.split('\n').filter((line) => line !== '')).toEqual(['前', '后']);
  });
});
