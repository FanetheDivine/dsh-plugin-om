/**
 * 给宿主命令 /om-compaction-eval 挂模型面板：裸调用时弹出两栏面板（左选模型、右选思考等级），
 * 提交 `/om-compaction-eval <provider>/<model> [思考等级]` 并跳转到新会话。
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
import { createRoot } from 'react-dom/client';
import { EVAL_COMMAND_NAME } from '../eval-session-text.ts';
import { runEvalModel } from './eval-model-panel.ts';
import { NS } from './locales.ts';
import { OmEvalModelPanel } from './OmEvalModelPanel.tsx';

/**
 * 在 commandUi 与 modelDirectories 都就绪后注册装饰；任一服务缺失则不挂载。
 * available 由调用方提供，评估组件行停用期间面板不可用。
 */
export function registerEvalModelPanel(ctx: Context, available: () => boolean): void {
  const t = ctx.locale.bind(NS);
  ctx.inject(['commandUi', 'modelDirectories'], (scope) => {
    const directories = scope.modelDirectories;
    // 同一时间只开一个面板；重复触发先关掉旧的
    let closeCurrent: (() => void) | undefined;
    const open = (sessionId: string) => {
      closeCurrent?.();
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      const close = () => {
        if (closeCurrent === close) closeCurrent = undefined;
        root.unmount();
        host.remove();
      };
      closeCurrent = close;
      const directory = directories.directoryFor(sessionId as SessionId);
      root.render(
        <OmEvalModelPanel
          directory={directory.store}
          load={() => void directory.load()}
          t={t}
          onClose={close}
          onSubmit={(choice) =>
            runEvalModel(
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
              sessionId,
              choice,
            )
          }
        />,
      );
    };
    scope.effect(() => {
      const dispose = scope.commandUi.decorate({
        name: EVAL_COMMAND_NAME,
        // 非主会话由命令本身拒绝，原因显示在面板里
        available,
        ui: { kind: 'action', run: (session) => open(session.sessionId) },
      });
      return () => {
        dispose();
        closeCurrent?.();
      };
    }, 'dsh-plugin-om: /om-compaction-eval model panel');
  });
}
