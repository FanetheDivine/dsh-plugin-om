// CHANGELOG 归档：把 CHANGELOG.md 的条目归档到 changelogs/ 并清空 CHANGELOG.md。
// 归档与清空必须落在同一次提交里——先落盘全部计划文件，再统一 add + commit，
// 否则清空 CHANGELOG.md 的改动会遗留在工作区（此前 bug：reset 发生在 commit 之后）。
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE = '# Changelog\n';

/**
 * 计算归档计划（纯函数，供 vitest 测试）。
 * 返回本次提交应写入的全部文件（相对仓库根路径 + 内容）：
 * - 有条目：changelogs/CHANGE.<version>.md（归档） + CHANGELOG.md（重置为模板）
 * - 无条目：空数组（不产生任何提交）
 */
export function planArchive(changelog, version, date) {
  const lines = changelog.split(/\r?\n/);
  const firstHeading = lines.findIndex((l) => /^#+\s/.test(l.trim()));
  const body = lines
    .slice(firstHeading + 1)
    .join('\n')
    .trim();
  const files = [];
  if (body) {
    files.push({
      rel: `changelogs/CHANGE.${version}.md`,
      content: `# Changelog\n\n## [${version}] - ${date}\n\n${body}\n`,
    });
  }
  if (changelog.trim() !== TEMPLATE.trim()) {
    files.push({ rel: 'CHANGELOG.md', content: TEMPLATE });
  }
  return { body, files };
}

function runReleaseArchive() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const changelogPath = path.join(root, 'CHANGELOG.md');
  const pkgPath = path.join(root, 'package.json');
  const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
  const date = new Date().toISOString().slice(0, 10);
  const { body, files } = planArchive(readFileSync(changelogPath, 'utf8'), version, date);

  if (body) {
    console.log(
      `[release-archive] 归档 ${body.split('\n').length} 行到 changelogs/CHANGE.${version}.md`,
    );
  } else {
    console.log('[release-archive] CHANGELOG.md 没有待归档条目，跳过归档提交');
  }

  // 先落盘全部计划文件（含 CHANGELOG.md 重置），再统一 add + commit
  for (const file of files) {
    const abs = path.join(root, file.rel);
    if (file.rel.includes('/')) {
      mkdirSync(path.dirname(abs), { recursive: true });
    }
    writeFileSync(abs, file.content);
  }

  if (files.length > 0) {
    const rels = files.map((f) => JSON.stringify(f.rel)).join(' ');
    execSync(`git add ${rels}`, { cwd: root });
    execSync(`git commit -m "chore(release): archive changelog for v${version}"`, { cwd: root });
    console.log(
      `[release-archive] 已提交（${files.map((f) => f.rel).join('、')}），CHANGELOG.md 已重置（清空）`,
    );
  }
}

// 仅在作为 CLI 直接执行时运行（import 用于测试时无副作用）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runReleaseArchive();
}
