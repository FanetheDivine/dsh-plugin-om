// compaction-eval 文件位置测试：评估根目录跟随系统临时目录，
// 评估目录、视图文件与重压缩目录按会话、阶段、区间命名，同一视图多次运行落在同一位置。

import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  bareId,
  evalPath,
  evalRoot,
  rangeSlug,
  recompressPath,
  viewPath,
} from '../.agents/skills/compaction-eval/scripts/paths.ts';

/** os.tmpdir 读取的环境变量：Windows 取 TEMP/TMP，POSIX 取 TMPDIR。 */
const TEMP_KEYS = ['TEMP', 'TMP', 'TMPDIR'] as const;
/** 测试前的环境变量值。 */
const saved: Partial<Record<(typeof TEMP_KEYS)[number], string>> = {};
/** 测试中替换的临时目录。 */
const FAKE_TMP = join(process.cwd(), 'fake-tmp');

beforeEach(() => {
  for (const key of TEMP_KEYS) {
    const value = process.env[key];
    if (value !== undefined) saved[key] = value;
    process.env[key] = FAKE_TMP;
  }
});

afterEach(() => {
  for (const key of TEMP_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete saved[key];
  }
});

/** 最小视图文件：只含命名用到的字段。 */
const view = (id: string, phase: string, minIndex: number, maxIndex: number) => ({
  header: { id },
  phase,
  view: { minIndex, maxIndex },
});

describe('评估文件位置', () => {
  it('根目录跟随系统临时目录，不在工作区内', () => {
    expect(evalRoot()).toBe(join(FAKE_TMP, 'om-compaction-eval'));
  });

  it('区间标识取裸会话 id 前 8 位，带不带 session- 前缀一致', () => {
    expect(bareId('session-b011-4c92')).toBe('b011-4c92');
    expect(bareId('b011-4c92')).toBe('b011-4c92');
    expect(rangeSlug('session-dc114f4d-9fe8', 'observe', 220, 241)).toBe(
      'dc114f4d-observe-220-241',
    );
    expect(rangeSlug('dc114f4d-9fe8', 'observe', 220, 241)).toBe('dc114f4d-observe-220-241');
    expect(evalPath('session-dc114f4d-9fe8', 'reflect', 0, 9)).toBe(
      join(FAKE_TMP, 'om-compaction-eval', 'eval-dc114f4d-reflect-0-9'),
    );
  });

  it('视图文件与重压缩目录按视图的会话、阶段、区间命名，同一视图位置不变', () => {
    const a = view('session-53f87427-9fe8', 'reflect', 0, 16);
    const root = join(FAKE_TMP, 'om-compaction-eval');
    expect(viewPath(a)).toBe(join(root, 'view-53f87427-reflect-0-16.json'));
    expect(recompressPath(a)).toBe(join(root, 'recompress-53f87427-reflect-0-16'));
    // 多个模型对同一视图的重压缩共用目录，prepare --variants 一次读全
    expect(recompressPath(view('session-53f87427-9fe8', 'reflect', 0, 16))).toBe(recompressPath(a));
    expect(recompressPath(view('session-53f87427-9fe8', 'observe', 0, 16))).not.toBe(
      recompressPath(a),
    );
  });
});
