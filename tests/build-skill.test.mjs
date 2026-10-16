// build-skill 渲染单测：发布版 SKILL.md 由源码版确定性改写而来。
// 回归保障：脚本名必须换成 .mjs、运行器必须降级为 node、dev-only 段必须整段消失，
// 否则用户环境会照文档去跑不存在的 TS 源码（无 src/、无 fzstd、无 transform-types 需求）。
import { describe, expect, it } from 'vitest';
import { PACKAGED_RUNNER, renderPackagedSkill, SKILL_SCRIPTS } from '../scripts/build-skill.mjs';

/** 含三类改写点的源码版片段。 */
const SOURCE = [
  '# compaction-eval',
  '',
  '- 用户给出 zip 时直接用。',
  '<!-- dev-only -->',
  '- 脚本用 Node 直接运行 TS，先 `pnpm install`。',
  '- `view.ts` 与 `compress.ts` 引用插件源码，需加 `--experimental-transform-types`。',
  '<!-- /dev-only -->',
  '- 盲评完成前不读 `_blind_key.json`。',
  '',
  '```sh',
  'S=<skill 目录>/scripts',
  'N="node --experimental-transform-types --no-warnings"',
  '$N $S/view.ts --session <id>',
  '$N $S/compress.ts v.json <provider/model> --out <变体目录>',
  '```',
  '',
  '- `prepare.ts`：分组选择评估区间。',
  '- `aggregate.ts`：汇总评审结果。',
  '',
].join('\n');

describe('renderPackagedSkill', () => {
  it('四个脚本名改扩展名，代码块与散文都覆盖', () => {
    const out = renderPackagedSkill(SOURCE);
    for (const name of SKILL_SCRIPTS) {
      expect(out).not.toContain(`${name}.ts`);
    }
    expect(out).toContain('$N $S/view.mjs --session <id>');
    expect(out).toContain('$N $S/compress.mjs v.json <provider/model> --out <变体目录>');
    expect(out).toContain('- `prepare.mjs`：分组选择评估区间。');
    expect(out).toContain('- `aggregate.mjs`：汇总评审结果。');
  });

  it('运行器降级为 node，其余行不动', () => {
    const out = renderPackagedSkill(SOURCE);
    expect(out).toContain(`N="${PACKAGED_RUNNER}"`);
    expect(out).not.toContain('--experimental-transform-types');
    expect(out).toContain('S=<skill 目录>/scripts');
    expect(out).toContain('- 用户给出 zip 时直接用。');
    expect(out).toContain('- 盲评完成前不读 `_blind_key.json`。');
  });

  it('dev-only 段连同标记整段删除，不留空行', () => {
    const out = renderPackagedSkill(SOURCE);
    expect(out).not.toContain('dev-only');
    expect(out).not.toContain('pnpm install');
    expect(out.split('\n')).toContain('- 用户给出 zip 时直接用。');
    // 标记之间的行全部消失，前后两行直接相邻
    const lines = out.split('\n');
    expect(lines.indexOf('- 盲评完成前不读 `_blind_key.json`。')).toBe(
      lines.indexOf('- 用户给出 zip 时直接用。') + 1,
    );
  });

  it('CRLF 文档同样改写', () => {
    const out = renderPackagedSkill(SOURCE.replaceAll('\n', '\r\n'));
    expect(out).toContain('$N $S/view.mjs --session <id>');
    expect(out).toContain(`N="${PACKAGED_RUNNER}"`);
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
    expect(out.split('\n').filter((l) => l !== '')).toEqual(['前', '后']);
  });
});
