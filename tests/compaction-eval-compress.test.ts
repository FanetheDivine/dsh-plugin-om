// compaction-eval compress.ts 单元测试：目标解析、profile 中 pi-ai providers 与插件配置的读取、
// 凭据解析顺序，以及经真实 LlmRuntime / SessionStore / jsonl 落盘跑一次压缩，
// 产出的日志可被 prepare.ts 解析为重压缩变体。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type GenerateOptions,
  LlmAdapter,
  type LlmResolvedModelInfo,
  type ReasoningEffortId,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import { afterEach, describe, expect, it } from 'vitest';

import {
  compressView,
  createRuntime,
  describeOutcome,
  loadProfile,
  parseTarget,
  resolveSecret,
} from '../.agents/skills/compaction-eval/scripts/compress.ts';
import { loadVariants, parseLog } from '../.agents/skills/compaction-eval/scripts/prepare.ts';
import { buildViewFile } from '../.agents/skills/compaction-eval/scripts/view.ts';
import { resolveConfig } from '../src/config.ts';
import { hostLog, type RoundScript, roundChunks, twoCallFlow } from './helpers.ts';

/** 测试创建的临时目录，afterEach 统一删除。 */
const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'om-compress-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parseTarget', () => {
  it('按首个 / 切渠道，末尾 : 后为思考等级', () => {
    expect(parseTarget('p/vendor/big:max')).toEqual({
      provider: 'p',
      model: 'vendor/big',
      reasoningEffort: 'max',
    });
    expect(parseTarget('p/m')).toEqual({ provider: 'p', model: 'm' });
  });

  it('缺渠道或模型时报错', () => {
    expect(() => parseTarget('model-only')).toThrow('provider/model');
    expect(() => parseTarget('p/')).toThrow('缺少模型');
  });
});

describe('loadProfile', () => {
  /** 在临时 DSH 主目录写一个 profile。 */
  function profileHome(yaml: string): string {
    const home = tempDir();
    mkdirSync(join(home, 'profiles', 'p'), { recursive: true });
    writeFileSync(join(home, 'profiles', 'p', 'cordis.patch.yml'), yaml);
    return home;
  }

  it('取启用的 pi-ai providers 与 insert 中的插件配置，后者覆盖前者', () => {
    const home = profileHome(
      [
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      old: { api: openai-completions, apiKeyEnv: OLD_KEY }',
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      relay: { api: openai-completions, apiKeyEnv: RELAY_KEY }',
        '- id: llm-pi-ai',
        '  disabled: true',
        '  config: { providers: { off: {} } }',
        '- insert:',
        '    - id: dsh-plugin-om-dev',
        '      name: file:///d/dsh-plugin-om/lib/index.js',
        '      config: { compressMaxTokens: 1234, compressSkipReasoning: false }',
      ].join('\n'),
    );
    const profile = loadProfile('p', home);
    expect(Object.keys(profile.providers)).toEqual(['relay']);
    expect(profile.providers.relay?.apiKeyEnv).toBe('RELAY_KEY');
    const config = resolveConfig(profile.plugin);
    expect(config.compressMaxTokens).toBe(1234);
    expect(config.compressSkipReasoning).toBe(false);
  });

  it('没有 pi-ai providers 时报错', () => {
    const home = profileHome('- id: dsh-plugin-om\n  config: {}\n');
    expect(() => loadProfile('p', home)).toThrow('providers');
  });
});

describe('resolveSecret', () => {
  const REF = 'OM_COMPRESS_TEST_SECRET';
  afterEach(() => {
    delete process.env[REF];
  });

  it('依次取环境变量、credentials.yaml、cwd/.env、DSH 主目录/.env', () => {
    const home = tempDir();
    const cwd = tempDir();
    expect(resolveSecret(REF, home, cwd)).toBeUndefined();
    writeFileSync(join(home, '.env'), `${REF}=from-home\n`);
    expect(resolveSecret(REF, home, cwd)).toBe('from-home');
    writeFileSync(join(cwd, '.env'), `export ${REF}="from-cwd"\n`);
    expect(resolveSecret(REF, home, cwd)).toBe('from-cwd');
    writeFileSync(join(home, '.credentials.yaml'), `version: 1\nrefs:\n  ${REF}: from-store\n`);
    expect(resolveSecret(REF, home, cwd)).toBe('from-store');
    process.env[REF] = 'from-env';
    expect(resolveSecret(REF, home, cwd)).toBe('from-env');
  });
});

/** 桩模型：按轮次回放观察压缩脚本，并记录请求。 */
class ScriptedAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = [];
  private readonly scripts: RoundScript[] = [
    { calls: [{ id: 'g', name: 'getHistory' }] },
    { calls: [{ id: 'c', name: 'compressHistory', args: { index: 1, content: '助手摘要' } }] },
    { calls: [{ id: 'done', name: 'completeCompression' }] },
  ];

  /** 声明支持 high 思考等级，供运行时校验请求的 reasoningEffort。 */
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const info = await super.resolveModel(provider, model);
    return { ...info, reasoning: { efforts: [{ id: 'high' as ReasoningEffortId, name: 'high' }] } };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const script = this.scripts[Math.min(this.calls.length, this.scripts.length - 1)];
    this.calls.push(options);
    for (const chunk of roundChunks(script as RoundScript)) yield chunk as StreamChunk;
  }
}

describe('compressView', () => {
  it('对区间视图跑压缩，落盘的日志可被 prepare.ts 解析为重压缩变体', async () => {
    const out = tempDir();
    const file = buildViewFile(hostLog(twoCallFlow()), { range: [0, 5] });
    const ctx = await createRuntime(out);
    const adapter = new ScriptedAdapter();
    ctx.llm.registerAdapter(['stub'], adapter);
    const target = parseTarget('stub/m:high');
    const outcome = await compressView(ctx, file, target, resolveConfig({ rateLimitWaitMs: 0 }));

    expect(outcome.ok ? '' : outcome.error).toBe('');
    expect(adapter.calls.map((c) => [c.provider, c.model, c.reasoningEffort])).toEqual([
      ['stub', 'm', 'high'],
      ['stub', 'm', 'high'],
      ['stub', 'm', 'high'],
    ]);
    expect(describeOutcome(file, 'stub/m:high', outcome)).toMatch(
      /^成功 observe \[0\.\.5\] stub\/m:high 轮数 3 .* om-compaction-log-/,
    );

    const [events, ...rest] = loadVariants(out);
    expect(rest).toEqual([]);
    expect(events?.[0]?.id).toBe(outcome.recordSessionId);
    const log = parseLog(events ?? []);
    expect(log).toMatchObject({
      parent: 'session-view-test',
      phase: 'observe',
      range: [0, 5],
      failed: false,
      model: 'stub/m',
      effort: 'high',
      recompress: true,
    });
    expect(outcome.ok && log.product).toBe(outcome.ok ? outcome.text : false);
    expect(log.product).toContain('助手摘要');
  });
});

describe('loadVariants', () => {
  it('目录中没有压缩日志时报错', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'other'));
    expect(() => loadVariants(dir)).toThrow('目录中没有压缩日志');
  });
});
