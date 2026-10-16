/**
 * 给宿主命令 /om-compaction-eval 挂模型面板：裸调用时弹出与 /model 同源的模型目录，
 * 选中后提交 `/om-compaction-eval <provider>/<model>` 并跳转到新会话。
 * 带参数的调用不受影响，仍由宿主直接执行。
 * 导出 registerEvalModelPanel。
 */
import type { Context } from '@deepseek-ai/cordis';
// Type-only: 宿主远程调用（ctx.remote）的 Context 合并。
import type {} from '@deepseek-ai/dsh-api-remotes/client';
// Type-only: 命令 UI 服务（ctx.commandUi）的 Context 合并。
import type {} from '@deepseek-ai/dsh-client-ui-commands/client';
// Type-only: 会话模型目录服务（ctx.modelDirectories）的 Context 合并。
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import { EVAL_COMMAND_NAME } from '../eval-session-text.ts';
import { evalModelChoice, evalModelOptions, runEvalModel } from './eval-model-panel.ts';
import { NS } from './locales.ts';

/** 在 commandUi 与 modelDirectories 都就绪后注册装饰；任一服务缺失则不挂载。 */
export function registerEvalModelPanel(ctx: Context): void {
  const t = ctx.locale.bind(NS);
  ctx.inject(['commandUi', 'modelDirectories'], (scope) => {
    const directories = scope.modelDirectories;
    scope.effect(
      () =>
        scope.commandUi.decorate({
          name: EVAL_COMMAND_NAME,
          // 非主会话由命令本身拒绝，原因显示在面板里
          available: () => true,
          ui: {
            kind: 'popupSelect',
            searchMode: 'fuzzy-label',
            searchLabels: () => ({
              placeholder: t('eval.search'),
              empty: t('eval.empty'),
              noResults: t('eval.noResults'),
            }),
            options: async (session) =>
              evalModelOptions(
                await directories.directoryFor(session.sessionId).load(),
                (message) => t('eval.loadError', { message }),
              ),
            onSelect: async (option, session) => {
              const state = directories.directoryFor(session.sessionId).store.getSnapshot();
              const choice = evalModelChoice(state, option.id);
              if (choice === undefined) throw new Error(t('eval.empty'));
              await runEvalModel(
                {
                  execute: async (id, line) => {
                    // remote.commands 是未声明 inject 的可选服务，点击时才经 ctx.get 读取
                    const commands = ctx.get('remote.commands');
                    if (commands === undefined) throw new Error('remote.commands unavailable');
                    return commands.execute(id as SessionId, line, []);
                  },
                  openSession: (id) => {
                    ctx.uiWorkspace.openSession(id as SessionId);
                  },
                },
                session.sessionId,
                choice,
              );
            },
          },
        }),
      'dsh-plugin-om: /om-compaction-eval model panel',
    );
  });
}
