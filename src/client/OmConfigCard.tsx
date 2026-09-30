/** WebUI 行配置页：双语说明及真实可编辑的整数、字符串、布尔控件。 */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
import { Checkbox, SettingsForm, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { NS } from './locales.ts';
import { OM_CONFIG_FIELDS, type OmConfigCardFace } from './om-config-controller.ts';

/** 插件管理器注入的配置页 props。 */
export type OmConfigCardProps = PropsRuntime<'plugins.row.config'> &
  PropsLocale<typeof NS> &
  InjectFace<OmConfigCardFace>;

/** 配置行内容：说明、草稿值及继承/覆盖标记。 */
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
        return (
          <div key={name} data-om-field={name}>
            {kind === 'boolean' ? (
              <>
                <Checkbox
                  label={label}
                  checked={field.text === 'true'}
                  disabled={disabled}
                  onChange={(value) => props.edit(name, String(value))}
                />
                <p>{hint}</p>
                <span>{field.overridden ? t('config.overridden') : t('config.inherited')}</span>
                {field.overridden ? (
                  <button type="button" disabled={disabled} onClick={() => props.resetField(name)}>
                    {t('config.reset')}
                  </button>
                ) : null}
              </>
            ) : (
              <>
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
                {!field.overridden ? <span>{t('config.inherited')}</span> : null}
              </>
            )}
          </div>
        );
      })}
    </SettingsForm>
  );
}
