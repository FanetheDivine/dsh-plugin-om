/**
 * 本地语义嵌入（recall-semantic 的向量引擎）：Xenova/paraphrase-multilingual-MiniLM-L12-v2
 * 量化 ONNX，懒加载 + 批量推理 + cosine 相似度，模型缺失时按需后台下载。
 * 导出 BUNDLED_MODEL_DIR / EMBEDDING_MODEL_ID / resolveDshHome / sharedModelDir /
 * ensureModelSmallFiles / getEmbedder / resetEmbedder / ensureModelReady /
 * resetModelDownloads / cosineSimilarity 及 EmbedFn / ModelStatus 类型。
 * 模型目录默认为跨版本共享目录（$DSH_HOME/plugin-data/dsh-plugin-om/models/<id>）：
 * 随包小文件缺失时从打包目录复制补齐（离线可用），onnx 二进制按需下载
 * （见 model-download.ts）。@huggingface/transformers 为运行时依赖（dtype q8 加载
 * model_quantized.onnx，node 侧使用 onnxruntime-node 原生绑定）。
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  downloadModel,
  EMBEDDING_MODEL_ID,
  MODEL_SMALL_FILES,
  type ModelFetch,
  modelTargetPath,
  needsDownload,
} from './model-download.ts';

/** 当前模块所在路径（dist/ 或 src/，models 在其上一级）。 */
const here = path.dirname(fileURLToPath(import.meta.url));

/** 打包模型目录：<包根>/models/<model-id>/。 */
export const BUNDLED_MODEL_DIR = path.join(here, '..', 'models', EMBEDDING_MODEL_ID);

export { EMBEDDING_MODEL_ID };

/** DSH 用户数据根目录：$DSH_HOME 优先（空白视为未设置），缺省 ~/.dsh。 */
export function resolveDshHome(): string {
  const fromEnv = process.env.DSH_HOME;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return path.resolve(fromEnv);
  return path.join(homedir(), '.dsh');
}

/** 跨插件版本共享的默认模型目录：$DSH_HOME/plugin-data/dsh-plugin-om/models/<模型id>。 */
export function sharedModelDir(): string {
  return path.join(resolveDshHome(), 'plugin-data', 'dsh-plugin-om', 'models', EMBEDDING_MODEL_ID);
}

/**
 * 补齐模型目录的随包小文件（config/tokenizer 等）：modelDir 与打包目录不同时，
 * 把打包目录中缺失的小文件复制过去（已存在不覆盖；打包目录缺失则跳过）。
 * 幂等、无网络；onnx 二进制不在此列。
 */
export function ensureModelSmallFiles(
  modelDir: string,
  bundledDir: string = BUNDLED_MODEL_DIR,
): void {
  if (path.resolve(modelDir) === path.resolve(bundledDir)) return;
  for (const rel of MODEL_SMALL_FILES) {
    const src = path.join(bundledDir, rel);
    const dest = path.join(modelDir, rel);
    if (existsSync(dest) || !existsSync(src)) continue;
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
}

/** 嵌入函数类型：批量文本 → 每条一个向量（Float32Array）。 */
export type EmbedFn = (texts: readonly string[]) => Promise<Float32Array[]>;

/** 单批最大文本数（避免单次推理过大）。 */
const BATCH_SIZE = 32;

/** 各模型目录的单飞加载缓存。 */
const pipelines = new Map<string, Promise<EmbedFn>>();

/** 懒加载 transformers 模块，跨模型目录并发初始化共享同一个导入。 */
let transformersPromise: Promise<typeof import('@huggingface/transformers')> | undefined;

/** 获取模型目录对应的嵌入函数，同目录单飞，失败允许再次加载。 */
export function getEmbedder(modelDir: string = BUNDLED_MODEL_DIR): Promise<EmbedFn> {
  const directory = path.resolve(modelDir);
  const existing = pipelines.get(directory);
  if (existing) return existing;
  const loading = (async () => {
    ensureModelSmallFiles(directory);
    if (!transformersPromise) transformersPromise = import('@huggingface/transformers');
    const { pipeline } = await transformersPromise;
    const extractor = await pipeline('feature-extraction', directory, {
      dtype: 'q8',
      local_files_only: true,
    });
    return async (texts: readonly string[]): Promise<Float32Array[]> => {
      const vectors: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);
        const result = await extractor(batch, { pooling: 'mean', normalize: true });
        const dims = result.dims as readonly number[];
        const hidden = dims.length > 1 ? (dims[1] as number) : 0;
        const data = result.data as ArrayLike<number>;
        for (let j = 0; j < batch.length; j += 1) {
          const start = j * hidden;
          if (hidden > 0) {
            vectors.push(
              Float32Array.from(Array.prototype.slice.call(data, start, start + hidden)),
            );
          }
        }
      }
      return vectors;
    };
  })();
  pipelines.set(directory, loading);
  void loading.catch(() => {
    if (pipelines.get(directory) === loading) pipelines.delete(directory);
  });
  return loading;
}

/** 重置模型目录缓存（测试用；在途加载完成后不缓存旧结果）。 */
export function resetEmbedder(): void {
  pipelines.clear();
}

/** 模型就绪状态：ready=本地已就绪；downloading=缺失，后台下载中/将自动重试。 */
export type ModelStatus = 'ready' | 'downloading';

/** 每个 modelDir 的在途下载任务（单飞：并发查询只发起一次下载）。 */
const inflightDownloads = new Map<string, Promise<void>>();

/**
 * 确保模型就绪（运行时按需下载编排）。
 * 本地 onnx 已存在 → 'ready'；缺失 → 启动后台下载（不阻塞、单飞，失败经 warn 记录，
 * 下次调用自动重试）并返回 'downloading'。warn/log/fetchImpl 可注入（测试传替身）。
 */
export function ensureModelReady(
  modelDir: string = BUNDLED_MODEL_DIR,
  warn: (message: string) => void = () => {},
  fetchImpl?: ModelFetch,
  log: (message: string) => void = () => {},
): Promise<ModelStatus> {
  ensureModelSmallFiles(modelDir);
  const target = modelTargetPath(modelDir);
  if (!needsDownload(target)) return Promise.resolve('ready');
  if (!inflightDownloads.has(modelDir)) {
    const task: Promise<void> = downloadModel(
      modelDir,
      fetchImpl === undefined ? { log } : { fetchImpl, log },
    )
      .then(() => {})
      .catch((err: unknown) => {
        warn(`[download-model] 下载失败：${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        inflightDownloads.delete(modelDir);
      });
    inflightDownloads.set(modelDir, task);
  }
  return Promise.resolve('downloading');
}

/** 重置下载状态（测试用：清空在途下载任务记录）。 */
export function resetModelDownloads(): void {
  inflightDownloads.clear();
}

/** 两个向量的余弦相似度（向量已 L2 归一化时点积即余弦；这里兜底再归一化）。零向量返回 0。 */
export function cosineSimilarity(
  a: Float32Array | readonly number[],
  b: Float32Array | readonly number[],
): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
