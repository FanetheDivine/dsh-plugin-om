/**
 * 读取压缩评估的会话来源：本地 ~/.dsh/sessions、DSH 导出的会话日志 zip 与重压缩日志目录，
 * 并由日志重建宿主 Session。prepare 与 view 共用；不含命令行入口。
 * 导出 Content / Usage / EventData / SessionEvent / SessionBundle 类型与
 * loadLog / readZip / loadVariants / loadBundle / toSession。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  type SessionEvent as HostEvent,
  Session,
  type SessionHeader,
  SessionId,
} from '@deepseek-ai/dsh-session';
import { unzipSync } from 'fflate';
import { decompress } from 'fzstd';
import { bareId } from './paths.ts';

/** 消息内容片段。 */
export interface Content {
  type: string;
  text?: string;
}

/** token 用量：inputTokens 为未命中缓存的输入，与缓存读、缓存写互斥。 */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** 会话事件 data 中用到的字段。 */
export interface EventData {
  label?: string;
  content?: Content[];
  message?: { content: Content[]; toolCallId?: string; isError?: boolean };
  /** user/message 的来源标记：kind 为 user 是真实用户消息，skill-invocation 带 name 是手动加载的 skill。 */
  source?: { kind?: string; name?: string };
  usage?: Usage;
  callId?: string;
  name?: string;
  arguments?: string;
}

/** 会话日志一行：首行为会话头，其余为事件。 */
export interface SessionEvent {
  type: string;
  time?: number;
  id?: string;
  parentSession?: string;
  createdAt?: number;
  cwd?: string;
  data?: EventData;
}

/** 主会话及其候选压缩日志的原始事件。 */
export interface SessionBundle {
  main: SessionEvent[];
  logs: SessionEvent[][];
}

/** 会话根目录。 */
const SESSIONS = join(homedir(), '.dsh', 'sessions');

/** 导出 zip 中的根会话日志。 */
const ZIP_MAIN_RE = /^session(\.v\d+)?\.jsonl$/;
/** 导出 zip 中的压缩日志。 */
const ZIP_LOG_RE = /^subagents\/om-compaction-log-[^/]+\/session(\.v\d+)?\.jsonl$/;
/** 变体目录中的压缩日志相对路径：om-compaction-log-<id>/session[.vN].jsonl[.zstd]。 */
const VARIANT_LOG_RE = /(^|\/)om-compaction-log-[^/]+\/session(\.v\d+)?\.jsonl(\.zstd)?$/;

/** 解析 jsonl 文本为事件列表。 */
function parseJsonl(text: string): SessionEvent[] {
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SessionEvent);
}

/** 读取会话日志：多帧 zstd 追加写入或已解压 jsonl。 */
export function loadLog(path: string): SessionEvent[] {
  const raw = readFileSync(path);
  return parseJsonl(
    path.endsWith('.zstd') ? new TextDecoder().decode(decompress(raw)) : raw.toString('utf8'),
  );
}

/** 读取 DSH 导出的会话日志 zip：根日志为主会话，subagents 下的 om-compaction-log-* 为压缩日志。 */
export function readZip(path: string): SessionBundle {
  const files = unzipSync(readFileSync(path), {
    filter: (f) => ZIP_MAIN_RE.test(f.name) || ZIP_LOG_RE.test(f.name),
  });
  const entries = Object.entries(files);
  const decode = (bytes: Uint8Array) => parseJsonl(new TextDecoder().decode(bytes));
  const main = entries.find(([name]) => ZIP_MAIN_RE.test(name));
  if (!main) throw new Error(`zip 中未找到根会话日志：${path}`);
  const logs = entries.filter(([name]) => ZIP_LOG_RE.test(name)).map(([, bytes]) => decode(bytes));
  if (!logs.length) throw new Error(`zip 中没有压缩日志，导出时需包含 subagents：${path}`);
  return { main: decode(main[1]), logs };
}

/** 会话目录下的日志文件。 */
function logFile(sessionDir: string): string {
  const name = readdirSync(sessionDir).find((f) => /^session\..*\.jsonl/.test(f));
  if (!name) throw new Error(`未找到日志文件：${sessionDir}`);
  return join(sessionDir, name);
}

/** 在全部工作区中按 id 前缀定位主会话目录。 */
function findMain(prefix: string): string {
  const p = bareId(prefix);
  const hits = readdirSync(SESSIONS).flatMap((ws) => {
    const dir = join(SESSIONS, ws);
    if (!statSync(dir).isDirectory()) return [];
    return readdirSync(dir)
      .filter((d) => bareId(d).startsWith(p) && !d.startsWith('om-compaction-log'))
      .map((d) => join(dir, d))
      .filter((d) => statSync(d).isDirectory());
  });
  const [hit] = hits;
  if (hits.length !== 1 || !hit)
    throw new Error(`会话前缀 ${prefix} 匹配 ${hits.length} 个目录：${hits.join(', ')}`);
  return hit;
}

/** 读取本地会话：按 id 前缀定位主会话，压缩日志取同一工作区目录。 */
function loadLocal(prefix: string): SessionBundle {
  const mainDir = findMain(prefix);
  const wsDir = dirname(mainDir);
  const logs = readdirSync(wsDir)
    .filter((d) => d.startsWith('om-compaction-log-'))
    .map((d) => loadLog(logFile(join(wsDir, d))));
  return { main: loadLog(logFile(mainDir)), logs };
}

/** 读取目录下全部压缩日志：递归匹配 om-compaction-log-* 会话目录中的日志文件。 */
export function loadVariants(dir: string): SessionEvent[][] {
  const root = resolve(dir);
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((p) =>
    VARIANT_LOG_RE.test(p.replaceAll('\\', '/')),
  );
  if (!files.length) throw new Error(`目录中没有压缩日志：${root}`);
  return files.map((p) => loadLog(join(root, p)));
}

/** 按 --session 前缀或 --zip 路径读取会话，二者恰选其一。 */
export function loadBundle(source: { session?: string; zip?: string }): SessionBundle {
  if (!source.session === !source.zip) throw new Error('需指定 --session 或 --zip 之一');
  return source.zip ? readZip(resolve(source.zip)) : loadLocal(source.session ?? '');
}

/**
 * 由会话日志重建会话；可截到某个 seq（含）为止，得到当时的表层。
 * 日志来自 DSH 落盘的 jsonl，首行为会话头、其后 seq 与下标一致；Session.create 会校验事件与头字段。
 */
export function toSession(events: SessionEvent[], lastSeq?: number): Session {
  const [head, ...body] = events;
  if (!head?.id) throw new Error('日志缺少会话头');
  const { type: _type, ...header } = head;
  const seed = lastSeq === undefined ? body : body.slice(0, lastSeq + 1);
  return Session.create(
    SessionId(head.id),
    seed as unknown as HostEvent[],
    header as unknown as SessionHeader,
  );
}
