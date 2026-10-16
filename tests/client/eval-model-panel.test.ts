// /om-compaction-eval 模型面板单测：目录转选项、选项反查模型、命令行拼装与提交跳转。
// 回归保障：无法在命令行表达的 provider/model 不得进入面板；
// 成功才跳转，失败必须把原因抛给面板展示且不跳转。

import { describe, expect, it, vi } from 'vitest';
import {
  type EvalModelState,
  evalModelChoice,
  evalModelLine,
  evalModelOptions,
  runEvalModel,
} from '../../src/client/eval-model-panel.ts';

const loadError = (message: string) => `加载失败：${message}`;

const state: EvalModelState = {
  groups: [
    {
      id: 'openai',
      name: 'OpenAI',
      models: [
        { id: 'gpt-5', name: 'GPT-5' },
        { id: 'gpt-5-mini', name: 'GPT-5 mini' },
      ],
    },
    { id: 'openrouter', name: 'OpenRouter', models: [{ id: 'anthropic/claude', name: 'Claude' }] },
  ],
  failures: [{ id: 'broken', name: 'Broken', message: 'timeout' }],
};

describe('evalModelOptions', () => {
  it('按供应商分组每个模型一行，失败供应商只展示原因', () => {
    const options = evalModelOptions(state, loadError);
    expect(options.map((option) => [option.label, option.group?.label])).toEqual([
      ['GPT-5', 'OpenAI'],
      ['GPT-5 mini', 'OpenAI'],
      ['Claude', 'OpenRouter'],
      ['Broken', undefined],
    ]);
    expect(options[3]?.detail).toBe('加载失败：timeout');
    expect(options.every((option) => option.active === undefined)).toBe(true);
  });

  it('命令行无法表达的 provider 或 model 不进入面板', () => {
    const options = evalModelOptions(
      {
        groups: [
          { id: 'a/b', name: 'Slashed provider', models: [{ id: 'm', name: 'M' }] },
          {
            id: 'ok',
            name: 'OK',
            models: [
              { id: 'has space', name: 'S' },
              { id: 'fine', name: 'F' },
            ],
          },
          { id: 'has space', name: 'Spaced provider', models: [{ id: 'm', name: 'M' }] },
        ],
        failures: [],
      },
      loadError,
    );
    expect(options.map((option) => option.label)).toEqual(['F']);
  });

  it('没有任何模型时返回空列表', () => {
    expect(evalModelOptions({ groups: [], failures: [] }, loadError)).toEqual([]);
  });
});

describe('evalModelChoice', () => {
  it('选项 id 反查回 provider 与 model，model 含斜杠保持完整', () => {
    const options = evalModelOptions(state, loadError);
    const claude = options.find((option) => option.label === 'Claude');
    expect(evalModelChoice(state, claude?.id ?? '')).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude',
    });
  });

  it('失败行与过期 id 返回 undefined', () => {
    const options = evalModelOptions(state, loadError);
    const failure = options.find((option) => option.label === 'Broken');
    expect(evalModelChoice(state, failure?.id ?? '')).toBeUndefined();
    expect(evalModelChoice(state, 'openai/removed')).toBeUndefined();
  });
});

describe('evalModelLine', () => {
  it('拼出不带思考等级的命令行', () => {
    expect(evalModelLine({ provider: 'openai', model: 'gpt-5' })).toBe(
      '/om-compaction-eval openai/gpt-5',
    );
    expect(evalModelLine({ provider: 'openrouter', model: 'anthropic/claude' })).toBe(
      '/om-compaction-eval openrouter/anthropic/claude',
    );
  });
});

describe('runEvalModel', () => {
  const choice = { provider: 'openai', model: 'gpt-5' };

  it('成功后经命令通道提交并跳转到新会话', async () => {
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      value: { result: { kind: 'success', text: '已启动 OM 结果分析会话 session-new' } },
    });
    const openSession = vi.fn();
    await runEvalModel({ execute, openSession }, 's-1', choice);
    expect(execute).toHaveBeenCalledExactlyOnceWith('s-1', '/om-compaction-eval openai/gpt-5');
    expect(openSession).toHaveBeenCalledExactlyOnceWith('session-new');
  });

  it('命令返回错误时抛出原因且不跳转', async () => {
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      value: { result: { kind: 'error', text: '仅支持主会话' } },
    });
    const openSession = vi.fn();
    await expect(runEvalModel({ execute, openSession }, 's-1', choice)).rejects.toThrow(
      '仅支持主会话',
    );
    expect(openSession).not.toHaveBeenCalled();
  });

  it('远程拒绝时抛出原因且不跳转', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: false, error: { message: '会话被占用' } });
    const openSession = vi.fn();
    await expect(runEvalModel({ execute, openSession }, 's-1', choice)).rejects.toThrow(
      '会话被占用',
    );
    expect(openSession).not.toHaveBeenCalled();
  });

  it('成功但文本无法反解会话 id 时不跳转', async () => {
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      value: { result: { kind: 'success', text: '其他文本' } },
    });
    const openSession = vi.fn();
    await runEvalModel({ execute, openSession }, 's-1', choice);
    expect(openSession).not.toHaveBeenCalled();
  });
});
