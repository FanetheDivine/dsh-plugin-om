// getEmbedder 按真实模型目录隔离缓存，并行加载不修改 transformers 全局环境。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@huggingface/transformers', () => ({
  env: { localModelPath: '', allowLocalModels: false, allowRemoteModels: true },
  pipeline: vi.fn(),
}));

import { env, pipeline } from '@huggingface/transformers';
import { getEmbedder, resetEmbedder } from '../src/embedding.ts';

/** 等待异步管线加载时模拟切换目录。 */
function deferred() {
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release };
}

const roots: string[] = [];

/** 为两个模型提供不同父目录，测试全局 env 是否串行切换。 */
function modelDir() {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-om-'));
  roots.push(root);
  return path.join(root, 'embedding');
}

afterEach(() => {
  resetEmbedder();
  vi.mocked(pipeline).mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('模型目录切换', () => {
  it('切换目录后新查询不复用旧模型管线，相同目录并发仍只加载一次', async () => {
    const dirs: string[] = [];
    vi.mocked(pipeline).mockImplementation(async (_task, directory) => {
      if (!directory) throw new Error('缺少模型目录');
      dirs.push(directory);
      const modelIndex = dirs.length;
      return (async (texts: readonly string[]) => ({
        dims: [texts.length, 2],
        data: Float32Array.from(
          Array.from({ length: texts.length }, () => modelIndex).flatMap((n) => [n, 0]),
        ),
      })) as unknown as Awaited<ReturnType<typeof pipeline>>;
    });
    const oldDir = modelDir();
    const newDir = modelDir();
    const oldEmbed = await getEmbedder(oldDir);
    const newEmbed = await getEmbedder(newDir);
    expect(newEmbed).not.toBe(oldEmbed);
    expect((await oldEmbed(['old']))[0]?.[0]).toBe(1);
    expect((await newEmbed(['new']))[0]?.[0]).toBe(2);
    expect(dirs).toEqual([oldDir, newDir]);
    expect(pipeline).toHaveBeenCalledWith('feature-extraction', oldDir, {
      dtype: 'q8',
      local_files_only: true,
    });
    expect(pipeline).toHaveBeenCalledWith('feature-extraction', newDir, {
      dtype: 'q8',
      local_files_only: true,
    });
    expect(await getEmbedder(newDir)).toBe(newEmbed);
    expect(pipeline).toHaveBeenCalledTimes(2);
    expect(env.localModelPath).toBe('');
    expect(env.allowLocalModels).toBe(false);
    expect(env.allowRemoteModels).toBe(true);
  });

  it('旧目录在途加载时，新目录并发启动且 transformers 全局环境保持不变', async () => {
    const first = deferred();
    const started: string[] = [];
    vi.mocked(pipeline).mockImplementation(async (_task, directory) => {
      if (!directory) throw new Error('缺少模型目录');
      started.push(directory);
      if (started.length === 1) await first.pending;
      return (async (texts: readonly string[]) => ({
        dims: [texts.length, 2],
        data: new Float32Array(texts.length * 2),
      })) as unknown as Awaited<ReturnType<typeof pipeline>>;
    });
    const oldDir = modelDir();
    const newDir = modelDir();
    const firstQuery = getEmbedder(oldDir);
    const secondQuery = getEmbedder(newDir);
    try {
      await vi.waitFor(() => expect(started).toHaveLength(2));
      expect(started).toEqual([oldDir, newDir]);
      expect(env.localModelPath).toBe('');
      expect(env.allowLocalModels).toBe(false);
      expect(env.allowRemoteModels).toBe(true);
    } finally {
      first.release();
      await Promise.all([firstQuery, secondQuery]);
    }
  });
});
