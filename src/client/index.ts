/**
 * 浏览器客户端入口：注册压缩卡片、功能降级警告及 WebUI 插件行配置页。
 * 配置页只在宿主提供 dsh-plugin-om 命名空间时挂载，并随客户端释放订阅。
 */
import type { Context } from '@deepseek-ai/cordis';
// Type-only: 拉取 locale 插件的 Context 合并（ctx.locale）。
import type {} from '@deepseek-ai/dsh-client-locale/client';
// Type-only: 拉取 uiConversation 服务与 ChatNodeDataMap 的类型合并。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
// Type-only: 插件管理器的 keyed 行配置槽契约。
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
// Type-only: 拉取 slots 服务的 Context 合并（ctx.slots）。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
// Type-only: 配置表单服务的 Context 合并。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import { omCompactionDefinition, omWarningDefinition } from './definition.ts';
import { en, NS, zh } from './locales.ts';
import { OmCompactionCard } from './OmCompactionCard.tsx';
import { OmConfigCard } from './OmConfigCard.tsx';
import { OmWarningCard } from './OmWarningCard.tsx';
import { CONFIG_NS, OmConfigController } from './om-config-controller.ts';

/** 必需服务：聊天节点槽、会话定义、双语 locale 与宿主配置表单。 */
export const inject = ['slots', 'uiConversation', 'locale', 'configForms'];

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
  ctx.slots.inject('conversation.chat.node', () =>
    ctx.slots.register(
      { name: 'conversation.chat.node', key: 'om-compaction', locale: NS },
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
