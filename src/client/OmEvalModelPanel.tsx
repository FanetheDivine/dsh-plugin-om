/**
 * /om-compaction-eval 的模型面板：左栏按供应商分组选模型（可搜索），右栏选该模型的思考等级。
 * 选模型后右栏默认落在 max（模型不支持则落在「模型默认」）；点「开始分析」才提交，
 * 提交失败的原因显示在面板内；点面板外或按 Esc 关闭。
 * 数据来自会话共享的模型目录（与 /model 同一份）。导出 OmEvalModelPanel。
 */
import { MenuGroup, MenuSurface, rankByName } from '@deepseek-ai/dsh-client-ui-primitives';
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { EvalModelChoice, EvalModelEntry, EvalModelState } from './eval-model-panel.ts';
import { defaultEvalEffort, evalModelGroups } from './eval-model-panel.ts';

/** 面板读取的目录快照：模型分组与失败供应商，加加载状态。 */
export interface EvalDirectoryState extends EvalModelState {
  readonly status: string;
  readonly error: string | null;
}

/** 面板属性：模型目录（只读）、加载动作、文案座，以及提交与关闭回调。 */
export interface OmEvalModelPanelProps {
  readonly directory: {
    subscribe(listener: () => void): () => void;
    getSnapshot(): EvalDirectoryState;
  };
  readonly load: () => void;
  readonly t: TranslateNS<'om-compaction'>;
  /** 提交所选模型与等级；抛出的原因显示在面板内，成功后面板关闭。 */
  readonly onSubmit: (choice: EvalModelChoice) => Promise<void>;
  readonly onClose: () => void;
}

const css = {
  panel: 'om-eval-panel',
  columns: 'om-eval-columns',
  left: 'om-eval-left',
  right: 'om-eval-right',
  search: 'om-eval-search',
  list: 'om-eval-list',
  row: 'om-eval-row',
  mark: 'om-eval-mark',
  section: 'om-eval-section',
  footer: 'om-eval-footer',
  start: 'om-eval-start',
  note: 'om-eval-note',
  error: 'om-eval-error',
} as const;

const panelCss = `
.${css.panel}{position:fixed;z-index:1000;left:50%;top:50%;transform:translate(-50%,-50%);box-sizing:border-box;width:min(560px,calc(100vw - 24px));max-height:min(420px,calc(100vh - 24px));display:flex;flex-direction:column;overflow:hidden}
.${css.columns}{min-height:0;flex:1;display:flex}
.${css.left}{flex:1 1 60%;min-width:0;display:flex;flex-direction:column;border-right:1px solid var(--dsw-alias-label-caption)}
.${css.right}{flex:1 1 40%;min-width:0;overflow-y:auto;padding:4px}
.${css.search}{box-sizing:border-box;width:100%;margin:0;padding:8px 12px;font:inherit;font-size:13px;color:inherit;background:none;border:none;border-bottom:1px solid var(--dsw-alias-label-caption);outline:none}
.${css.list}{min-height:0;overflow-y:auto;padding:4px}
.${css.row}{box-sizing:border-box;width:100%;display:flex;align-items:center;gap:6px;text-align:left;font:inherit;font-size:13px;line-height:20px;color:inherit;background:none;border:none;border-radius:6px;padding:4px 8px;cursor:pointer}
.${css.row}:hover,.${css.row}:focus-visible,.${css.row}[aria-checked=true]{background:var(--dsw-alias-interactive-bg-hover-solid);outline:none}
.${css.row}:disabled{cursor:default;opacity:.55}
.${css.mark}{flex:none;color:var(--dsw-alias-label-secondary)}
.${css.section}{padding:6px 8px 2px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.${css.footer}{flex:none;display:flex;padding:8px;border-top:1px solid var(--dsw-alias-label-caption)}
.${css.start}{flex:1;box-sizing:border-box;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover-solid);border:none;border-radius:6px;padding:4px 8px;cursor:pointer}
.${css.start}:disabled{opacity:.45;cursor:default}
.${css.note}{padding:8px 12px;font-size:13px;color:var(--dsw-alias-label-tertiary)}
.${css.error}{flex:none;padding:6px 12px;font-size:12px;color:var(--dsw-alias-state-error-primary)}
`;

/** 注册面板样式（无 document 的环境如 node 测试直接跳过）。 */
if (
  typeof document !== 'undefined' &&
  document.querySelector('style[data-dsh-plugin-om-eval]') === null
) {
  const tag = document.createElement('style');
  tag.dataset.dshPluginOmEval = 'true';
  tag.textContent = panelCss;
  document.head.appendChild(tag);
}

/** 当前高亮的模型：供应商 id 加目录模型。 */
interface Picked {
  readonly provider: string;
  readonly model: EvalModelEntry;
}

/** 两栏模型面板。 */
export function OmEvalModelPanel({ directory, load, t, onSubmit, onClose }: OmEvalModelPanelProps) {
  const state = useSyncExternalStore(
    (listener) => directory.subscribe(listener),
    () => directory.getSnapshot(),
  );
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Picked | null>(null);
  // undefined 表示「模型默认」
  const [effort, setEffort] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // 打开即确保目录已加载
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在挂载时加载一次
  useEffect(() => {
    load();
  }, []);

  // 点面板外或按 Esc 关闭（提交中不关）
  useEffect(() => {
    // 面板由菜单行的 mousedown 打开时，该事件在监听注册后仍会冒泡到 document；
    // 按 timeStamp 忽略挂载前创建的事件，避免被打开面板的同一次点击立刻关闭
    const mountedAt = performance.now();
    const outside = (event: MouseEvent) => {
      if (event.timeStamp <= mountedAt) return;
      if (panelRef.current?.contains(event.target as Node) === true) return;
      if (!submitting) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', onKey);
    };
  }, [submitting, onClose]);

  const groups = useMemo(() => evalModelGroups(state), [state]);
  const filtered = useMemo(() => {
    const text = query.trim();
    return groups
      .map((group) => ({ ...group, models: rankByName(group.models, text) }))
      .filter((group) => group.models.length > 0);
  }, [groups, query]);

  const pick = (provider: string, model: EvalModelEntry) => {
    setPicked({ provider, model });
    setEffort(defaultEvalEffort(model));
    setError(null);
  };
  const submit = async () => {
    if (picked === null || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        provider: picked.provider,
        model: picked.model.id,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSubmitting(false);
    }
  };
  const mark = (checked: boolean) => (
    <span className={css.mark} aria-hidden="true">
      {checked ? '◉' : '○'}
    </span>
  );

  let left: ReactNode;
  if (state.status === 'error' && groups.length === 0) {
    left = (
      <div className={css.note}>
        {state.error ?? t('recompress.loadFailed')}{' '}
        <button type="button" className={css.row} data-om-eval-retry onClick={() => load()}>
          {t('recompress.retry')}
        </button>
      </div>
    );
  } else if (groups.length === 0) {
    left = (
      <div className={css.note}>
        {state.status === 'ready' ? t('eval.empty') : t('recompress.loading')}
      </div>
    );
  } else {
    left = (
      <>
        <input
          className={css.search}
          data-om-eval-search
          value={query}
          placeholder={t('eval.search')}
          onChange={(event) => setQuery(event.target.value)}
          // biome-ignore lint/a11y/noAutofocus: 打开面板后直接输入搜索
          autoFocus
        />
        <div className={css.list}>
          {filtered.length === 0 && <div className={css.note}>{t('eval.noResults')}</div>}
          {filtered.map((group) => (
            <MenuGroup key={group.id} label={group.name}>
              {group.models.map((model) => (
                <button
                  type="button"
                  key={model.id}
                  className={css.row}
                  role="menuitemradio"
                  aria-checked={picked?.provider === group.id && picked.model.id === model.id}
                  data-om-eval-model={`${group.id}/${model.id}`}
                  onClick={() => pick(group.id, model)}
                >
                  {model.name}
                </button>
              ))}
            </MenuGroup>
          ))}
          {state.failures.map((failure) => (
            <button
              type="button"
              key={failure.id}
              className={css.row}
              disabled
              title={t('eval.loadError', { message: failure.message })}
            >
              {failure.name}
            </button>
          ))}
        </div>
      </>
    );
  }

  const efforts = picked?.model.reasoning?.efforts ?? [];
  let right: ReactNode;
  if (picked === null) {
    right = <div className={css.note}>{t('eval.pickModel')}</div>;
  } else if (efforts.length === 0) {
    right = <div className={css.note}>{t('eval.noEffort')}</div>;
  } else {
    right = (
      <>
        <div className={css.section}>{t('recompress.effort.title')}</div>
        <button
          type="button"
          className={css.row}
          role="menuitemradio"
          aria-checked={effort === undefined}
          data-om-eval-effort=""
          onClick={() => setEffort(undefined)}
        >
          {mark(effort === undefined)}
          {t('recompress.effort.default')}
        </button>
        {efforts.map((item) => (
          <button
            type="button"
            key={item.id}
            className={css.row}
            role="menuitemradio"
            aria-checked={effort === item.id}
            data-om-eval-effort={item.id}
            onClick={() => setEffort(item.id)}
          >
            {mark(effort === item.id)}
            {item.name}
          </button>
        ))}
      </>
    );
  }

  return (
    <MenuSurface ref={panelRef} className={css.panel} role="menu">
      <div className={css.columns}>
        <div className={css.left}>{left}</div>
        <div className={css.right}>{right}</div>
      </div>
      {error !== null && (
        <div className={css.error} data-om-eval-error>
          {error}
        </div>
      )}
      <div className={css.footer}>
        <button
          type="button"
          className={css.start}
          data-om-eval-start
          disabled={picked === null || submitting}
          onClick={() => void submit()}
        >
          {t('eval.start')}
        </button>
      </div>
    </MenuSurface>
  );
}
