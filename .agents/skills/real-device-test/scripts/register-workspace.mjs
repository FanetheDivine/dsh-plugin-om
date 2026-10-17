// 注册测试工作区：重写 profile 的 test-storage/workspace.json。
// 用法：node register-workspace.mjs <profile目录> <仓库绝对路径>
// schema 坑（见 pitfalls.md）：path 必须含反斜杠的 Windows 绝对路径；时间戳必须 ISO 字符串；
// sessionIds 为 test-sessions/<slug>/<sessionId> 的 sessionId 集合。
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const [pdir, repo] = process.argv.slice(2);
if (!pdir || !repo) {
  console.error('用法: node register-workspace.mjs <profile目录> <仓库绝对路径>');
  process.exit(1);
}
const wsId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const winPath = repo.replace(/\//g, '\\');
const now = new Date().toISOString();
// 收集该仓库 slug 目录下的会话 id
const ids = [];
const sessRoot = join(pdir, 'test-sessions');
if (existsSync(sessRoot)) {
  for (const slug of readdirSync(sessRoot)) {
    if (!slug.includes(basename(repo))) continue;
    const dir = join(sessRoot, slug);
    if (!statSync(dir).isDirectory()) continue;
    for (const s of readdirSync(dir)) ids.push(s);
  }
}
const storageDir = join(pdir, 'test-storage');
mkdirSync(storageDir, { recursive: true });
const file = join(storageDir, 'workspace.json');
let doc = {
  unit: { name: 'workspace' },
  version: 2,
  global: { workspaceIds: [] },
  tables: { workspaces: {} },
};
if (existsSync(file)) {
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    /* 空壳或损坏，重建 */
  }
}
doc.global ??= { workspaceIds: [] };
doc.tables ??= { workspaces: {} };
doc.tables.workspaces ??= {};
doc.global.workspaceIds = [wsId];
doc.tables.workspaces[wsId] = {
  path: winPath,
  title: basename(repo),
  sessionIds: ids,
  createdAt: now,
  updatedAt: now,
};
writeFileSync(file, JSON.stringify(doc, null, 2));
console.log(`workspace 已注册: ${wsId} ${winPath}（${ids.length} 个会话）`);
