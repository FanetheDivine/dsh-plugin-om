// 模型下载脚本：构建/发布时从 HuggingFace 拉取量化 ONNX 嵌入模型。
// 背景：模型二进制 ~113MB，超过 GitHub 单文件 100MB 限制，不能进入 git 仓库；
// npm 包仍随包分发（files 含 models/），由 prepack 钩子（npm pack/publish）或
// `pnpm run download:model` 在打包/开发前补齐。直连受限时设置 HF_ENDPOINT=https://hf-mirror.com。
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 模型标识（models/ 下目录名 = 模型 id）。 */
export const MODEL_ID = 'paraphrase-multilingual-MiniLM-L12-v2';
/** transformers.js 转换仓库（Xenova org）中量化 ONNX 文件的相对路径。 */
export const ONNX_REL = 'onnx/model_quantized.onnx';

/** HuggingFace 原始文件 URL（resolve 会 302 到 CDN，fetch 自动跟随重定向）。
 * base 默认 huggingface.co，可用环境变量 HF_ENDPOINT 覆盖（直连受限时改用镜像，如 https://hf-mirror.com）。 */
export function modelSourceUrl(
  id = MODEL_ID,
  rel = ONNX_REL,
  base = process.env.HF_ENDPOINT || 'https://huggingface.co',
) {
  return `${base}/Xenova/${id}/resolve/main/${rel}`;
}

/** 本地目标文件绝对路径（<root>/models/<id>/<rel>）。 */
export function modelTargetPath(root, id = MODEL_ID, rel = ONNX_REL) {
  return path.join(root, 'models', id, rel);
}

/**
 * 是否需要下载（纯函数，供测试）。
 * force 强制下载；否则目标已存在即跳过。
 */
export function needsDownload(target, { force = false } = {}) {
  if (force) return true;
  try {
    statSync(target);
    return false;
  } catch {
    return true;
  }
}

/**
 * 下载模型到 <root>/models/<id>/<rel>。
 * 可注入 fetchImpl / log（供测试）；失败时清理临时文件并抛出。
 */
export async function downloadModel(
  root,
  { force = false, fetchImpl = fetch, log = console.log } = {},
) {
  const target = modelTargetPath(root);
  if (!needsDownload(target, { force })) {
    log(`[download-model] 已存在，跳过：${target}`);
    return { downloaded: false, bytes: 0, target };
  }
  const url = modelSourceUrl();
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  try {
    const resp = await fetchImpl(url);
    if (!resp.ok) {
      throw new Error(`下载失败：HTTP ${resp.status} ${resp.statusText}（${url}）`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    // 先写临时文件再原子改名，避免半截文件被当成完整模型加载
    writeFileSync(tmp, buf);
    renameSync(tmp, target);
    log(`[download-model] 已下载 ${buf.length} 字节 → ${target}`);
    return { downloaded: true, bytes: buf.length, target };
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// 仅在作为 CLI 直接执行时运行（import 用于测试时无副作用）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  downloadModel(root, { force: process.argv.includes('--force') }).catch((err) => {
    console.error(`[download-model] ${err.message}`);
    process.exit(1);
  });
}
