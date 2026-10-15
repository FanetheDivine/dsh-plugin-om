/**
 * 换模型重压缩的模型选择菜单：触发按钮 + 浮层，支持多选批量提交。
 * 数据来自宿主会话共享的模型目录（与 /model 弹窗同一份：按供应商分组、模型的思考等级
 * 元数据），搜索排序复用宿主 rankByName，浮层材质复用 MenuSurface / MenuGroup。
 * 模型为复选框多选；勾选后出现全局思考等级区（「模型默认」+ 所选模型等级并集）；
 * 底部「开始(N)」一次性展开为模型×等级组合并提交 onPick，N 为 0 时禁用；
 * 点浮层外或 Esc 关闭不提交。选择只触发 onPick，不改变会话自身所选模型。
 * 导出 OmRecompressMenu。
 */
import { MenuGroup, MenuSurface, rankByName } from '@deepseek-ai/dsh-client-ui-primitives';
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { MouseEvent, ReactNode } from 'react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import type {
  DirectoryModel,
  RecompressChoice,
  RecompressInjected,
  SelectedModel,
} from './recompress-run.ts';
import { effortUnion, expandRecompressChoices } from './recompress-run.ts';

/** 菜单属性：重压缩能力（目录与加载）、文案座与批量选中回调；提交期间按钮保持可用以支持并行。 */
export interface OmRecompressMenuProps {
  readonly source: Pick<RecompressInjected, 'directory' | 'load'>;
  readonly t: TranslateNS<'om-compaction'>;
  readonly onPick: (choices: readonly RecompressChoice[]) => void;
}

/** 超过该模型数才显示搜索框。 */
const SEARCH_MIN_MODELS = 5;

const css = {
  button: 'om-recompress-button',
  panel: 'om-recompress-panel',
  search: 'om-recompress-search',
  list: 'om-recompress-list',
  row: 'om-recompress-row',
  mark: 'om-recompress-mark',
  section: 'om-recompress-section',
  footer: 'om-recompress-footer',
  start: 'om-recompress-start',
  note: 'om-recompress-note',
} as const;

const menuCss = `
.${css.button}{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;cursor:pointer;white-space:nowrap;border-radius:999px;flex:none;align-items:center;gap:4px;margin:0;padding:2px 8px;display:inline-flex}
.${css.button}:is(:hover,:focus-visible):not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}
.${css.panel}{position:fixed;z-index:1000;box-sizing:border-box;width:260px;max-height:320px;display:flex;flex-direction:column;overflow:hidden}
.${css.search}{box-sizing:border-box;width:100%;margin:0;padding:8px 12px;font:inherit;font-size:13px;color:inherit;background:none;border:none;border-bottom:1px solid var(--dsw-alias-label-caption);outline:none}
.${css.list}{min-height:0;overflow-y:auto;padding:4px}
.${css.row}{box-sizing:border-box;width:100%;display:flex;align-items:center;gap:6px;text-align:left;font:inherit;font-size:13px;line-height:20px;color:inherit;background:none;border:none;border-radius:6px;padding:4px 8px;cursor:pointer}
.${css.row}:hover,.${css.row}:focus-visible{background:var(--dsw-alias-bg-hover,transparent);outline:none}
.${css.mark}{flex:none;color:var(--dsw-alias-label-secondary)}
.${css.section}{padding:6px 8px 2px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.${css.footer}{flex:none;display:flex;padding:8px;border-top:1px solid var(--dsw-alias-label-caption)}
.${css.start}{flex:1;box-sizing:border-box;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover-solid);border:none;border-radius:6px;padding:4px 8px;cursor:pointer}
.${css.start}:disabled{opacity:.45;cursor:default}
.${css.note}{padding:8px 12px;font-size:13px;color:var(--dsw-alias-label-tertiary)}
`;

/** 注册菜单样式（无 document 的环境如 node 测试直接跳过）。 */
if (
  typeof document !== 'undefined' &&
  document.querySelector('style[data-dsh-plugin-om-recompress]') === null
) {
  const tag = document.createElement('style');
  tag.dataset.dshPluginOmRecompress = 'true';
  tag.textContent = menuCss;
  document.head.appendChild(tag);
}

/** 触发按钮与模型多选浮层。 */
export function OmRecompressMenu({ source, t, onPick }: OmRecompressMenuProps) {
  const state = useSyncExternalStore(
    (listener) => source.directory.subscribe(listener),
    () => source.directory.getSnapshot(),
  );
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // 已勾选模型，按勾选顺序保存（含目录元数据快照，展开组合时使用）
  const [selected, setSelected] = useState<readonly SelectedModel[]>([]);
  // 全局思考等级勾选：「模型默认」默认勾上，具体等级默认不勾
  const [useDefault, setUseDefault] = useState(true);
  const [effortIds, setEffortIds] = useState<ReadonlySet<string>>(() => new Set());
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const totalModels = state.groups.reduce((sum, group) => sum + group.models.length, 0);
  const showSearch = totalModels >= SEARCH_MIN_MODELS;
  const groups = useMemo(() => {
    const text = showSearch ? query.trim() : '';
    return state.groups
      .map((group) => ({ ...group, models: rankByName(group.models, text) }))
      .filter((group) => group.models.length > 0);
  }, [state.groups, query, showSearch]);

  const efforts = useMemo(() => effortUnion(selected), [selected]);
  const picks = useMemo(() => ({ useDefault, effortIds }), [useDefault, effortIds]);
  const choices = useMemo(() => expandRecompressChoices(selected, picks), [selected, picks]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setSelected([]);
    setUseDefault(true);
    setEffortIds(new Set());
  }, []);

  // 点击浮层外或按 Esc 关闭（不提交）
  useEffect(() => {
    if (!open) return;
    const outside = (event: globalThis.MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) === true) return;
      if (panelRef.current?.contains(target) === true) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  // 浮层贴触发按钮右缘：下方放不下时翻到上方，并限制在视口内
  // biome-ignore lint/correctness/useExhaustiveDependencies: 目录、搜索与勾选状态会改变浮层尺寸，需重新定位
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect === undefined) return;
      const margin = 12;
      const width = panelRef.current?.offsetWidth ?? 260;
      const height = panelRef.current?.offsetHeight ?? 0;
      const left = Math.min(
        Math.max(rect.right - width, margin),
        window.innerWidth - width - margin,
      );
      const below = rect.bottom + 4;
      const top =
        below + height <= window.innerHeight - margin
          ? below
          : Math.max(margin, rect.top - 4 - height);
      setPosition({ left, top });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, state, query, selected, useDefault, effortIds]);

  const isSelected = (provider: string, model: DirectoryModel) =>
    selected.some((entry) => entry.provider === provider && entry.model.id === model.id);
  const toggleModel = (provider: string, model: DirectoryModel) => {
    setSelected((prev) =>
      prev.some((entry) => entry.provider === provider && entry.model.id === model.id)
        ? prev.filter((entry) => !(entry.provider === provider && entry.model.id === model.id))
        : [...prev, { provider, model }],
    );
  };
  const toggleEffort = (id: string) => {
    setEffortIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  // 点「开始」：一次性提交全部组合并关闭浮层
  const submit = () => {
    const batch = choices;
    close();
    onPick(batch);
  };
  const mark = (checked: boolean) => (
    <span className={css.mark} aria-hidden="true">
      {checked ? '☑' : '☐'}
    </span>
  );

  let body: ReactNode;
  if (state.status === 'error' && state.groups.length === 0) {
    body = (
      <div className={css.note}>
        {state.error ?? t('recompress.loadFailed')}{' '}
        <button
          type="button"
          className={css.row}
          data-om-recompress-retry
          onClick={() => source.load()}
        >
          {t('recompress.retry')}
        </button>
      </div>
    );
  } else if (state.groups.length === 0) {
    body = (
      <div className={css.note}>
        {state.status === 'ready' ? t('recompress.empty') : t('recompress.loading')}
      </div>
    );
  } else {
    body = (
      <>
        {showSearch && (
          <input
            className={css.search}
            data-om-recompress-search
            value={query}
            placeholder={t('recompress.search')}
            onChange={(event) => setQuery(event.target.value)}
            // biome-ignore lint/a11y/noAutofocus: 打开浮层后直接输入搜索
            autoFocus
          />
        )}
        <div className={css.list}>
          {groups.map((group) => (
            <MenuGroup key={group.id} label={group.name}>
              {group.models.map((model) => {
                const checked = isSelected(group.id, model);
                return (
                  <button
                    type="button"
                    key={model.id}
                    className={css.row}
                    role="menuitemcheckbox"
                    aria-checked={checked}
                    data-om-recompress-model={`${group.id}/${model.id}`}
                    onClick={() => toggleModel(group.id, model)}
                  >
                    {mark(checked)}
                    {model.name}
                  </button>
                );
              })}
            </MenuGroup>
          ))}
          {efforts.length > 0 && (
            <>
              <div className={css.section}>{t('recompress.effort.title')}</div>
              <button
                type="button"
                className={css.row}
                role="menuitemcheckbox"
                aria-checked={useDefault}
                data-om-recompress-effort=""
                onClick={() => setUseDefault((prev) => !prev)}
              >
                {mark(useDefault)}
                {t('recompress.effort.default')}
              </button>
              {efforts.map((effort) => {
                const checked = effortIds.has(effort.id);
                return (
                  <button
                    type="button"
                    key={effort.id}
                    className={css.row}
                    role="menuitemcheckbox"
                    aria-checked={checked}
                    data-om-recompress-effort={effort.id}
                    onClick={() => toggleEffort(effort.id)}
                  >
                    {mark(checked)}
                    {effort.name}
                  </button>
                );
              })}
            </>
          )}
        </div>
        <div className={css.footer}>
          <button
            type="button"
            className={css.start}
            data-om-recompress-start
            disabled={choices.length === 0}
            onClick={submit}
          >
            {t('recompress.start', { count: choices.length })}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={css.button}
        data-om-recompress
        onClick={(event: MouseEvent) => {
          event.stopPropagation();
          if (open) {
            close();
            return;
          }
          source.load();
          setOpen(true);
        }}
      >
        {t('recompress.action')}
      </button>
      {open &&
        createPortal(
          <MenuSurface
            ref={panelRef}
            className={css.panel}
            role="menu"
            style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
          >
            {body}
          </MenuSurface>,
          document.body,
        )}
    </>
  );
}
