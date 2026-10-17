// compaction-eval 测试夹具：宿主格式的已压缩主会话日志，供 view 与 prepare 测试共用。
// 导出 compactedLog。

import { expect } from 'vitest';

import type { SessionEvent as LogEvent } from '../.agents/skills/compaction-eval/scripts/session-source.ts';
import { observePass } from '../src/compress.ts';
import { resolveConfig } from '../src/config.ts';
import {
  buildToolCallFlow,
  hostLog,
  makeCtx,
  makeSession,
  type RoundScript,
  roundChunks,
  twoCallFlow,
} from './helpers.ts';

/** 观察压缩脚本：getHistory → 把助手条目改写为摘要 → completeCompression。 */
function observeScript(index: number): unknown[] {
  const scripts: RoundScript[] = [
    { calls: [{ id: 'g', name: 'getHistory' }] },
    { calls: [{ id: 'c', name: 'compressHistory', args: { index: 1, content: '助手摘要' } }] },
    { calls: [{ id: 'done', name: 'completeCompression' }] },
  ];
  return roundChunks(scripts[Math.min(index, scripts.length - 1)] as RoundScript);
}

/** 对 twoCallFlow（完整消息 0..5）跑一次观察压缩，再追加一轮工具调用（6..8），返回宿主格式日志。 */
export async function compactedLog(): Promise<LogEvent[]> {
  const session = makeSession({ events: twoCallFlow() });
  const ctx = makeCtx({ meterTotalTokens: 1_000_000, llmStreamFactory: observeScript });
  const result = await observePass(
    ctx,
    { session } as never,
    resolveConfig({ observeThresholdTokens: 1, tailMessageCount: 0, rateLimitWaitMs: 0 }),
    0,
    { provider: 'test', model: 'test-model' },
  );
  expect(result.failed).toBe(false);
  const later = buildToolCallFlow({
    code: 'thirdCode()',
    description: '第三次',
    callId: 'c3',
    resultText: 'out3',
  });
  return hostLog([...session.snapshotEvents(), ...later]);
}
