/**
 * 本地语义嵌入（recall-semantic 的向量引擎）。
 *
 * - 模型：Xenova/paraphrase-multilingual-MiniLM-L12-v2（量化 ONNX，多语言，
 *   中英 + 代码均可处理），随插件打包在 models/ 下，完全离线、零下载。
 * - 懒加载：首次调用才 `import('@huggingface/transformers')` 并加载 pipeline，
 *   插件启动不阻塞；加载结果单例缓存（resetEmbedder 供测试重置）。
 * - 批处理：一次推理多条文本（mean pooling + L2 归一化），输出每条的向量。
 * - 相似度：cosineSimilarity 纯函数（归一化向量点积即余弦）。
 *
 * 依赖说明：@huggingface/transformers 为运行时依赖（v4，dtype q8 加载
 * model_quantized.onnx），node 侧使用 onnxruntime-node 原生绑定。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 打包模型的目录名（models/ 下，目录名 = 模型 id）。 */
export const EMBEDDING_MODEL_ID = 'paraphrase-multilingual-MiniLM-L12-v2';

/** 当前模块所在路径（dist/ 或 src/，models 在其上一级）。 */
const here = path.dirname(fileURLToPath(import.meta.url));

/** 打包模型目录：<包根>/models/<model-id>/。 */
export const BUNDLED_MODEL_DIR = path.join(here, '..', 'models', EMBEDDING_MODEL_ID);

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
