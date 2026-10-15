/**
 * 把宿主会话模型目录与命令通道装配成压缩卡片的重压缩能力。
 * 导出 recompressFor。
 */
import type { Context } from '@deepseek-ai/cordis';
// Type-only: 宿主远程调用（ctx.remote）的 Context 合并。
import type {} from '@deepseek-ai/dsh-api-remotes/client';
// Type-only: 会话模型目录服务（ctx.modelDirectories）的 Context 合并。
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { RecompressInjected } from './recompress-run.ts';
import { submitRecompress } from './recompress-run.ts';

/** 构造某会话的重压缩能力：目录与 /model 弹窗共用，提交走 command.execute。 */
export function recompressFor(
  ctx: Context,
  directories: NonNullable<Context['modelDirectories']>,
  sessionId: string,
): RecompressInjected {
  const directory = directories.directoryFor(sessionId as SessionId);
  return {
    directory: directory.store,
    load: () => {
      void directory.load();
    },
    run: (compactionId, choice) =>
      submitRecompress(
        async (id, line) => {
          // remote.commands 同样未声明 inject：点击时才经 ctx.get 读取
          const commands = ctx.get('remote.commands');
          if (commands === undefined) throw new Error('remote.commands unavailable');
          return commands.execute(id as SessionId, line, []);
        },
        sessionId,
        compactionId,
        choice,
      ),
  };
}
