// recall-output.ts 单元测试：recall 输出投影（output.render）与 RECALL_OUTPUT_SCHEMA 结构校验。
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { describe, expect, it } from 'vitest';

import { buildRecallTool } from '../src/recall.ts';
import { RECALL_OUTPUT_SCHEMA, type RecallOutputValue } from '../src/recall-output.ts';
import type { ContentBlock } from '../src/types.ts';

describe('recall 输出投影与 schema', () => {
  it('output.render 投影：text 块在前，images 逐个投影为 image 块', () => {
    const value: RecallOutputValue = {
      text: '正文',
      images: [{ attachmentId: 'att-9', mediaType: 'image/png', bytes: 9, width: 4, height: 3 }],
    };
    const blocks = buildRecallTool().output?.render?.({}, value) as ContentBlock[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'text', text: '正文' });
    expect(blocks[1]).toEqual({
      type: 'image',
      attachment: { attachmentId: 'att-9', mediaType: 'image/png', bytes: 9, width: 4, height: 3 },
    });
  });

  it('输出值满足 RECALL_OUTPUT_SCHEMA', () => {
    expect(validateJsonSchemaValue(RECALL_OUTPUT_SCHEMA, { text: 'x', images: [] })).toEqual([]);
    const problems = validateJsonSchemaValue(RECALL_OUTPUT_SCHEMA, {
      text: 'x',
      images: [{ attachmentId: 1 }],
    });
    expect(problems.length).toBeGreaterThan(0);
  });
});
