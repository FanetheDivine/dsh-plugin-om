/**
 * /om-compaction-eval 的模型面板逻辑：目录整理、默认思考等级、命令行拼装与提交跳转。
 * 面板左栏选模型、右栏选该模型的思考等级；等级缺省表示模型默认。
 * 导出 EvalModelState / EvalModelChoice / evalModelGroups / defaultEvalEffort /
 * evalModelLine / runEvalModel。
 */
import { EVAL_COMMAND_NAME } from '../eval-session-text.ts';
import { evalJumpTarget } from './compaction-eval-jump.ts';

/** 结果分析命令通道的最小远程面：按会话 id 执行一行命令。 */
type EvalCommandExecutor = (
  sessionId: string,
  line: string,
) => Promise<
  | { ok: true; value: { result: { kind: string; text?: string } } }
  | { ok: false; error: { message: string } }
>;

/** 目录中一个模型的思考等级元数据。 */
export interface EvalModelReasoning {
  readonly efforts: readonly { readonly id: string; readonly name: string }[];
}

/** 面板读取的目录模型。 */
export interface EvalModelEntry {
  readonly id: string;
  readonly name: string;
  readonly reasoning?: EvalModelReasoning | undefined;
}

/** 面板读取的模型目录快照（宿主 ModelDirectoryState 的结构子集）。 */
export interface EvalModelState {
  readonly groups: readonly {
    readonly id: string;
    readonly name: string;
    readonly models: readonly EvalModelEntry[];
  }[];
  readonly failures: readonly {
    readonly id: string;
    readonly name: string;
    readonly message: string;
  }[];
}

/** 面板提交的选择：reasoningEffort 缺省表示用模型默认等级。 */
export interface EvalModelChoice {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

/** 面板里的一个供应商分组（只含命令行能表达的模型）。 */
export interface EvalModelGroup {
  readonly id: string;
  readonly name: string;
  readonly models: readonly EvalModelEntry[];
}

/**
 * 命令行能否表达该 provider/model：provider 与 model 都不能含空白，
 * provider 不能含 '/'（命令按第一个 '/' 切分）。
 */
function expressible(provider: string, model: string): boolean {
  return !/\s/.test(provider) && !provider.includes('/') && !/\s/.test(model);
}

/** 目录转面板分组：命令行无法表达的模型不列出，思考等级里含空白的等级丢弃，空分组不保留。 */
export function evalModelGroups(state: EvalModelState): EvalModelGroup[] {
  const groups: EvalModelGroup[] = [];
  for (const group of state.groups) {
    const models = group.models
      .filter((model) => expressible(group.id, model.id))
      .map((model): EvalModelEntry => {
        if (model.reasoning === undefined) return model;
        const efforts = model.reasoning.efforts.filter((effort) => !/\s/.test(effort.id));
        return { ...model, reasoning: { efforts } };
      });
    if (models.length > 0) groups.push({ id: group.id, name: group.name, models });
  }
  return groups;
}

/** 默认思考等级：模型支持 max 就用 max，否则返回 undefined（模型默认）。 */
export function defaultEvalEffort(model: EvalModelEntry): string | undefined {
  return model.reasoning?.efforts.some((effort) => effort.id === 'max') === true
    ? 'max'
    : undefined;
}

/** 拼出命令行：/om-compaction-eval <provider>/<model> [思考等级]。 */
export function evalModelLine(choice: EvalModelChoice): string {
  const effort = choice.reasoningEffort === undefined ? '' : ` ${choice.reasoningEffort}`;
  return `/${EVAL_COMMAND_NAME} ${choice.provider}/${choice.model}${effort}`;
}

/** 提交与跳转所需的最小依赖。 */
export interface EvalModelDeps {
  readonly execute: EvalCommandExecutor;
  readonly openSession: (sessionId: string) => void;
}

/**
 * 经命令通道启动评估并跳转到新会话。
 * 面板路径不会发布 command/executed，所以在此直接按成功文本跳转；
 * 远程拒绝或命令返回错误时抛出原因交给面板展示，不跳转。
 */
export async function runEvalModel(
  deps: EvalModelDeps,
  sessionId: string,
  choice: EvalModelChoice,
): Promise<void> {
  const result = await deps.execute(sessionId, evalModelLine(choice));
  if (!result.ok) throw new Error(result.error.message);
  const { kind, text } = result.value.result;
  if (kind !== 'success') throw new Error(text ?? '');
  const target = evalJumpTarget(EVAL_COMMAND_NAME, { kind: 'success', text: text ?? '' });
  if (target !== undefined) deps.openSession(target);
}
