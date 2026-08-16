/**
 * 本地语义嵌入（recall-semantic 的向量引擎）。
 *
 * - 模型：Xenova/paraphrase-multilingual-MiniLM-L12-v2（量化 ONNX，多语言，
 *   中英 + 代码均可处理）。模型目录默认 = $DSH_HOME/plugin-data/dsh-plugin-om/
 *   models/<模型id>/（跨插件版本共享）：随包小文件（config/tokenizer 等）缺失时
 *   从打包目录复制补齐（离线可用），onnx 二进制按需下载。
 * - 运行时下载：模型 onnx 缺失时由 ensureModelReady 后台下载（不阻塞、单飞、
 *   失败自动重试），下载逻辑见 model-download.ts；就绪前工具告知模型。
 * - 懒加载：首次调用才 `import('@huggingface/transformers')` 并加载 pipeline，
 *   插件启动不阻塞；加载结果单例缓存（resetEmbedder 供测试重置）。
 * - 批处理：一次推理多条文本（mean pooling + L2 归一化），输出每条的向量。
 * - 相似度：cosineSimilarity 纯函数（归一化向量点积即余弦）。
 *
 * 依赖说明：@huggingface/transformers 为运行时依赖（v4，dtype q8 加载
 * model_quantized.onnx），node 侧使用 onnxruntime-node 原生绑定。
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

/** DSH 用户数据根目录：$DSH_HOME 优先（空白视为未设置），缺省 ~/.dsh（与宿主解析规则一致）。 */
export function resolveDshHome(): string {
  const fromEnv = process.env.DSH_HOME;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return path.resolve(fromEnv);
  return path.join(homedir(), '.dsh');
}

/**
 * 跨插件版本共享的默认模型目录：$DSH_HOME/plugin-data/dsh-plugin-om/models/<模型id>。
 * 不随插件包（版本）变化，升级/重装插件后仍复用同一份已下载模型（onnx 不重复下载）。
 */
export function sharedModelDir(): string {
  return path.join(resolveDshHome(), 'plugin-data', 'dsh-plugin-om', 'models', EMBEDDING_MODEL_ID);
}

/**
 * 补齐模型目录的随包小文件（config/tokenizer 等）：modelDir 与打包目录不同
 * （如共享目录）时，把打包目录中缺失的小文件复制过去，保证模型可离线加载。
 * 已存在的文件不覆盖（同一模型文件跨版本稳定）；打包目录本身缺失则跳过。
 * 幂等、无网络。onnx 二进制不在此列（按需下载，见 model-download.ts）。
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

/** 懒加载中的 pipeline 单例（null = 尚未加载/已重置）。 */
let pipelinePromise: Promise<EmbedFn> | null = null;

/**
 * 获取（或加载）嵌入函数。首次调用动态 import transformers 并加载本地模型；
 * 之后复用同一 pipeline。失败时抛出可读错误（调用方自行降级）。
 */
export function getEmbedder(modelDir: string = BUNDLED_MODEL_DIR): Promise<EmbedFn> {
  if (pipelinePromise !== null) return pipelinePromise;
  pipelinePromise = (async () => {
    // 非打包目录（如共享目录）先补齐随包小文件（config/tokenizer 等），保证离线可加载
    ensureModelSmallFiles(modelDir);
    const { env, pipeline } = await import('@huggingface/transformers');
    // 只从本地目录加载（allowRemoteModels=false 保证离线，不会尝试联网）
    env.localModelPath = `${path.dirname(modelDir)}${path.sep}`;
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    // dtype: 'q8' → 加载 onnx/model_quantized.onnx（v4 用 dtype 而非 quantized）
    const extractor = await pipeline('feature-extraction', EMBEDDING_MODEL_ID, {
      dtype: 'q8',
    });
    return async (texts: readonly string[]): Promise<Float32Array[]> => {
      const vectors: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);
        const result = await extractor(batch, { pooling: 'mean', normalize: true });
        /** 结果张量：dims = [batch, hidden]，data 为扁平数组。 */
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
  return pipelinePromise;
}

/** 重置模型单例（测试用：卸载已加载的 pipeline）。 */
export function resetEmbedder(): void {
  pipelinePromise = null;
}

/** 模型就绪状态：ready=本地已就绪可直接加载；downloading=缺失，后台下载中/将自动重试。 */
export type ModelStatus = 'ready' | 'downloading';

/** 每个 modelDir 的在途下载任务（单飞：并发查询只发起一次下载）。 */
const inflightDownloads = new Map<string, Promise<void>>();

/**
 * 确保模型就绪（运行时按需下载编排）。
 * - 本地 onnx 已存在 → 'ready'（不触发下载）。
 * - 缺失 → 启动后台下载（不阻塞，单飞）并返回 'downloading'；下载失败仅调用
 *   warn 记录日志并结束本次尝试，下次调用会重新触发下载（自动重试）。
 * - warn 可选：下载失败时的日志回调（默认静默；apply 注入 ctx.logger.warn）。
 * - log 可选：下载开始/结束日志回调（默认静默；apply 注入 console.log + ctx.logger.info 双通道）。
 * - fetchImpl 可注入（测试传替身，默认全局 fetch）。
 */
export function ensureModelReady(
  modelDir: string = BUNDLED_MODEL_DIR,
  warn: (message: string) => void = () => {},
  fetchImpl?: ModelFetch,
  log: (message: string) => void = () => {},
): Promise<ModelStatus> {
  // 非打包目录（如共享目录）先补齐随包小文件（幂等），再判断 onnx 是否需要下载
  ensureModelSmallFiles(modelDir);
  const target = modelTargetPath(modelDir);
  if (!needsDownload(target)) return Promise.resolve('ready');
  if (!inflightDownloads.has(modelDir)) {
    // fetchImpl 可选注入（测试传替身）；缺省时不下传，保持 exactOptionalPropertyTypes 满足
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

/**
 * 两个向量的余弦相似度（向量已 L2 归一化时点积即余弦；这里兜底再归一化）。
 * 任一向量为零向量返回 0。
 */
export function cosineSimilarity(
  a: Float32Array | readonly number[],
  b: Float32Array | readonly number[],
): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  /** 点积累加。 */
  let dot = 0;
  /** a 的模平方。 */
  let normA = 0;
  /** b 的模平方。 */
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
