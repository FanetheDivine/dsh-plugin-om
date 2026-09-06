// config.ts 单元测试：resolveConfig 配置解析 —— 各配置键的类型/范围校验、
// 默认值与非法值回退。
import { describe, expect, it } from 'vitest';

import { resolveConfig } from '../src/config.ts';

describe('配置校验 resolveConfig', () => {
  it('覆盖项生效', () => {
    const c = resolveConfig({ observeThresholdTokens: 5000, reflectThresholdTokens: 3000 });
    expect(c.observeThresholdTokens).toBe(5000);
    expect(c.reflectThresholdTokens).toBe(3000);
  });

  it('tailMessageCount：默认 5，任意数值可覆盖（不做区间限制），非整数回退默认', () => {
    expect(resolveConfig({}).tailMessageCount).toBe(5);
    expect(resolveConfig({ tailMessageCount: 3 }).tailMessageCount).toBe(3);
    expect(resolveConfig({ tailMessageCount: 0 }).tailMessageCount).toBe(0); // 无区间限制
    expect(resolveConfig({ tailMessageCount: 2.5 }).tailMessageCount).toBe(5); // 非整数回退默认
  });

  it('rateLimitWaitMs：默认 60000（429 后下一次请求前至少等待的毫秒数），整数可覆盖，非整数回退默认', () => {
    expect(resolveConfig({}).rateLimitWaitMs).toBe(60000);
    expect(resolveConfig({ rateLimitWaitMs: 1000 }).rateLimitWaitMs).toBe(1000);
    expect(resolveConfig({ rateLimitWaitMs: 0 }).rateLimitWaitMs).toBe(0); // 无区间限制（0 视为不限流）
    expect(resolveConfig({ rateLimitWaitMs: 2.5 }).rateLimitWaitMs).toBe(60000); // 非整数回退默认
    expect(resolveConfig({ rateLimitWaitMs: '1s' }).rateLimitWaitMs).toBe(60000); // 非数值回退默认
    expect(resolveConfig({ rateLimitWaitMs: '' }).rateLimitWaitMs).toBe(60000); // 留空回退默认
  });

  it('整份配置留空（undefined/null/空串/空白串）时全部用默认值', () => {
    const empty = [undefined, null, '', '   '];
    for (const raw of empty) {
      const d = resolveConfig(raw);
      expect(d.observeThresholdTokens).toBe(45000);
      expect(d.reflectThresholdTokens).toBe(120000);
      expect(d.compressMaxTokens).toBeUndefined();
      expect(d.tailMessageCount).toBe(5);
      expect(d.compressSkipReasoning).toBe(true);
      expect(d.omEnabled).toBe(true);
      expect(d.recallEnabled).toBe(true);
      expect(d.semanticRecallEnabled).toBe(true);
    }
  });

  it('单项留空（null/空串/undefined）该键用默认值，其余覆盖项仍生效', () => {
    expect(resolveConfig({ observeThresholdTokens: null }).observeThresholdTokens).toBe(45000);
    expect(resolveConfig({ observeThresholdTokens: '' }).observeThresholdTokens).toBe(45000);
    const mixed = resolveConfig({
      observeThresholdTokens: undefined,
      reflectThresholdTokens: 3000,
    });
    expect(mixed.observeThresholdTokens).toBe(45000);
    expect(mixed.reflectThresholdTokens).toBe(3000);
    const mixed2 = resolveConfig({ compressMaxTokens: null, tailMessageCount: 3 });
    expect(mixed2.compressMaxTokens).toBeUndefined();
    expect(mixed2.tailMessageCount).toBe(3);
  });

  it('宽松校验：未知键忽略、不合法值回退默认（不影响插件加载）', () => {
    expect(resolveConfig([])).toEqual(resolveConfig({})); // 空数组不是对象，回归默认
    expect(resolveConfig('0.5')).toEqual(resolveConfig({})); // 非空字符串不是对象，回归默认
    expect(resolveConfig({ badKey: 1 })).toEqual(resolveConfig({})); // 未知键忽略
    // 阈值不做取值区间限制：任意整数（调试场景）按原样接受
    expect(resolveConfig({ observeThresholdTokens: 0 }).observeThresholdTokens).toBe(0);
    expect(resolveConfig({ reflectThresholdTokens: 0 }).reflectThresholdTokens).toBe(0);
    expect(resolveConfig({ reflectThresholdTokens: 2 }).reflectThresholdTokens).toBe(2);
    expect(resolveConfig({ compressMaxTokens: 0 }).compressMaxTokens).toBe(0);
    expect(resolveConfig({ observeThresholdTokens: '0.5' }).observeThresholdTokens).toBe(45000); // 非数值回退默认
    expect(resolveConfig({ observeThresholdTokens: 2.5 }).observeThresholdTokens).toBe(45000); // 非整数回退默认
    expect(resolveConfig({ reflectThresholdTokens: 2.5 }).reflectThresholdTokens).toBe(120000); // 非整数回退默认
    expect(resolveConfig({ compressMaxTokens: 2.5 }).compressMaxTokens).toBeUndefined(); // 非整数视为未设置
    // 全部未知键被忽略 → 结果等于默认配置
    expect(
      resolveConfig({
        summaryMaxChars: 100,
        recallMaxMessages: 10,
        tailMessageBudget: 50,
        tailTokenBudgetRatio: 0.1,
        auto: false,
        evalEnabled: false,
        envDebug: true, // 环境变量名不再是配置键
      }),
    ).toEqual(resolveConfig({}));
  });
});

describe('debug 配置键', () => {
  it('缺省：按 NODE_ENV !== production 判定（dev/test 输出，production 隐藏）', () => {
    const prev = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(resolveConfig({}).debug).toBe(false);
      process.env.NODE_ENV = 'test';
      expect(resolveConfig({}).debug).toBe(true);
      delete process.env.NODE_ENV;
      expect(resolveConfig({}).debug).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });

  it('true 强制开启（含 production）、false 强制关闭（含 dev）', () => {
    const prev = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(resolveConfig({ debug: true }).debug).toBe(true);
      process.env.NODE_ENV = 'test';
      expect(resolveConfig({ debug: false }).debug).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });

  it('非 boolean 值回退默认；留空回退默认', () => {
    expect(resolveConfig({ debug: 'true' }).debug).toBe(process.env.NODE_ENV !== 'production');
    expect(resolveConfig({ debug: 1 }).debug).toBe(process.env.NODE_ENV !== 'production');
    expect(resolveConfig({ debug: null }).debug).toBe(process.env.NODE_ENV !== 'production');
    expect(resolveConfig({ debug: '' }).debug).toBe(process.env.NODE_ENV !== 'production');
  });
});

describe('omEnabled 配置键', () => {
  it('缺省启用（true）；留空（null/空串）回退默认', () => {
    expect(resolveConfig({}).omEnabled).toBe(true);
    expect(resolveConfig({ omEnabled: null }).omEnabled).toBe(true);
    expect(resolveConfig({ omEnabled: '' }).omEnabled).toBe(true);
    expect(resolveConfig({ omEnabled: '   ' }).omEnabled).toBe(true);
  });

  it('true / false 显式开关', () => {
    expect(resolveConfig({ omEnabled: true }).omEnabled).toBe(true);
    expect(resolveConfig({ omEnabled: false }).omEnabled).toBe(false);
  });

  it('不合法值回退默认（true）', () => {
    expect(resolveConfig({ omEnabled: 'false' }).omEnabled).toBe(true); // 字符串不合法
    expect(resolveConfig({ omEnabled: 0 }).omEnabled).toBe(true);
    expect(resolveConfig({ omEnabled: 'bogus' }).omEnabled).toBe(true);
  });

  it('summaryMode 不再是配置键（忽略、回归默认）', () => {
    expect(resolveConfig({ summaryMode: 'new' }).omEnabled).toBe(true); // 未知键忽略
    expect(resolveConfig({ summaryMode: 'fork' })).not.toHaveProperty('summaryMode');
  });
});

describe('compressSkipReasoning 配置键', () => {
  it('缺省跳过（true）；留空（null/空串）回退默认', () => {
    expect(resolveConfig({}).compressSkipReasoning).toBe(true);
    expect(resolveConfig({ compressSkipReasoning: null }).compressSkipReasoning).toBe(true);
    expect(resolveConfig({ compressSkipReasoning: '' }).compressSkipReasoning).toBe(true);
    expect(resolveConfig({ compressSkipReasoning: '   ' }).compressSkipReasoning).toBe(true);
  });

  it('true / false 显式开关（true 不携带 reasoning，false 携带）', () => {
    expect(resolveConfig({ compressSkipReasoning: true }).compressSkipReasoning).toBe(true);
    expect(resolveConfig({ compressSkipReasoning: false }).compressSkipReasoning).toBe(false);
  });

  it('不合法值回退默认（跳过）', () => {
    expect(resolveConfig({ compressSkipReasoning: 'false' }).compressSkipReasoning).toBe(true); // 字符串不合法
    expect(resolveConfig({ compressSkipReasoning: 0 }).compressSkipReasoning).toBe(true);
    expect(resolveConfig({ compressSkipReasoning: 'bogus' }).compressSkipReasoning).toBe(true);
  });
});

describe('recallEnabled / semanticRecallEnabled 配置键', () => {
  it('缺省启用（true）；false 禁用；留空回退默认', () => {
    expect(resolveConfig({}).recallEnabled).toBe(true);
    expect(resolveConfig({}).semanticRecallEnabled).toBe(true);
    expect(resolveConfig({ recallEnabled: false }).recallEnabled).toBe(false);
    expect(resolveConfig({ semanticRecallEnabled: false }).semanticRecallEnabled).toBe(false);
    expect(resolveConfig({ recallEnabled: null }).recallEnabled).toBe(true);
    expect(resolveConfig({ semanticRecallEnabled: '' }).semanticRecallEnabled).toBe(true);
  });

  it('非 boolean 值回退默认（启用）', () => {
    expect(resolveConfig({ recallEnabled: 'false' }).recallEnabled).toBe(true);
    expect(resolveConfig({ semanticRecallEnabled: 0 }).semanticRecallEnabled).toBe(true);
  });
});
