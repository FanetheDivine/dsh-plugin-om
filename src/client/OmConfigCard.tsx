/** WebUI 行配置页：双语说明及规范布局的整数、字符串与布尔设置项。 */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
import {
  Checkbox,
  SettingsForm,
  SettingsValueField,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { CSSProperties, ReactNode } from 'react';
import type { NS } from './locales.ts';
import type { OmConfigCardFace } from './om-config-controller.ts';

/** 插件管理器注入的配置页 props。 */
export type OmConfigCardProps = PropsRuntime<'plugins.row.config'> &
  PropsLocale<typeof NS> &
  InjectFace<OmConfigCardFace>;

/** 布尔设置项组件：对齐宿主 settings-form 字段规范，支持覆盖徽章与恢复默认。 */
interface BooleanFieldProps {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly checked: boolean;
  readonly overridden: boolean;
  readonly overriddenLabel: string;
  readonly resetLabel: string;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly onReset: () => void;
}

function BooleanField({
  id,
  label,
  hint,
  checked,
  overridden,
  overriddenLabel,
  resetLabel,
  disabled,
  onChange,
  onReset,
}: BooleanFieldProps): ReactNode {
  return (
    <div style={styles.field}>
      <div style={styles.head}>
        <Checkbox
          className={id}
          label={label}
          checked={checked}
          disabled={disabled}
          onChange={onChange}
        />
        {overridden ? (
          <span style={styles.badges}>
            <Tag tone="outline">{overriddenLabel}</Tag>
            <button type="button" style={styles.resetButton} disabled={disabled} onClick={onReset}>
              {resetLabel}
            </button>
          </span>
        ) : null}
      </div>
      <p style={styles.hint}>{hint}</p>
    </div>
  );
}

/** 控制关联配置可见性的依赖开关草稿值。 */
interface DependencyFlags {
  readonly semanticOn: boolean;
  readonly idleOn: boolean;
}

/** 字段是否显示：模型目录随语义增强，重发阈值随长期无记录重发。 */
function isVisible(name: string, { semanticOn, idleOn }: DependencyFlags): boolean {
  switch (name) {
    case 'modelDir':
      return semanticOn;
    case 'progressReminderIdleSteps':
    case 'progressReminderIdleToolCalls':
      return idleOn;
    default:
      return true;
  }
}

/** 配置行内容：说明、草稿值及规范的继承/覆盖呈现。 */
export function OmConfigCard(props: OmConfigCardProps): string | React.JSX.Element {
  const { t } = props;
  const state = props.useOmConfigCard((snapshot) => snapshot);
  if (props.view === 'summary') return t('config.description');
  if (state.status === 'loading') return <p role="status">{t('config.loading')}</p>;
  // 组件行的字段清单没有依赖开关，缺失字段按关闭处理
  const flags: DependencyFlags = {
    semanticOn: state.fields.semanticRecallEnabled?.text === 'true',
    idleOn: state.fields.progressReminderIdleEnabled?.text === 'true',
  };
  return (
    <SettingsForm
      labels={{
        unavailable: t('config.unavailable'),
        readOnly: t('config.readOnly'),
        saveFailed: state.conflict ? t('config.versionConflict') : t('config.saveFailed'),
        save: t('config.save'),
        saving: t('config.saving'),
      }}
      state={state.writable ? state : { ...state, dirty: false }}
      onSave={props.save}
      onDiscard={props.discard}
    >
      {state.dirty ? (
        <button type="button" disabled={!state.writable || state.saving} onClick={props.discard}>
          {t('config.discard')}
        </button>
      ) : null}
      {props.layout.map(({ name, kind }) => {
        const field = state.fields[name];
        // layout 与投影字段同源，缺字段属于内部错误，直接不渲染该项
        if (field === undefined) return null;
        const label = t(`config.${name}`);
        const hint = t(`config.${name}.hint`);
        const disabled = !state.writable || state.saving;
        // 依赖项关闭时隐藏关联配置，草稿保留并仍随保存提交
        if (!isVisible(name, flags)) return null;
        const checked = field.text === 'true';
        const onChange = (value: boolean) => {
          props.edit(name, String(value));
        };
        const onReset = () => props.resetField(name);
        return (
          <div key={name} data-om-field={name}>
            {kind === 'boolean' ? (
              <BooleanField
                id={`plugin-config-om-${name}`}
                label={label}
                hint={hint}
                checked={checked}
                overridden={field.overridden}
                overriddenLabel={t('config.overridden')}
                resetLabel={t('config.reset')}
                disabled={disabled}
                onChange={onChange}
                onReset={onReset}
              />
            ) : (
              <SettingsValueField
                id={`plugin-config-om-${name}`}
                label={label}
                hint={hint}
                overriddenLabel={t('config.overridden')}
                resetLabel={t('config.reset')}
                invalidLabel={t('config.invalidInteger')}
                numeric={kind === 'integer'}
                disabled={disabled}
                {...field}
                onEdit={(text) => props.edit(name, text)}
                onReset={() => props.resetField(name)}
              />
            )}
          </div>
        );
      })}
    </SettingsForm>
  );
}

const styles: Record<string, CSSProperties> = {
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '12px 0',
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
  },
  badges: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
  },
  resetButton: {
    border: 'none',
    background: 'none',
    padding: 0,
    font: 'inherit',
    fontSize: '12px',
    lineHeight: '1.5',
    color: 'var(--dsw-alias-label-secondary)',
    cursor: 'pointer',
  },
  hint: {
    margin: 0,
    fontSize: '12px',
    lineHeight: '1.5',
    color: 'var(--dsw-alias-label-tertiary)',
  },
};
