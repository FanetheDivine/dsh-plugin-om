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
import { OM_CONFIG_FIELDS, type OmConfigCardFace } from './om-config-controller.ts';

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

/** 配置行内容：说明、草稿值及规范的继承/覆盖呈现。 */
export function OmConfigCard(props: OmConfigCardProps): string | React.JSX.Element {
  const { t } = props;
  const state = props.useOmConfigCard((snapshot) => snapshot);
  if (props.view === 'summary') return t('config.description');
  if (state.status === 'loading') return <p role="status">{t('config.loading')}</p>;
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
      {OM_CONFIG_FIELDS.map(({ name, kind }) => {
        const field = state.fields[name];
        const label = t(`config.${name}`);
        const hint = t(`config.${name}.hint`);
        const disabled = !state.writable || state.saving;
        const recallOn = state.fields.recallEnabled.text === 'true';
        const semanticOn = state.fields.semanticRecallEnabled.text === 'true';
        const isSemantic = name === 'semanticRecallEnabled';
        // 语义增强依赖原文召回：展示值与服务端生效值一致，编辑与恢复默认时联动两项
        const checked = isSemantic ? semanticOn && recallOn : field.text === 'true';
        const onChange = (value: boolean) => {
          props.edit(name, String(value));
          if (isSemantic && value) props.edit('recallEnabled', 'true');
          if (name === 'recallEnabled' && !value && semanticOn) {
            props.edit('semanticRecallEnabled', 'false');
          }
        };
        const onReset = () => {
          props.resetField(name);
          if (isSemantic && !recallOn) props.resetField('recallEnabled');
        };
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
