/**
 * 对 view.json 跑一次压缩，产出与 DSH 同格式的压缩日志。不改原会话。
 *
 * 用法：node compress.ts <view.json> <provider/model[:effort]> --out <目录>
 * 模型调用走 dsh-llm + dsh-llm-pi-ai；providers 与插件配置由 profile.ts 读 DSH profile。
 * 凭据依次取环境变量、Windows 用户环境变量、$DSH_HOME/.credentials.yaml、<cwd>/.env、$DSH_HOME/.env。
 * 导出 parseTarget / resolveSecret / createRuntime / compressView / describeOutcome。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { type ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import * as piAi from '@deepseek-ai/dsh-llm-pi-ai';
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { parse } from 'yaml';
import {
  buildCompressionTaskText,
  type CompressionOutcome,
  runCompressionLoop,
} from '../../../../src/compress-loop.ts';
import { type PluginConfig, resolveConfig } from '../../../../src/config.ts';
import { dshHome, loadProfile, type ProviderProfile } from './profile.ts';
import type { ViewFile } from './view.ts';

/** 压缩目标：渠道、模型与可选思考等级。 */
export interface Target {
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffortId;
}

/** 解析 provider/model[:effort]。模型 id 可含 /，按首个 / 切分渠道。 */
export function parseTarget(text: string): Target {
  const slash = text.indexOf('/');
  if (slash <= 0) throw new Error(`目标格式应为 provider/model[:effort]：${text}`);
  const provider = text.slice(0, slash);
  const rest = text.slice(slash + 1);
  const colon = rest.lastIndexOf(':');
  const model = colon < 0 ? rest : rest.slice(0, colon);
  const effort = colon < 0 ? '' : rest.slice(colon + 1);
  if (!model) throw new Error(`目标缺少模型：${text}`);
  return effort
    ? { provider, model, reasoningEffort: effort as ReasoningEffortId }
    : { provider, model };
}

/** 解析 KEY=VALUE 形式的 .env 文件。 */
function readDotenv(file: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m?.[1] && m[2] !== undefined) out.set(m[1], m[2].replace(/^(['"])(.*)\1$/, '$2'));
  }
  return out;
}

/** 读 Windows 用户环境变量：DSH 启动时继承它，脚本所在 shell 可能尚未刷新。 */
function readWindowsUserEnv(ref: string): string | undefined {
  if (process.platform !== 'win32') return undefined;
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', ref], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/m.exec(out)?.[1] || undefined;
  } catch {
    return undefined;
  }
}

/** 按 DSH 凭据顺序解析一个引用名；都没有时返回 undefined。 */
export function resolveSecret(
  ref: string,
  home = dshHome(),
  cwd = process.cwd(),
): string | undefined {
  const env = process.env[ref];
  if (env) return env;
  const user = readWindowsUserEnv(ref);
  if (user) return user;
  const credentials = join(home, '.credentials.yaml');
  if (existsSync(credentials)) {
    const doc = parse(readFileSync(credentials, 'utf8')) as {
      refs?: Record<string, string>;
    } | null;
    const stored = doc?.refs?.[ref];
    if (stored) return stored;
  }
  for (const file of [join(cwd, '.env'), join(home, '.env')]) {
    const value = readDotenv(file).get(ref);
    if (value) return value;
  }
  return undefined;
}

/**
 * 起一个最小宿主：LlmRuntime、会话存储与 jsonl 落盘（root 为 out，zstd 与 DSH 一致）。
 * 传入 providers 时挂 pi-ai；测试可不传，改为自行 registerAdapter。
 */
export async function createRuntime(
  out: string,
  providers?: Record<string, ProviderProfile>,
): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(JsonlSessionPersistence, { root: resolve(out), compression: 'zstd' });
  if (providers) await ctx.plugin(piAi, { providers });
  return ctx;
}

/**
 * 对视图跑一次压缩循环。父会话以原会话 id 与 cwd 新建空会话，压缩日志挂在其下；
 * 同一 ctx 只能调用一次。
 */
export async function compressView(
  ctx: Context,
  file: ViewFile,
  target: Target,
  config: Readonly<PluginConfig>,
): Promise<CompressionOutcome> {
  const parent = ctx.sessions.create(SessionId(file.header.id), {
    meta: file.header.cwd === undefined ? {} : { cwd: file.header.cwd },
  });
  const routed = { provider: target.provider, model: target.model };
  return runCompressionLoop(ctx, parent, {
    view: file.view,
    originalChars: file.originalChars,
    phase: file.phase,
    taskText: buildCompressionTaskText(file.phase, file.view.minIndex, file.view.maxIndex),
    target: routed,
    maxTokens: config.compressMaxTokens,
    rateLimitWaitMs: config.rateLimitWaitMs,
    skipReasoning: config.compressSkipReasoning,
    debug: config.debug,
    retryTarget: routed,
    ...(target.reasoningEffort === undefined ? {} : { reasoningEffort: target.reasoningEffort }),
  });
}

/** 一行结果：成败、视图、目标、轮数、字符变化、耗时与日志 id。 */
export function describeOutcome(
  file: ViewFile,
  target: string,
  outcome: CompressionOutcome,
): string {
  const head = `${file.phase} [${file.view.minIndex}..${file.view.maxIndex}] ${target}`;
  const sec = (outcome.stats.durationMs / 1000).toFixed(1);
  const log = outcome.recordSessionId ?? '未落盘';
  if (!outcome.ok) return `失败 ${head} ${sec}s ${log}：${outcome.error}`;
  return `成功 ${head} 轮数 ${outcome.rounds} 字符 ${file.originalChars}→${outcome.text.length} ${sec}s ${log}`;
}

/** 用法行中的脚本名：取实际入口文件名，源码版为 compress.ts，发布版为 compress.mjs。 */
function selfName(): string {
  const entry = process.argv[1];
  return entry === undefined ? 'compress.ts' : basename(entry);
}

/** 命令行入口。 */
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { out: { type: 'string' } },
  });
  const [viewPath, targetText] = positionals;
  if (!viewPath || !targetText || !values.out)
    throw new Error(`用法：${selfName()} <view.json> <provider/model[:effort]> --out <目录>`);
  const file = JSON.parse(readFileSync(resolve(viewPath), 'utf8')) as ViewFile;
  const target = parseTarget(targetText);
  const profile = loadProfile();
  const provider = profile.providers[target.provider];
  if (!provider) throw new Error(`profile 没有渠道 ${target.provider}`);
  const ref = provider.apiKeyEnv;
  if (ref && !process.env[ref]) {
    const secret = resolveSecret(ref);
    if (!secret) throw new Error(`找不到凭据 ${ref}`);
    process.env[ref] = secret;
  }
  const ctx = await createRuntime(values.out, { [target.provider]: provider });
  const outcome = await compressView(ctx, file, target, resolveConfig(profile.plugin));
  console.log(describeOutcome(file, targetText, outcome));
  process.exit(outcome.ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}
