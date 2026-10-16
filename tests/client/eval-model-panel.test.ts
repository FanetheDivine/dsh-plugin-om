// /om-compaction-eval 模型面板单测：目录整理、默认思考等级、命令行拼装与提交跳转。
// 回归保障：无法在命令行表达的 provider/model 不得进入面板；
// 成功才跳转，失败必须把原因抛给面板展示且不跳转。

import { describe, expect, it, vi } from 'vitest';
import {
  defaultEvalEffort,
  type EvalModelState,
  evalModelGroups,
  evalModelLine,
  runEvalModel,
} from '../../src/client/eval-model-panel.ts';

const state: EvalModelState = {
  groups: [
    {
      id: 'openai',
      name: 'OpenAI',
      models: [
        {
          id: 'gpt-5',
          name: 'GPT-5',
          reasoning: {
            efforts: [
              { id: 'low', name: 'Low' },
              { id: 'max', name: 'Max' },
            ],
          },
        },
        { id: 'gpt-4', name: 'GPT-4' },
      ],
    },
    { id: 'openrouter', name: 'OpenRouter', models: [{ id: 'anthropic/claude', name: 'Claude' }] },
  ],
  failures: [],
};

describe('evalModelGroups', () => {
  it('保留供应商分组与模型顺序，model 含斜杠保持完整', () => {
    const groups = evalModelGroups(state);
    expect(groups.map((group) => [group.id, group.models.map((model) => model.id)])).toEqual([
      ['openai', ['gpt-5', 'gpt-4']],
      ['openrouter', ['anthropic/claude']],
    ]);
  });

  it('命令行无法表达的 provider 或 model 不进入面板，空分组不保留', () => {
    const groups = evalModelGroups({
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
        { id: 'empty', name: 'Empty', models: [] },
      ],
      failures: [],
    });
    expect(groups.map((group) => [group.id, group.models.map((model) => model.id)])).toEqual([
      ['ok', ['fine']],
    ]);
  });

  it('丢弃含空白的思考等级，其余保留', () => {
    const [group] = evalModelGroups({
      groups: [
        {
          id: 'p',
          name: 'P',
          models: [
            {
              id: 'm',
              name: 'M',
              reasoning: {
                efforts: [
                  { id: 'bad one', name: 'Bad' },
                  { id: 'high', name: 'High' },
                ],
              },
            },
          ],
        },
      ],
      failures: [],
    });
    expect(group?.models[0]?.reasoning?.efforts.map((effort) => effort.id)).toEqual(['high']);
  });
});

describe('defaultEvalEffort', () => {
  it('模型支持 max 时默认 max', () => {
    const [group] = evalModelGroups(state);
    expect(defaultEvalEffort(group?.models[0] ?? { id: '', name: '' })).toBe('max');
  });

  it('模型没有 max 或没有思考等级时用模型默认', () => {
    expect(
      defaultEvalEffort({
        id: 'm',
        name: 'M',
        reasoning: { efforts: [{ id: 'high', name: 'High' }] },
      }),
    ).toBeUndefined();
    expect(defaultEvalEffort({ id: 'm', name: 'M' })).toBeUndefined();
  });
});

describe('evalModelLine', () => {
  it('不带等级时只有 provider/model', () => {
    expect(evalModelLine({ provider: 'openai', model: 'gpt-5' })).toBe(
      '/om-compaction-eval openai/gpt-5',
    );
    expect(evalModelLine({ provider: 'openrouter', model: 'anthropic/claude' })).toBe(
      '/om-compaction-eval openrouter/anthropic/claude',
    );
  });

  it('带等级时追加在末尾', () => {
    expect(evalModelLine({ provider: 'openai', model: 'gpt-5', reasoningEffort: 'max' })).toBe(
      '/om-compaction-eval openai/gpt-5 max',
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
