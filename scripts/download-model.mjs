// 模型下载 CLI：手动预下载嵌入模型到跨版本共享目录（默认与运行时一致，
// $DSH_HOME/plugin-data/dsh-plugin-om/models/<模型id>），已存在则跳过。
// 用法：pnpm run download:model [--force]（--force 强制重下）。
// 直连 huggingface.co 受限时设置环境变量 HF_ENDPOINT=https://hf-mirror.com 走镜像。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedModelDir } from '../src/embedding.ts';
import { downloadModel } from '../src/model-download.ts';

// 仅在作为 CLI 直接执行时运行（import 用于测试时无副作用）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const modelDir = sharedModelDir();
  console.log(`[download-model] 目标目录：${modelDir}`);
  downloadModel(modelDir, { force: process.argv.includes('--force') }).catch((err) => {
    console.error(`[download-model] ${err.message}`);
    process.exit(1);
  });
}
