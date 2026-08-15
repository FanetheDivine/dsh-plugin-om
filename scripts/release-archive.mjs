// CHANGELOG归档
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const changelogPath = path.join(root, 'CHANGELOG.md');
const pkgPath = path.join(root, 'package.json');
const changelogsDir = path.join(root, 'changelogs');
const template = '# Changelog\n';

const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
const date = new Date().toISOString().slice(0, 10);
const changelog = readFileSync(changelogPath, 'utf8');

// 归档 # Changelog 标题之下的全部条目
const lines = changelog.split(/\r?\n/);
const firstHeading = lines.findIndex((l) => /^#+\s/.test(l.trim()));
const body = lines
  .slice(firstHeading + 1)
  .join('\n')
  .trim();

if (body) {
  const archivePath = path.join(changelogsDir, `CHANGE.${version}.md`);
  mkdirSync(changelogsDir, { recursive: true });
  const content = `# Changelog\n\n## [${version}] - ${date}\n\n${body}\n`;
  writeFileSync(archivePath, content);
  const rel = path.relative(root, archivePath).split(path.sep).join('/');
  execSync(`git add CHANGELOG.md "${rel}"`, { cwd: root });
  execSync(`git commit -m "chore(release): archive changelog for v${version}"`, { cwd: root });
  console.log(
    `[release-archive] 归档 ${body.split('\n').length} 行到 changelogs/CHANGE.${version}.md`,
  );
} else {
  console.log('[release-archive] CHANGELOG.md 没有待归档条目，跳过归档提交');
}

if (changelog.trim() !== template.trim()) {
  writeFileSync(changelogPath, template);
  console.log('[release-archive] CHANGELOG.md 已重置（清空）');
} else {
  console.log('[release-archive] CHANGELOG.md 已是模板，无需重置');
}
