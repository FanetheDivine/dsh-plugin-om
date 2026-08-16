/**
 * 嵌入模型下载：recall-semantic 运行时按需下载 + 开发手动预下载共用。
 *
 * - 模型：Xenova/paraphrase-multilingual-MiniLM-L12-v2（量化 ONNX ~113MB，超过
 *   GitHub 单文件 100MB 限制，不能进入 git 仓库；仅小文件随仓库提交）。
 * - 下载目标：<modelDir>/onnx/model_quantized.onnx（modelDir 默认 = 插件包内
 *   models/<id>/，与 embedding.ts 的本地加载路径一致；自定义 modelDir 同样生效）。
 * - 直连 huggingface.co 受限时设置环境变量 HF_ENDPOINT=https://hf-mirror.com 走镜像。
 * - 原子落盘：先写 .tmp 再改名，避免半截文件被当成完整模型加载。
 * - 日志：下载开始/结束（含跳过）经 log 回调输出（默认 console.log）；失败时
 *   错误消息附带 HF_ENDPOINT=https://hf-mirror.com 镜像建议。
 *
 * 运行时编排见 embedding.ts 的 ensureModelReady（下载单飞、未就绪不阻塞）；
 * 本模块只提供纯下载原语（供 src 与 scripts/download-model.mjs CLI 复用）。
 */
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 模型标识（models/ 下目录名 = 模型 id；transformers.js 加载时的模型名）。 */
export const EMBEDDING_MODEL_ID = 'paraphrase-multilingual-MiniLM-L12-v2';

/** transformers.js 转换仓库（Xenova org）中量化 ONNX 文件的相对路径（相对模型目录）。 */
export const ONNX_REL = 'onnx/model_quantized.onnx';

/** 随 npm 包分发的小模型文件（相对模型目录；onnx 二进制不随包分发，见 tests/package-pack.test.ts）。 */
export const MODEL_SMALL_FILES = [
  'config.json',
  'special_tokens_map.json',
  'tokenizer.json',
  'tokenizer_config.json',
];

/** 下载返回结果。 */
export type DownloadResult = { downloaded: boolean; bytes: number; target: string };

/**
 * HuggingFace 原始文件 URL（resolve 会 302 到 CDN，fetch 自动跟随重定向）。
 * base 默认 huggingface.co，可用环境变量 HF_ENDPOINT 覆盖（直连受限时改用镜像，如 https://hf-mirror.com）。
 */
export function modelSourceUrl(
  id: string = EMBEDDING_MODEL_ID,
  rel: string = ONNX_REL,
  base: string = process.env.HF_ENDPOINT || 'https://huggingface.co',
): string {
  return `${base}/Xenova/${id}/resolve/main/${rel}`;
}

/** 本地目标文件绝对路径（<modelDir>/<rel>，缺省 <modelDir>/onnx/model_quantized.onnx）。 */
export function modelTargetPath(modelDir: string, rel: string = ONNX_REL): string {
  return path.join(modelDir, rel);
}

/**
 * 是否需要下载（纯函数，供测试）。
 * force 强制下载；否则目标已存在即跳过。
 */
export function needsDownload(
  target: string,
  { force = false }: { force?: boolean } = {},
): boolean {
  if (force) return true;
  try {
    statSync(target);
    return false;
  } catch {
    return true;
  }
}

/** fetch 最小可用接口（全局 fetch 满足；测试注入替身，无需完整 Response）。 */
export type ModelFetch = (url: string) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/**
 * 下载模型到 <modelDir>/onnx/model_quantized.onnx。
 * 开始/结束（含跳过）经 log 回调输出（默认 console.log）；失败时清理临时文件，
 * 并在错误消息中附带镜像建议（直连受限时设置 HF_ENDPOINT=https://hf-mirror.com）。
 * 可注入 fetchImpl / log（供测试）。
 */
export async function downloadModel(
  modelDir: string,
  {
    force = false,
    fetchImpl = fetch,
    log = console.log,
  }: {
    force?: boolean;
    fetchImpl?: ModelFetch;
    log?: (message: string) => void;
  } = {},
): Promise<DownloadResult> {
  const target = modelTargetPath(modelDir);
  if (!needsDownload(target, { force })) {
    log(`[download-model] 模型已存在，跳过下载：${target}`);
    return { downloaded: false, bytes: 0, target };
  }
  const url = modelSourceUrl();
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  log(`[download-model] 开始下载：${url}`);
  try {
    const resp = await fetchImpl(url);
    if (!resp.ok) {
      throw new Error(`下载失败：HTTP ${resp.status} ${resp.statusText}（${url}）`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    // 先写临时文件再原子改名，避免半截文件被当成完整模型加载
    writeFileSync(tmp, buf);
    renameSync(tmp, target);
    log(`[download-model] 下载完成：${buf.length} 字节 → ${target}`);
    return { downloaded: true, bytes: buf.length, target };
  } catch (err) {
    rmSync(tmp, { force: true });
    const detail = err instanceof Error ? err.message : String(err);
    // 失败时附带镜像建议：直连 huggingface.co 受限时设置 HF_ENDPOINT 走 hf-mirror.com
    throw new Error(
      `${detail}；如直连 HuggingFace 受限，请设置环境变量 HF_ENDPOINT=https://hf-mirror.com 后重试`,
    );
  }
}
