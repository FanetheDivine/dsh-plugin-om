// utils.ts 单元测试：零依赖工具函数 isRecord / uuid / blocksToText / textCharCount /
// renderMessageText / safeJson / isMainSession / routedTarget 的直接覆盖。
import { describe, expect, it } from 'vitest';

import type { Session } from '../src/types.ts';
import {
  blocksToText,
  isMainSession,
  isRecord,
  renderMessageText,
  routedTarget,
  safeJson,
  textCharCount,
  uuid,
} from '../src/utils.ts';

describe('isRecord', () => {
  it('普通对象为 true，null / 数组 / 原始值为 false', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([1])).toBe(false);
    expect(isRecord('x')).toBe(false);
  });
});

describe('uuid', () => {
  it('生成非空且互不重复的字符串', () => {
    const a = uuid();
    const b = uuid();
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});

describe('blocksToText', () => {
  it('仅拼接 text 块，忽略其余块；非数组输入返回空串', () => {
    expect(
      blocksToText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]),
    ).toBe('ab');
    expect(blocksToText('not-array')).toBe('');
  });
});

describe('textCharCount', () => {
  it('text 块计入字符数，tool-result 计入内嵌文本，空消息为 0', () => {
    expect(textCharCount(null)).toBe(0);
    expect(
      textCharCount({
        content: [
          { type: 'text', text: 'ab' },
          { type: 'tool-result', content: [{ type: 'text', text: 'cd' }] },
        ],
      } as never),
    ).toBe(4);
  });
});

describe('renderMessageText', () => {
  it('text 原样；tool-call 展开名称/id/参数 JSON；tool-result 取文本；块间换行', () => {
    expect(
      renderMessageText({
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool-call', name: 'run_code', id: 'c1', arguments: { code: 'a()' } },
          { type: 'tool-result', content: [{ type: 'text', text: 'out' }] },
        ],
      } as never),
    ).toBe(['hi', '[tool-call run_code id=c1]\n{\n  "code": "a()"\n}', 'out'].join('\n'));
  });
});

describe('safeJson', () => {
  it('正常序列化（两空格缩进）；循环引用等失败场景退回 String 呈现', () => {
    expect(safeJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(safeJson(cyclic)).toBe(String(cyclic));
  });
});

describe('isMainSession', () => {
  it('header.origin 为 subagent 即子会话，其余（含缺省 header）为主会话', () => {
    expect(isMainSession({ header: { origin: 'user' } } as unknown as Session)).toBe(true);
    expect(isMainSession({ header: { origin: 'subagent' } } as unknown as Session)).toBe(false);
    expect(isMainSession({} as unknown as Session)).toBe(true);
  });
});

describe('routedTarget', () => {
  it('返回 provider + model；未路由或 requestHeader 抛错时返回 undefined', () => {
    expect(
      routedTarget({
        requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
      } as unknown as Session),
    ).toEqual({ provider: 'p', model: 'm' });
    expect(routedTarget({ requestHeader: () => ({}) } as unknown as Session)).toBeUndefined();
    expect(
      routedTarget({
        requestHeader: () => {
          throw new Error('未路由');
        },
      } as unknown as Session),
    ).toBeUndefined();
  });
});
