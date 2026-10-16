/**
 * /om-compaction-eval 的文本契约：命令名与描述、新会话首条消息、成功文本及其反解。
 * 宿主命令与客户端跳转共用本模块，因此不得引入 Node 专有依赖（客户端 bundle 会内联它）。
 * 导出 EVAL_COMMAND_NAME / EVAL_COMMAND_DESCRIPTION / EvalPromptInput / buildEvalPrompt /
 * evalStartedText / parseEvalSessionId。
 */

/** 命令名（无参数，裸调用即执行）。 */
export const EVAL_COMMAND_NAME = 'om-compaction-eval';

/** 命令描述（斜杠菜单与命令目录展示）。 */
export const EVAL_COMMAND_DESCRIPTION = 'ai分析OM结果';

/** 新会话首条消息的输入。 */
export interface EvalPromptInput {
  /** compaction-eval 文档绝对路径。 */
  readonly docPath: string;
  /** 被分析会话的工作区目录。 */
  readonly cwd: string;
  /** 被分析会话所属工作区 id；宿主无 workspaceRegistry 或会话未归属时缺省。 */
  readonly workspaceId?: string;
  /** 被分析的会话 id。 */
  readonly sessionId: string;
}

/** 新会话首条消息：只给文档路径与会话标识，评估步骤全部由文档决定。 */
export function buildEvalPrompt(input: EvalPromptInput): string {
  const workspace =
    input.workspaceId === undefined ? input.cwd : `${input.cwd}（${input.workspaceId}）`;
  return `按照 ${input.docPath} 分析 ${workspace}/${input.sessionId}`;
}

/** 成功文本前缀；客户端按同一格式反解新会话 id 用于跳转。 */
const STARTED_PREFIX = '已启动 OM 结果分析会话 ';

/** 命令成功文本。 */
export function evalStartedText(sessionId: string): string {
  return `${STARTED_PREFIX}${sessionId}`;
}

/** 从命令成功文本反解新会话 id；格式不符或 id 为空时返回 undefined。 */
export function parseEvalSessionId(text: string): string | undefined {
  if (!text.startsWith(STARTED_PREFIX)) return undefined;
  const id = text.slice(STARTED_PREFIX.length).trim();
  return id.length > 0 ? id : undefined;
}
