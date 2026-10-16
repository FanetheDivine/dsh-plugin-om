/**
 * 读取 DSH profile：cordis.patch.yml 中的 pi-ai 渠道配置与 dsh-plugin-om 插件配置。
 * compress 与 view 共用；不含命令行入口。
 * 导出 dshHome / loadProfile 与 Profile / ProviderProfile 类型。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type * as piAi from '@deepseek-ai/dsh-llm-pi-ai';
import { parse } from 'yaml';

/** pi-ai 渠道配置，原样取自 profile。 */
export type ProviderProfile = piAi.PiAiProviderProfile;

/** profile 中与压缩相关的配置。 */
export interface Profile {
  providers: Record<string, ProviderProfile>;
  /** dsh-plugin-om 条目的原始配置；缺省为空对象。 */
  plugin: Record<string, PatchValue>;
}

/** cordis.patch.yml 的 YAML 值。 */
type PatchValue = string | number | boolean | null | PatchValue[] | { [key: string]: PatchValue };

/** cordis.patch.yml 的一行：按 id 覆盖配置，或 insert 新插件。 */
interface PatchEntry {
  id?: string;
  name?: string;
  disabled?: boolean;
  config?: Record<string, PatchValue>;
  insert?: PatchEntry[];
}

/** DSH 主目录。 */
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

/** 展开 insert 行，得到全部插件条目。 */
function flattenEntries(entries: PatchEntry[]): PatchEntry[] {
  return entries.flatMap((e) => (e.insert ? flattenEntries(e.insert) : [e]));
}

/** 是否为 dsh-plugin-om 条目，含本地开发 insert。 */
function isPluginEntry(e: PatchEntry): boolean {
  return (e.id ?? '').startsWith('dsh-plugin-om') || (e.name ?? '').includes('dsh-plugin-om');
}

/** 读 profile 的 pi-ai providers 与插件配置。profile 默认取 $DSH_PROFILE 或 web。 */
export function loadProfile(profile = process.env.DSH_PROFILE ?? 'web', home = dshHome()): Profile {
  const file = join(home, 'profiles', profile, 'cordis.patch.yml');
  const doc = parse(readFileSync(file, 'utf8'), { logLevel: 'error' }) as PatchEntry[] | null;
  const entries = flattenEntries(doc ?? []).filter((e) => e.disabled !== true);
  const llm = entries.findLast(
    (e) => e.id === 'llm-pi-ai' || e.name === '@deepseek-ai/dsh-llm-pi-ai',
  );
  const providers = llm?.config?.providers as Record<string, ProviderProfile> | undefined;
  if (!providers) throw new Error(`${file} 没有 llm-pi-ai 的 providers 配置`);
  return { providers, plugin: entries.findLast(isPluginEntry)?.config ?? {} };
}
