// package.json 打包回归测试：npm pack --dry-run 断言 tarball 不含 onnx 二进制。
// 语义模型 onnx 不随 npm 包分发，由插件 apply 按 semanticRecallEnabled 运行时按需下载
// （见 src/model-download.ts）。复现历史 bug 场景：开发时 download:model 已把 onnx 落盘，
// files 字段的否定模式（!models/*/onnx/*.onnx）仍须将其排除在 tarball 之外。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { EMBEDDING_MODEL_ID } from '../src/model-download.ts';

/** 仓库根目录（tests/ 的上一级）。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** onnx 相对路径（tarball 内路径用正斜杠）。 */
const ONNX_REL = path.join('models', EMBEDDING_MODEL_ID, 'onnx', 'model_quantized.onnx');

/** onnx 绝对路径。 */
const ONNX_ABS = path.join(ROOT, ONNX_REL);

/** 随包分发的小模型文件（相对模型目录）。 */
const SMALL_FILES = [
  'config.json',
  'special_tokens_map.json',
  'tokenizer.json',
  'tokenizer_config.json',
];

/** 测试期间创建的假 onnx（磁盘原本不存在时才创建；结束后清理）。 */
let fakeOnnxCreated = false;

/** 测试创建的目录（onnx 及其父目录），结束后按序尝试删除。 */
const createdDirs: string[] = [];

afterAll(() => {
  if (fakeOnnxCreated) {
    rmSync(ONNX_ABS, { force: true });
    for (const dir of createdDirs) {
      try {
        rmSync(dir, { force: true });
      } catch {
        // 目录可能因包含小文件而非空，删除失败可忽略
      }
    }
  }
});

/** 执行 npm pack --dry-run --json，返回 tarball 内文件路径集合。 */
function packedPaths(): Set<string> {
  const res = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    // Windows 下 npm 是 npm.cmd，需经 shell 启动
    shell: process.platform === 'win32',
  });
  if (res.status !== 0) {
    throw new Error(`npm pack --dry-run 失败：${String(res.stderr ?? res.stdout ?? '未知错误')}`);
  }
  // npm pack --json 输出数组（单个包 = 单元素数组），取所有包的文件列表
  const report = JSON.parse(String(res.stdout ?? '[]')) as Array<{
    files?: Array<{ path: string }>;
  }>;
  const files = report.flatMap((p) => p.files ?? []);
  return new Set(files.map((f) => f.path));
}

describe('npm 包内容（npm pack --dry-run）', () => {
  it('tarball 不含 onnx 二进制；config/tokenizer 等小文件仍随包分发', () => {
    // 模拟开发时已下载 onnx 的场景（历史 bug：此时 onnx 被打进 tarball）
    fakeOnnxCreated = !existsSync(ONNX_ABS);
    if (fakeOnnxCreated) {
      const onnxDir = path.dirname(ONNX_ABS);
      mkdirSync(onnxDir, { recursive: true });
      createdDirs.push(onnxDir, path.dirname(onnxDir));
      writeFileSync(ONNX_ABS, 'fake-onnx');
    }
    const packed = packedPaths();
    const slashRel = ONNX_REL.split(path.sep).join('/');
    expect(packed.has(slashRel)).toBe(false); // onnx 不得进包
    for (const name of SMALL_FILES) {
      const rel = path.join('models', EMBEDDING_MODEL_ID, name).split(path.sep).join('/');
      expect(packed.has(rel)).toBe(true); // 小文件仍随包分发
    }
  }, 30_000);
});
