/**
 * 浏览器客户端入口：注册压缩卡片、功能降级警告及 WebUI 插件行配置页，
 * 并监听本浏览器的命令执行结果，把 /om-compaction-eval 新建的会话跳转过去。
 * 配置页只在宿主提供 dsh-plugin-om 命名空间时挂载，并随客户端释放订阅。
 */
import type { Context } from '@deepseek-ai/cordis';
// Type-only: 宿主远程调用（ctx.remote）的 Context 合并。
import type {} from '@deepseek-ai/dsh-api-remotes/client';
// Type-only: 拉取 locale 插件的 Context 合并（ctx.locale）。
import type {} from '@deepseek-ai/dsh-client-locale/client';
// Type-only: 拉取 uiConversation 服务与 ChatNodeDataMap 的类型合并。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
// Type-only: 会话模型目录服务（ctx.modelDirectories）的 Context 合并。
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client';
// Type-only: 插件管理器的 keyed 行配置槽契约。
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
// Type-only: 拉取 slots 服务的 Context 合并（ctx.slots）。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
// Type-only: 配置表单服务的 Context 合并。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
// Type-only: 拉取 uiWorkspace 服务（会话跳转）的 Context 合并。
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client';
import { registerCompactionEvalJump } from './compaction-eval-jump.ts';
import { omCompactionDefinition, omWarningDefinition } from './definition.ts';
import { registerEvalModelPanel } from './eval-model-register.tsx';
import { en, NS, zh } from './locales.ts';
import { OmCompactionCard } from './OmCompactionCard.tsx';
import { OmConfigCard } from './OmConfigCard.tsx';
import { OmWarningCard } from './OmWarningCard.tsx';
import { CONFIG_NS, OmConfigController } from './om-config-controller.ts';
import { recompressFor } from './recompress-inject.ts';

/** 必需服务：聊天节点槽、会话定义、双语 locale、宿主配置表单与会话跳转。 */
export const inject = ['slots', 'uiConversation', 'locale', 'configForms', 'uiWorkspace'];

/** 挂载压缩卡片、警告行和可配置的插件行。 */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.locale.register(NS, { zh, en }),
    'dsh-plugin-om: compaction card dictionaries',
  );
  ctx.effect(
    () => ctx.uiConversation.events.register(omCompactionDefinition),
    'dsh-plugin-om: compaction definition',
  );
  ctx.effect(
    () => ctx.uiConversation.events.register(omWarningDefinition),
    'dsh-plugin-om: om warning definition',
  );
  // /om-compaction-eval 由宿主执行；本浏览器监听执行结果后跳转到新会话
  ctx.effect(() => registerCompactionEvalJump(ctx), 'dsh-plugin-om: compaction eval jump');
  // 裸调用 /om-compaction-eval 时弹出模型面板；带参数调用仍由宿主直接执行
  registerEvalModelPanel(ctx);
  ctx.slots.inject('conversation.chat.node', () =>
    ctx.slots.register(
      {
        name: 'conversation.chat.node',
        key: 'om-compaction',
        locale: NS,
        // 「查看」跳转：诊断子会话是父会话的 one-shot 子智能体
        // 换模型重压缩：复用宿主会话模型目录；宿主无该服务时不提供
        // modelDirectories 是未声明 inject 的可选服务，只能经 ctx.get 读取
        inject: (sessionId) => {
          const directories = ctx.get('modelDirectories');
          return {
            openSession: (target: SubagentAddress) => {
              ctx.uiWorkspace.openSession(target);
            },
            ...(directories === undefined
              ? {}
              : { recompress: recompressFor(ctx, directories, sessionId) }),
          };
        },
      },
      OmCompactionCard,
    ),
  );
  ctx.slots.inject('conversation.chat.node', () =>
    ctx.slots.register(
      { name: 'conversation.chat.node', key: 'om-warning', locale: NS },
      OmWarningCard,
    ),
  );
  const card = new OmConfigController(ctx.configForms.get(CONFIG_NS));
  ctx.effect(() => () => card.dispose(), 'dsh-plugin-om: config form subscription');
  ctx.effect(
    () =>
      ctx.configForms.whileServed([CONFIG_NS], () =>
        ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register(
            {
              name: 'plugins.row.config',
              key: 'dsh-plugin-om#dsh-plugin-om',
              locale: NS,
              inject: () => card.inject(),
            },
            OmConfigCard,
          ),
        ),
      ),
    'dsh-plugin-om: row configuration',
  );
}
