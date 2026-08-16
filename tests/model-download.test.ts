// model-download 单测：URL/路径解析、跳过判定、下载落盘（fake fetch，完全离线）。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUNDLED_MODEL_DIR,
  ensureModelReady,
  ensureModelSmallFiles,
  resetModelDownloads,
  sharedModelDir,
} from '../src/embedding.ts';
import {
  downloadModel,
  EMBEDDING_MODEL_ID,
  MODEL_SMALL_FILES,
  type ModelFetch,
  modelSourceUrl,
  modelTargetPath,
  needsDownload,
} from '../src/model-download.ts';

const ACTIVE_DIRS: string[] = [];

function tempRoot() {
  const dir = mkdtempSync(path.join(tmpdir(), 'model-download-'));
  ACTIVE_DIRS.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of ACTIVE_DIRS) rmSync(dir, { recursive: true, force: true });
  ACTIVE_DIRS.length = 0;
});

/** 预置一个"已存在"的模型文件（先建目录再写入）。 */
function writeExisting(target: string, content: string) {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/** 可控 fetch 替身：记录调用 URL，返回固定响应体。 */
function fakeFetch(status = 200, body = 'fake-onnx-bytes') {
  const calls: string[] = [];
  const impl: ModelFetch = async (url) => {
    calls.push(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Not Found',
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    };
  };
  return { impl, calls };
}

describe('modelSourceUrl', () => {
  it('指向 Xenova 转换仓库的量化 ONNX 文件（HF_ENDPOINT 未设置时用默认源）', () => {
    const prev = process.env.HF_ENDPOINT;
    try {
      delete process.env.HF_ENDPOINT;
      expect(modelSourceUrl()).toBe(
        'https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2/resolve/main/onnx/model_quantized.onnx',
      );
    } finally {
      if (prev === undefined) delete process.env.HF_ENDPOINT;
      else process.env.HF_ENDPOINT = prev;
    }
  });

  it('支持镜像/自定义 base（HF_ENDPOINT 或显式传参）', () => {
    expect(
      modelSourceUrl(EMBEDDING_MODEL_ID, 'onnx/model_quantized.onnx', 'https://hf-mirror.com'),
    ).toBe(
      'https://hf-mirror.com/Xenova/paraphrase-multilingual-MiniLM-L12-v2/resolve/main/onnx/model_quantized.onnx',
    );
    const prev = process.env.HF_ENDPOINT;
    try {
      process.env.HF_ENDPOINT = 'https://hf-mirror.com';
      expect(modelSourceUrl()).toContain('https://hf-mirror.com/');
    } finally {
      if (prev === undefined) delete process.env.HF_ENDPOINT;
      else process.env.HF_ENDPOINT = prev;
    }
  });
});

describe('modelTargetPath', () => {
  it('解析到 <modelDir>/onnx/model_quantized.onnx（模型目录下的相对路径）', () => {
    const modelDir = path.join('E:/repo', 'models', EMBEDDING_MODEL_ID);
    expect(modelTargetPath(modelDir)).toBe(path.join(modelDir, 'onnx', 'model_quantized.onnx'));
  });

  it('支持自定义相对路径', () => {
    const modelDir = path.join('E:/repo', 'models', EMBEDDING_MODEL_ID);
    expect(modelTargetPath(modelDir, 'onnx/model_quantized.onnx')).toBe(
      path.join(modelDir, 'onnx', 'model_quantized.onnx'),
    );
  });
});

describe('sharedModelDir（跨版本共享默认目录）', () => {
  it('DSH_HOME 未设置：以 ~/.dsh 为根', () => {
    const prev = process.env.DSH_HOME;
    try {
      delete process.env.DSH_HOME;
      const dir = sharedModelDir();
      expect(path.isAbsolute(dir)).toBe(true);
      expect(dir.startsWith(path.join(homedir(), '.dsh'))).toBe(true);
      expect(
        dir.endsWith(path.join('plugin-data', 'dsh-plugin-om', 'models', EMBEDDING_MODEL_ID)),
      ).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prev;
    }
  });

  it('DSH_HOME 已设置：以 $DSH_HOME 为根（空白视为未设置）', () => {
    const prev = process.env.DSH_HOME;
    try {
      process.env.DSH_HOME = 'E:/custom-home';
      expect(sharedModelDir()).toBe(
        path.join('E:/custom-home', 'plugin-data', 'dsh-plugin-om', 'models', EMBEDDING_MODEL_ID),
      );
      process.env.DSH_HOME = '   ';
      expect(sharedModelDir()).not.toContain('custom-home');
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prev;
    }
  });
});

describe('ensureModelSmallFiles（共享目录补齐随包小文件）', () => {
  it('缺失的小文件从打包目录复制（内容一致）；已存在不覆盖', () => {
    const modelDir = path.join(tempRoot(), 'models', EMBEDDING_MODEL_ID);
    ensureModelSmallFiles(modelDir);
    for (const rel of MODEL_SMALL_FILES) {
      const dest = path.join(modelDir, rel);
      expect(existsSync(dest)).toBe(true);
      expect(readFileSync(dest, 'utf8')).toBe(
        readFileSync(path.join(BUNDLED_MODEL_DIR, rel), 'utf8'),
      );
    }
    // 已存在不覆盖（用户自定义内容保留）
    writeFileSync(path.join(modelDir, 'config.json'), 'custom');
    ensureModelSmallFiles(modelDir);
    expect(readFileSync(path.join(modelDir, 'config.json'), 'utf8')).toBe('custom');
  });

  it('目标即打包目录：直接返回，不产生副作用', () => {
    expect(() => ensureModelSmallFiles(BUNDLED_MODEL_DIR)).not.toThrow();
    for (const rel of MODEL_SMALL_FILES) {
      expect(existsSync(path.join(BUNDLED_MODEL_DIR, rel))).toBe(true);
    }
  });
});

describe('needsDownload', () => {
  it('目标不存在：需要下载', () => {
    const modelDir = path.join(tempRoot(), 'models', EMBEDDING_MODEL_ID);
    expect(needsDownload(modelTargetPath(modelDir))).toBe(true);
  });

  it('目标已存在：跳过下载', () => {
    const modelDir = path.join(tempRoot(), 'models', EMBEDDING_MODEL_ID);
    const target = modelTargetPath(modelDir);
    writeExisting(target, 'x');
    expect(needsDownload(target)).toBe(false);
  });

  it('force：即使存在也重新下载', () => {
    const modelDir = path.join(tempRoot(), 'models', EMBEDDING_MODEL_ID);
    const target = modelTargetPath(modelDir);
    writeExisting(target, 'x');
    expect(needsDownload(target, { force: true })).toBe(true);
  });
});

describe('downloadModel', () => {
  it('成功下载：开始/结束日志（开始先于结束）、建目录、落盘内容、原子改名（无 .tmp 残留）', async () => {
    const modelDir = path.join(tempRoot(), 'models', EMBEDDING_MODEL_ID);
    const { impl, calls } = fakeFetch(200, 'hello-model');
    const logs: string[] = [];
    const result = await downloadModel(modelDir, { fetchImpl: impl, log: (m) => logs.push(m) });
    const target = modelTargetPath(modelDir);
    expect(result.downloaded).toBe(true);
    expect(result.bytes).toBe(11);
    expect(result.target).toBe(target);
    expect(readFileSync(target, 'utf8')).toBe('hello-model');
    expect(existsSync(`${target}.tmp`)).toBe(false);
    expect(calls).toEqual([modelSourceUrl()]);
    expect(logs.join('\n')).toContain(`开始下载：${modelSourceUrl()}`);
    expect(logs.join('\n')).toContain('下载完成：11 字节');
    expect(logs[0]).toContain('开始下载'); // 开始日志在结束日志之前
    expect(logs[1]).toContain('下载完成');
  });

  it('已存在且未强制：跳过（不发起请求）', async () => {
    const modelDir = path.join(tempRoot(), 'models', EMBEDDING_MODEL_ID);
    const target = modelTargetPath(modelDir);
    writeExisting(target, 'old');
    const { impl, calls } = fakeFetch(200);
    const result = await downloadModel(modelDir, { fetchImpl: impl });
    expect(result.downloaded).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('old');
    expect(calls).toHaveLength(0);
  });

  it('force：覆盖已存在的文件', async () => {
    const modelDir = path.join(tempRoot(), 'models', EMBEDDING_MODEL_ID);
    const target = modelTargetPath(modelDir);
    writeExisting(target, 'old');
    const { impl } = fakeFetch(200, 'new-bytes');
    await downloadModel(modelDir, { force: true, fetchImpl: impl });
    expect(readFileSync(target, 'utf8')).toBe('new-bytes');
  });

  it('HTTP 错误：抛错附带 HF_ENDPOINT 镜像建议，不留下目标文件或 .tmp 残留', async () => {
    const modelDir = path.join(tempRoot(), 'models', EMBEDDING_MODEL_ID);
    const { impl } = fakeFetch(404);
    await expect(downloadModel(modelDir, { fetchImpl: impl })).rejects.toThrow(/HTTP 404/);
    await expect(downloadModel(modelDir, { fetchImpl: impl })).rejects.toThrow(
      /HF_ENDPOINT=https:\/\/hf-mirror\.com/,
    );
    expect(existsSync(modelTargetPath(modelDir))).toBe(false);
    expect(existsSync(`${modelTargetPath(modelDir)}.tmp`)).toBe(false);
  });
});

describe('ensureModelReady（运行时下载编排）', () => {
  afterEach(() => {
    resetModelDownloads();
  });

  /** 等待宏任务让后台下载任务结算（fetch 替身为立即 resolve）。 */
  async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('模型已存在：返回 ready，不发起下载，同时补齐随包小文件', async () => {
    const modelDir = path.join(tempRoot(), 'models', EMBEDDING_MODEL_ID);
    writeExisting(modelTargetPath(modelDir), 'x');
    const { impl, calls } = fakeFetch(200);
    await expect(ensureModelReady(modelDir, () => {}, impl)).resolves.toBe('ready');
    expect(calls).toHaveLength(0);
    for (const rel of MODEL_SMALL_FILES) {
      expect(existsSync(path.join(modelDir, rel))).toBe(true); // 共享目录小文件已补齐
    }
  });

  it('模型缺失：返回 downloading 并触发后台下载（不阻塞），完成后落盘', async () => {
    const modelDir = path.join(tempRoot(), 'models', EMBEDDING_MODEL_ID);
    const { impl, calls } = fakeFetch(200, 'bytes');
    const status = await ensureModelReady(modelDir, () => {}, impl);
    expect(status).toBe('downloading');
    expect(calls).toHaveLength(1);
    await settle();
    expect(existsSync(modelTargetPath(modelDir))).toBe(true);
  });

  it('单飞：并发多次调用只发起一次下载', async () => {
    const modelDir = path.join(tempRoot(), 'models', EMBEDDING_MODEL_ID);
    const { impl, calls } = fakeFetch(200, 'bytes');
    const statuses = await Promise.all([
      ensureModelReady(modelDir, () => {}, impl),
      ensureModelReady(modelDir, () => {}, impl),
      ensureModelReady(modelDir, () => {}, impl),
    ]);
    expect(statuses).toEqual(['downloading', 'downloading', 'downloading']);
    expect(calls).toHaveLength(1);
  });

  it('下载完成后再次调用返回 ready（无需另行通知）', async () => {
    const modelDir = path.join(tempRoot(), 'models', EMBEDDING_MODEL_ID);
    const { impl } = fakeFetch(200, 'bytes');
    await ensureModelReady(modelDir, () => {}, impl);
    await settle();
    await expect(ensureModelReady(modelDir, () => {}, impl)).resolves.toBe('ready');
  });

  it('下载失败：仅记日志（含镜像建议），下次调用自动重试', async () => {
    const modelDir = path.join(tempRoot(), 'models', EMBEDDING_MODEL_ID);
    const { impl, calls } = fakeFetch(500);
    const warns: string[] = [];
    await ensureModelReady(modelDir, (m) => warns.push(m), impl);
    expect(calls).toHaveLength(1);
    await settle();
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain('下载失败');
    expect(warns[0]).toContain('HF_ENDPOINT=https://hf-mirror.com'); // 失败附带镜像建议
    // 下次调用重新触发下载（自动重试）
    await ensureModelReady(modelDir, () => {}, impl);
    expect(calls).toHaveLength(2);
  });

  it('log 透传：下载开始/结束经 log 回调输出', async () => {
    const modelDir = path.join(tempRoot(), 'models', EMBEDDING_MODEL_ID);
    const { impl } = fakeFetch(200, 'bytes');
    const logs: string[] = [];
    const status = await ensureModelReady(
      modelDir,
      () => {},
      impl,
      (m) => logs.push(m),
    );
    expect(status).toBe('downloading');
    await settle();
    expect(existsSync(modelTargetPath(modelDir))).toBe(true);
    expect(logs.join('\n')).toContain('开始下载');
    expect(logs.join('\n')).toContain('下载完成');
  });
});
