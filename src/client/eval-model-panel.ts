/**
 * /om-compaction-eval 的模型面板：裸调用时列出会话模型目录，选一个模型即启动评估。
 * 只选模型，不选思考等级（提交的命令行不带等级，即用该模型默认等级）。
 * 导出 EvalModelState / EvalModelChoice / evalModelOptions / evalModelChoice /
 * evalModelLine / runEvalModel。
 */
import type { SelectOption } from '@deepseek-ai/dsh-client-ui-commands/client';
import { EVAL_COMMAND_NAME } from '../eval-session-text.ts';
import { evalJumpTarget } from './compaction-eval-jump.ts';
import type { CommandExecutor } from './recompress-run.ts';

/** 面板读取的模型目录快照（宿主 ModelDirectoryState 的结构子集）。 */
export interface EvalModelState {
  readonly groups: readonly {
    readonly id: string;
    readonly name: string;
    readonly models: readonly { readonly id: string; readonly name: string }[];
  }[];
  readonly failures: readonly {
    readonly id: string;
    readonly name: string;
    readonly message: string;
  }[];
}

/** 面板选中的模型。 */
export interface EvalModelChoice {
  readonly provider: string;
  readonly model: string;
}

/** 选项 id：仅作不透明键，经目录反查，从不解析。 */
function rowId(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/**
 * 命令行能否表达该 provider/model：provider 与 model 都不能含空白，
 * provider 不能含 '/'（命令按第一个 '/' 切分）。
 */
function expressible(provider: string, model: string): boolean {
  return !/\s/.test(provider) && !provider.includes('/') && !/\s/.test(model);
}

/**
 * 目录转面板选项：按供应商分组，每个模型一行；加载失败的供应商只展示原因，不可选。
 * 命令行无法表达的 provider 或模型不列出。
 */
export function evalModelOptions(
  state: EvalModelState,
  loadError: (message: string) => string,
): SelectOption[] {
  const rows: SelectOption[] = [];
  for (const group of state.groups) {
    for (const model of group.models) {
      if (!expressible(group.id, model.id)) continue;
      rows.push({
        id: rowId(group.id, model.id),
        label: model.name,
        group: { name: group.id, label: group.name },
      });
    }
  }
  for (const failure of state.failures) {
    rows.push({
      id: `failure/${failure.id}`,
      label: failure.name,
      detail: loadError(failure.message),
    });
  }
  return rows;
}

/** 选项 id 反查所选模型；失败行与已不在目录的 id 返回 undefined。 */
export function evalModelChoice(state: EvalModelState, id: string): EvalModelChoice | undefined {
  for (const group of state.groups) {
    for (const model of group.models) {
      if (rowId(group.id, model.id) === id && expressible(group.id, model.id)) {
        return { provider: group.id, model: model.id };
      }
    }
  }
  return undefined;
}

/** 拼出命令行：/om-compaction-eval <provider>/<model>（不带思考等级）。 */
export function evalModelLine(choice: EvalModelChoice): string {
  return `/${EVAL_COMMAND_NAME} ${choice.provider}/${choice.model}`;
}

/** 提交与跳转所需的最小依赖。 */
export interface EvalModelDeps {
  readonly execute: CommandExecutor;
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
