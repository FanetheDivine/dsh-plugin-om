/** WebUI 行配置表单：包根与组件行的字段清单、严格整数/布尔解析与草稿的宿主原子提交。 */
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
import type { EvalRowConfig, PluginConfig, RecompressRowConfig } from '../config.ts';

/** 包根行的配置命名空间，由宿主提供。 */
export const CONFIG_NS = 'dsh-plugin-om';

/** 重压缩组件行的配置命名空间，即其 patch 行 id。 */
export const RECOMPRESS_NS = 'dsh-plugin-om-recompress';

/** 评估组件行的配置命名空间，即其 patch 行 id。 */
export const EVAL_NS = 'dsh-plugin-om-compaction-eval';

/** 表单字段及控件类别。 */
export interface RowFieldSpec<N extends string = string> {
  readonly name: N;
  readonly kind: 'integer' | 'text' | 'boolean';
}

/** 包根行字段，顺序即面板顺序：父开关在前，其控制的细节紧随其后。 */
export const OM_CONFIG_FIELDS = [
  { name: 'observeThresholdTokens', kind: 'integer' },
  { name: 'reflectThresholdTokens', kind: 'integer' },
  { name: 'tailMessageCount', kind: 'integer' },
  { name: 'semanticRecallEnabled', kind: 'boolean' },
  { name: 'modelDir', kind: 'text' },
  { name: 'compressProvider', kind: 'text' },
  { name: 'compressModel', kind: 'text' },
  { name: 'compressReasoningEffort', kind: 'text' },
  { name: 'compressMaxTokens', kind: 'integer' },
  { name: 'compressSkipReasoning', kind: 'boolean' },
  { name: 'rateLimitWaitMs', kind: 'integer' },
  { name: 'progressReminderEnabled', kind: 'boolean' },
  { name: 'progressReminderIdleEnabled', kind: 'boolean' },
  { name: 'progressReminderIdleSteps', kind: 'integer' },
  { name: 'progressReminderIdleToolCalls', kind: 'integer' },
  { name: 'debug', kind: 'boolean' },
] as const satisfies ReadonlyArray<RowFieldSpec<keyof PluginConfig>>;

/** 重压缩组件行字段：并发上限与调试日志。 */
export const RECOMPRESS_CONFIG_FIELDS = [
  { name: 'recompressConcurrency', kind: 'integer' },
  { name: 'debug', kind: 'boolean' },
] as const satisfies ReadonlyArray<RowFieldSpec<keyof RecompressRowConfig>>;

/** 评估组件行字段：调试日志。 */
export const EVAL_CONFIG_FIELDS = [
  { name: 'debug', kind: 'boolean' },
] as const satisfies ReadonlyArray<RowFieldSpec<keyof EvalRowConfig>>;

/** 全部行字段的名称联合，供配置卡翻译键在编译期对齐字典。 */
export type RowFieldName =
  | (typeof OM_CONFIG_FIELDS)[number]['name']
  | (typeof RECOMPRESS_CONFIG_FIELDS)[number]['name']
  | (typeof EVAL_CONFIG_FIELDS)[number]['name'];

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

/** 一次订阅中投影宿主状态及所有草稿。 */
export interface OmConfigCardState extends SettingsFormShell {
  status: 'loading' | 'ready' | 'unavailable';
  conflict: boolean;
  fields: Record<string, SettingsFieldState>;
}

/** 各行 summary 视图使用的字典键。 */
export type RowDescriptionKey =
  | 'config.description'
  | 'config.description.recompress'
  | 'config.description.eval';

/** 行配置槽注入的表单操作及响应式快照。 */
export interface OmConfigCardFace extends SettingsFormActions {
  /** 本页渲染的字段及控件类别，顺序即面板顺序。 */
  layout: ReadonlyArray<RowFieldSpec<RowFieldName>>;
  /** summary 视图显示的本页说明字典键。 */
  descriptionKey: RowDescriptionKey;
  hooks: { omConfigCard: SnapshotStore<OmConfigCardState> };
}

/** 配置页的最小契约：注入面与订阅释放。 */
export interface RowConfigPage {
  inject(): OmConfigCardFace;
  dispose(): void;
}

/** 在插件客户端生命周期内托管一行的表单订阅，字段由行字段清单声明。 */
export class OmConfigController<T> implements RowConfigPage {
  private readonly form: SettingsFormModel<Partial<T>>;
  private readonly store: SnapshotStore<OmConfigCardState>;
  private conflict = false;

  constructor(
    private readonly scope: SettingsFormScope<Partial<T>>,
    private readonly layout: ReadonlyArray<RowFieldSpec<Extract<keyof T, RowFieldName>>>,
    private readonly descriptionKey: RowDescriptionKey,
  ) {
    const specs: SettingsFieldSpec[] = layout.map(({ name, kind }) =>
      kind === 'integer'
        ? integerField(name)
        : kind === 'boolean'
          ? booleanField(name)
          : settingsTextField(name),
    );
    const guarded: SettingsFormScope<Partial<T>> = {
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
      fields: Object.fromEntries(this.layout.map(({ name }) => [name, this.form.field(name)])),
    };
  }

  /** 供行槽注册器向 React 注入表单操作。 */
  inject(): OmConfigCardFace {
    return {
      hooks: { omConfigCard: this.store },
      layout: this.layout,
      descriptionKey: this.descriptionKey,
      ...this.form.actions(),
    };
  }

  /** 释放宿主快照订阅。 */
  dispose(): void {
    this.form.dispose();
  }
}
