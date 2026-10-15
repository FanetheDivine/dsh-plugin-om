/**
 * 换模型重压缩的客户端提交：把压缩 id 与所选模型拼成 /om-recompress 命令行，
 * 经宿主命令通道发往会话并归一化结果。
 * 导出 RecompressChoice / RecompressOutcome / RecompressInjected / recompressLine /
 * submitRecompress。
 */

/** 模型选择结果（provider/model 与可选思考等级，缺省表示模型默认）。 */
export interface RecompressChoice {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

/** 目录中一个模型：id、显示名与可选的思考等级元数据。 */
export interface DirectoryModel {
  readonly id: string;
  readonly name: string;
  readonly reasoning?: {
    readonly efforts: readonly { readonly id: string; readonly name: string }[];
    readonly defaultEffort?: string | undefined;
  };
}

/** 目录中一个供应商分组。 */
export interface DirectoryGroup {
  readonly id: string;
  readonly name: string;
  readonly models: readonly DirectoryModel[];
}

/** 模型目录快照中菜单读取的字段（宿主 ModelDirectoryState 的结构子集）。 */
export interface DirectoryState {
  readonly groups: readonly DirectoryGroup[];
  readonly status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error';
  readonly error: string | null;
}

/** 提交结果：ok 表示重压缩成功；text 为命令返回的说明或失败原因。 */
export interface RecompressOutcome {
  readonly ok: boolean;
  readonly text: string;
}

/** 命令通道的最小远程面：按会话 id 执行一行命令。 */
export type CommandExecutor = (
  sessionId: string,
  line: string,
) => Promise<
  | { ok: true; value: { result: { kind: string; text?: string } } }
  | { ok: false; error: { message: string } }
>;

/** 注入压缩卡片的重压缩能力：模型目录（只读）与提交动作。 */
export interface RecompressInjected {
  /** 会话共享的模型目录（与 /model 弹窗同一份数据）。 */
  readonly directory: {
    subscribe(listener: () => void): () => void;
    getSnapshot(): DirectoryState;
  };
  /** 确保模型目录已加载（失败落在目录状态上）。 */
  readonly load: () => void;
  /** 用所选模型重压缩指定压缩。 */
  readonly run: (compactionId: string, choice: RecompressChoice) => Promise<RecompressOutcome>;
}

/** 拼出命令行：/om-recompress <compactionId> <provider> <model> [effort]。 */
export function recompressLine(compactionId: string, choice: RecompressChoice): string {
  const effort = choice.reasoningEffort === undefined ? '' : ` ${choice.reasoningEffort}`;
  return `/om-recompress ${compactionId} ${choice.provider} ${choice.model}${effort}`;
}

/** 经命令通道提交一次重压缩；远程拒绝或抛错都归一为失败结果。 */
export async function submitRecompress(
  execute: CommandExecutor,
  sessionId: string,
  compactionId: string,
  choice: RecompressChoice,
): Promise<RecompressOutcome> {
  try {
    const result = await execute(sessionId, recompressLine(compactionId, choice));
    if (!result.ok) return { ok: false, text: result.error.message };
    const { kind, text } = result.value.result;
    return { ok: kind === 'success', text: text ?? '' };
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) };
  }
}
