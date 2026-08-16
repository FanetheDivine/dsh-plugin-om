// 模型下载 CLI：开发环境手动预下载嵌入模型（运行时由插件按需下载，见 src/model-download.ts）。
// 用法：pnpm run download:model [--force]（--force 强制重下；已存在则跳过）。
// 直连 huggingface.co 受限时设置环境变量 HF_ENDPOINT=https://hf-mirror.com 走镜像。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadModel, EMBEDDING_MODEL_ID } from '../src/model-download.ts';

// 仅在作为 CLI 直接执行时运行（import 用于测试时无副作用）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const modelDir = path.join(root, 'models', EMBEDDING_MODEL_ID);
  downloadModel(modelDir, { force: process.argv.includes('--force') }).catch((err) => {
    console.error(`[download-model] ${err.message}`);
    process.exit(1);
  });
}
