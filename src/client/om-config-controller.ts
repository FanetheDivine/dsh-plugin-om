/** WebUI 行配置表单：严格整数/布尔解析与 14 项草稿的宿主原子提交。 */
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store';
import {
  type SettingsFieldSpec,
  type SettingsFieldState,
  type SettingsFormActions,
  SettingsFormModel,
  type SettingsFormScope,
  type SettingsFormShell,
  settingsTextField,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { PluginConfig } from '../config.ts';

/** 由宿主提供的插件条目配置命名空间。 */
export const CONFIG_NS = 'dsh-plugin-om';

/** 完整表单字段及控件类别。 */
export const OM_CONFIG_FIELDS = [
  { name: 'observeThresholdTokens', kind: 'integer' },
  { name: 'reflectThresholdTokens', kind: 'integer' },
  { name: 'tailMessageCount', kind: 'integer' },
  { name: 'compressMaxTokens', kind: 'integer' },
  { name: 'compressProvider', kind: 'text' },
  { name: 'compressModel', kind: 'text' },
  { name: 'compressReasoningEffort', kind: 'text' },
  { name: 'compressSkipReasoning', kind: 'boolean' },
  { name: 'rateLimitWaitMs', kind: 'integer' },
  { name: 'modelDir', kind: 'text' },
  { name: 'omEnabled', kind: 'boolean' },
  { name: 'recallEnabled', kind: 'boolean' },
  { name: 'semanticRecallEnabled', kind: 'boolean' },
  { name: 'debug', kind: 'boolean' },
] as const satisfies ReadonlyArray<{
  name: keyof PluginConfig;
  kind: 'integer' | 'text' | 'boolean';
}>;

/** 数字草稿只接受十进制整数，空白表示清除覆盖。 */
function integerField(field: string): SettingsFieldSpec {
  return {
    field,
    format: (value) => (typeof value === 'number' ? String(value) : ''),
    parse: (text) => {
      const trimmed = text.trim();
      if (trimmed === '') return { kind: 'clear' };
      if (!/^[+-]?\d+$/.test(trimmed)) return undefined;
      const value = Number(trimmed);
      return Number.isInteger(value) ? { kind: 'set', value } : undefined;
    },
  };
}

/** 布尔草稿只允许 true 和 false，缺省值始终来自宿主快照。 */
function booleanField(field: string): SettingsFieldSpec {
  return {
    field,
    format: (value) => (typeof value === 'boolean' ? String(value) : ''),
    parse: (text) =>
      text === 'true' || text === 'false' ? { kind: 'set', value: text === 'true' } : undefined,
  };
}

/** 将声明的控件类别映射为表单解析规格。 */
const specs: SettingsFieldSpec[] = OM_CONFIG_FIELDS.map(({ name, kind }) =>
  kind === 'integer'
    ? integerField(name)
    : kind === 'boolean'
      ? booleanField(name)
      : settingsTextField(name),
);

/** 一次订阅中投影宿主状态及所有草稿。 */
export interface OmConfigCardState extends SettingsFormShell {
  status: 'loading' | 'ready' | 'unavailable';
  conflict: boolean;
  fields: Record<keyof PluginConfig, SettingsFieldState>;
}

/** 行配置槽注入的表单操作及响应式快照。 */
export interface OmConfigCardFace extends SettingsFormActions {
  hooks: { omConfigCard: SnapshotStore<OmConfigCardState> };
}

/** 在插件客户端生命周期内托管表单订阅。 */
export class OmConfigController {
  private readonly form: SettingsFormModel<Partial<PluginConfig>>;
  private readonly store: SnapshotStore<OmConfigCardState>;
  private conflict = false;

  constructor(private readonly scope: SettingsFormScope<Partial<PluginConfig>>) {
    const guarded: SettingsFormScope<Partial<PluginConfig>> = {
      getSnapshot: () => scope.getSnapshot(),
      subscribe: (listener) => scope.subscribe(listener),
      mutate: async (ops, revision) => {
        this.conflict = false;
        const accepted = await scope.mutate(ops, revision);
        this.conflict =
          !accepted && revision !== undefined && scope.getSnapshot().revision !== revision;
        return accepted;
      },
    };
    this.form = new SettingsFormModel(guarded, specs);
    this.store = this.form.bind(() => this.projection());
  }

  /** 从模型投影唯一一份字段及加载状态。 */
  private projection(): OmConfigCardState {
    return {
      ...this.form.shell(),
      status: this.scope.getSnapshot().status,
      conflict: this.form.shell().failed && this.conflict,
      fields: Object.fromEntries(
        OM_CONFIG_FIELDS.map(({ name }) => [name, this.form.field(name)]),
      ) as OmConfigCardState['fields'],
    };
  }

  /** 供行槽注册器向 React 注入表单操作。 */
  inject(): OmConfigCardFace {
    return { hooks: { omConfigCard: this.store }, ...this.form.actions() };
  }

  /** 释放宿主快照订阅。 */
  dispose(): void {
    this.form.dispose();
  }
}
