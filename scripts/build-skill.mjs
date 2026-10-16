// skill 打包：把仓库内的 compaction-eval skill 渲染成发布版写入 dist/skill/compaction-eval。
// 发布版脚本是 tsdown 产出的自包含 .mjs（内联 fflate/fzstd/yaml 与插件源码），
// 因此文档里的脚本名与运行器都要改写，源码版说明整段删除。
// 导出 SKILL_NAME / SKILL_SCRIPTS / SOURCE_RUNNER / PACKAGED_RUNNER / renderPackagedSkill /
// SKILL_SOURCE_DIR / SKILL_DIST_DIR / writeSkillDist。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录（scripts/ 的上一级）。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** skill 名（同时是发布目录名）。 */
export const SKILL_NAME = 'compaction-eval';

/** skill 脚本名（不含扩展名）：源码版为 .ts，发布版为 tsdown 产出的 .mjs。 */
export const SKILL_SCRIPTS = ['prepare', 'view', 'compress', 'aggregate'];

/** 源码版运行器：Node 直接跑 TS，需要类型转换标志。 */
export const SOURCE_RUNNER = 'node --experimental-transform-types --no-warnings';

/** 发布版运行器：打包后的 .mjs 不需要任何标志。 */
export const PACKAGED_RUNNER = 'node';

/** 仓库内 skill 源目录。 */
export const SKILL_SOURCE_DIR = path.join(ROOT, '.agents', 'skills', SKILL_NAME);

/** 发布产物目录。 */
export const SKILL_DIST_DIR = path.join(ROOT, 'dist', 'skill', SKILL_NAME);

/** 同行成对的 dev-only 标记（不跨行）。 */
const DEV_ONLY_INLINE_RE = /[ \t]*<!--\s*dev-only\s*-->[^\n]*?<!--\s*\/dev-only\s*-->[ \t]*/g;

/** 跨行的 dev-only 段（含结束标记所在行的换行）。 */
const DEV_ONLY_BLOCK_RE = /[ \t]*<!--\s*dev-only\s*-->[\s\S]*?<!--\s*\/dev-only\s*-->[ \t]*\r?\n/g;

/** 文档中出现的源码版脚本名。 */
const SCRIPT_TS_RE = new RegExp(`\\b(${SKILL_SCRIPTS.join('|')})\\.ts\\b`, 'g');

/**
 * 由源码版 SKILL.md 渲染发布版：删除 dev-only 段、脚本名改 .mjs、运行器降级为 node。
 * 结果幂等：对发布版再渲染不产生变化。
 * @param md - 源码版文档全文。
 * @returns 发布版文档全文。
 */
export function renderPackagedSkill(md) {
  return md
    .replace(DEV_ONLY_INLINE_RE, '')
    .replace(DEV_ONLY_BLOCK_RE, '')
    .replace(SCRIPT_TS_RE, '$1.mjs')
    .replaceAll(`N="${SOURCE_RUNNER}"`, `N="${PACKAGED_RUNNER}"`);
}

/**
 * 写出发布版 skill 目录：渲染后的 SKILL.md、原样复制的 references、校验四个脚本产物。
 * @param {{ requireScripts?: boolean }} [options] - requireScripts 缺省为 true：
 *   缺少 tsdown 产出的脚本时抛错（发布构建），false 时仅告警（watch 启动前）。
 * @returns {string[]} 写出的文件相对 dist/skill 的路径列表。
 */
export function writeSkillDist(options = {}) {
  const { requireScripts = true } = options;
  const sourceDir = SKILL_SOURCE_DIR;
  const distDir = SKILL_DIST_DIR;
  if (!existsSync(path.join(sourceDir, 'SKILL.md'))) {
    throw new Error(`[build-skill] 缺少源文档：${path.join(sourceDir, 'SKILL.md')}`);
  }
  // 只重建文档与 references：scripts/ 下的 .mjs 是 tsdown 产物，必须保留
  rmSync(path.join(distDir, 'references'), { recursive: true, force: true });
  mkdirSync(path.join(distDir, 'references'), { recursive: true });

  const written = [];
  const skill = renderPackagedSkill(readFileSync(path.join(sourceDir, 'SKILL.md'), 'utf8'));
  writeFileSync(path.join(distDir, 'SKILL.md'), skill, 'utf8');
  written.push(`${SKILL_NAME}/SKILL.md`);

  const referencesDir = path.join(sourceDir, 'references');
  for (const name of readdirSync(referencesDir)
    .filter((f) => f.endsWith('.md'))
    .sort()) {
    writeFileSync(
      path.join(distDir, 'references', name),
      readFileSync(path.join(referencesDir, name), 'utf8'),
      'utf8',
    );
    written.push(`${SKILL_NAME}/references/${name}`);
  }

  const missing = SKILL_SCRIPTS.filter(
    (name) => !existsSync(path.join(distDir, 'scripts', `${name}.mjs`)),
  );
  for (const name of SKILL_SCRIPTS.filter((n) => !missing.includes(n))) {
    written.push(`${SKILL_NAME}/scripts/${name}.mjs`);
  }
  if (missing.length > 0) {
    const message = `[build-skill] 缺少脚本产物：${missing.map((n) => `scripts/${n}.mjs`).join('、')}`;
    if (requireScripts) throw new Error(`${message}（先运行 tsdown）`);
    console.warn(message);
  }
  return written;
}

/** 命令行入口：--allow-missing-scripts 用于 watch 启动前（脚本产物尚未生成）。 */
function main() {
  const allowMissing = process.argv.includes('--allow-missing-scripts');
  const written = writeSkillDist({ requireScripts: !allowMissing });
  console.log(`[build-skill] 写出 ${written.length} 个文件到 ${SKILL_DIST_DIR}`);
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
