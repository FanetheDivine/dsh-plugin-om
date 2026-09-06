/**
 * 浏览器客户端入口（exports["./client"] → dist/client.js）：注册压缩卡片与功能降级
 * 警告行的 locale 字典、conversation 业务定义与 keyed 渲染器。宿主 conversation UI 只
 * 识别内置 'compact' 检查点，插件自产的压缩检查点（source.plugin = 'dsh-plugin-om'）
 * 由本 bundle 认领并在消息列表渲染「已压缩」卡片；om 警告信封事件（借用
 * feedback/record）渲染为「功能降级」警告行。
 */
import type { Context } from '@deepseek-ai/cordis';
// Type-only: 拉取 locale 插件的 Context 合并（ctx.locale）。
import type {} from '@deepseek-ai/dsh-client-locale/client';
// Type-only: 拉取 runtime 的 Context 合并（ctx.conversationEvents）。
import type {} from '@deepseek-ai/dsh-client-runtime/client';
// Type-only: 'conversation.chat.node' 的 SlotMap 行与 ChatNodeDataMap 声明合并。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import { omCompactionDefinition, omWarningDefinition } from './definition.ts';
import { en, NS, zh } from './locales.ts';
import { OmCompactionCard } from './OmCompactionCard.tsx';
import { OmWarningCard } from './OmWarningCard.tsx';

/** Required services: 聊天节点槽、会话事件注册表与 locale 服务。 */
export const inject = ['slots', 'conversationEvents', 'locale'];

/** Client plugin body: 注册压缩卡片的业务定义与 keyed 渲染器（随插件卸载移除）。 */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.locale.register(NS, { zh, en }),
    'dsh-plugin-om: compaction card dictionaries',
  );
  ctx.effect(
    () => ctx.conversationEvents.register(omCompactionDefinition),
    'dsh-plugin-om: compaction definition',
  );
  ctx.effect(
    () => ctx.conversationEvents.register(omWarningDefinition),
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
}
