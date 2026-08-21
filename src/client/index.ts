/**
 * dsh-plugin-om 浏览器客户端贡献：压缩卡片。
 *
 * 服务端压缩替换消息继续使用插件自身的检查点标记（source.plugin =
 * 'dsh-plugin-om'）；宿主 conversation UI 只识别内置的 'compact' 标记，因此本
 * bundle 自行注册一条 conversation 业务定义 + keyed 渲染器，认领插件的压缩
 * 生命周期事件与替换检查点，在消息列表渲染「已压缩」卡片。
 */
import type { Context } from '@deepseek-ai/cordis';
// Type-only: 拉取 locale 插件的 Context 合并（ctx.locale）。
import type {} from '@deepseek-ai/dsh-client-locale/client';
// Type-only: 拉取 runtime 的 Context 合并（ctx.conversationEvents）。
import type {} from '@deepseek-ai/dsh-client-runtime/client';
// Type-only: 'conversation.chat.node' 的 SlotMap 行与 ChatNodeDataMap 声明合并
// （均由 ui-conversation 声明），注册调用才得以类型化。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import { omCompactionDefinition } from './definition.ts';
import { en, NS, zh } from './locales.ts';
import { OmCompactionCard } from './OmCompactionCard.tsx';

/** Required services: 聊天节点槽、会话事件注册表与 locale 服务。 */
export const inject = ['slots', 'conversationEvents', 'locale'];

/**
 * Client plugin body: 注册压缩卡片的业务定义与 keyed 渲染器。
 * 注册挂在 effect 包装器上，插件卸载时随之移除。
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.locale.register(NS, { zh, en }),
    'dsh-plugin-om: compaction card dictionaries',
  );
  ctx.effect(
    () => ctx.conversationEvents.register(omCompactionDefinition),
    'dsh-plugin-om: compaction definition',
  );
  ctx.slots.inject('conversation.chat.node', () =>
    ctx.slots.register(
      { name: 'conversation.chat.node', key: 'om-compaction', locale: NS },
      OmCompactionCard,
    ),
  );
}
