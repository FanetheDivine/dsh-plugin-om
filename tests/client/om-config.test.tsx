// 浏览器配置页行为：真实 React 控件、槽注册和宿主表单快照。
// @vitest-environment jsdom

import type { Context } from '@deepseek-ai/cordis';
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client';
import { act, createElement, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { apply } from '../../src/client/index.ts';
import { en, zh } from '../../src/client/locales.ts';
import type { OmConfigCardProps } from '../../src/client/OmConfigCard.tsx';
import type { OmConfigCardFace } from '../../src/client/om-config-controller.ts';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

type Section = Record<string, number | string | boolean>;
type Op =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] };

/** 仿真宿主 revision 栅栏及原子更新，仅在接受时广播。 */
class HostForm {
  state: ConfigFormSnapshot<Section> = {
    status: 'ready',
    value: { observeThresholdTokens: 35000, compressSkipReasoning: true },
    base: { observeThresholdTokens: 35000, compressSkipReasoning: true },
    user: {},
    revision: 4,
    writable: true,
    mode: 'host',
  };
  listeners = new Set<() => void>();
  calls: Array<{ ops: readonly Op[]; revision: number | undefined }> = [];
  accept = true;
  beforeMutation?: () => Promise<void>;
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  publish = (next: Partial<ConfigFormSnapshot<Section>>) => {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  };
  mutate = async (ops: readonly Op[], revision?: number) => {
    this.calls.push({ ops, revision });
    if (this.beforeMutation) await this.beforeMutation();
    if (!this.accept || revision !== this.state.revision) return false;
    const user = { ...(this.state.user as Section) };
    const value = { ...this.state.value };
    for (const op of ops) {
      const key = op.path[0];
      if (key === undefined) throw new Error('missing path');
      if (op.op === 'set') {
        user[key] = op.value as number | string | boolean;
        value[key] = user[key];
      } else {
        delete user[key];
        const fallback = (this.state.base as Section)[key];
        if (fallback === undefined) delete value[key];
        else value[key] = fallback;
      }
    }
    this.publish({ user, value, revision: (revision ?? 0) + 1 });
    return true;
  };
}

type Registration = { name: string; key: string; inject: () => OmConfigCardFace };

/** 保留真实注册的组件及 inject face，再用 React DOM 挂载。 */
function setup(
  initial?: Partial<ConfigFormSnapshot<Section>>,
  dictionary?: Record<string, string>,
) {
  const host = new HostForm();
  if (initial) host.publish(initial);
  let registration: Registration | undefined;
  let component: ((props: OmConfigCardProps) => React.ReactNode) | undefined;
  const disposers: Array<() => void> = [];
  const registrations: string[] = [];
  const ctx = {
    effect: (factory: () => (() => void) | undefined) => {
      const cleanup = factory();
      if (cleanup) disposers.push(cleanup);
    },
    locale: {
      register: () => () => {},
      bind: () => (key: string) => key,
    },
    uiConversation: { events: { register: () => () => {} } },
    configForms: {
      get: () => host,
      whileServed: (names: string[], fn: () => () => void) => {
        registrations.push(...names);
        return fn();
      },
    },
    slots: {
      inject: (name: string, callback: () => () => void) => {
        if (name === 'plugins.row.config') disposers.push(callback());
      },
      register: (entry: Registration, view: (props: OmConfigCardProps) => React.ReactNode) => {
        registration = entry;
        component = view;
        return () => {};
      },
    },
  };
  // 宿主测试桩只实现客户端实际读取的服务。
  apply(ctx as unknown as Context);
  if (!registration || !component) throw new Error('缺少配置槽注册');
  const entry: Registration = registration;
  const Card = component;
  const face = entry.inject();
  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  function View() {
    const state = useSyncExternalStore(
      face.hooks.omConfigCard.subscribe,
      face.hooks.omConfigCard.getSnapshot,
    );
    return createElement(Card, {
      view: 'page',
      t: (key: string) => dictionary?.[key] ?? key,
      ...face,
      useOmConfigCard: (selector: (snapshot: typeof state) => typeof state) => selector(state),
    } as unknown as OmConfigCardProps);
  }
  act(() => root.render(createElement(View)));
  return {
    host,
    entry,
    registrations,
    face,
    container,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
      for (const dispose of disposers) dispose();
    },
  };
}

const active: Array<ReturnType<typeof setup>> = [];
afterEach(() => {
  for (const test of active.splice(0)) test.cleanup();
});
const mount = (
  initial?: Partial<ConfigFormSnapshot<Section>>,
  dictionary?: Record<string, string>,
) => {
  const test = setup(initial, dictionary);
  active.push(test);
  return test;
};
const control = (container: HTMLElement, name: string) => {
  const input = container.querySelector<HTMLInputElement>(
    `#plugin-config-om-${name}, [data-om-field="${name}"] input`,
  );
  if (!input) throw new Error(`missing control ${name}`);
  return input;
};
const type = (input: HTMLInputElement, text: string) => {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('dsh-plugin-om 的配置槽和编辑', () => {
  it('把行配置注册到服务中的 namespace，并显示 14 个可以编辑的值控件', () => {
    const { entry, registrations, container } = mount();
    expect(registrations).toEqual(['dsh-plugin-om']);
    expect(entry.name).toBe('plugins.row.config');
    expect(entry.key).toBe('dsh-plugin-om#dsh-plugin-om');
    const keys = [
      'observeThresholdTokens',
      'reflectThresholdTokens',
      'tailMessageCount',
      'compressMaxTokens',
      'compressProvider',
      'compressModel',
      'compressReasoningEffort',
      'compressSkipReasoning',
      'rateLimitWaitMs',
      'modelDir',
      'omEnabled',
      'recallEnabled',
      'semanticRecallEnabled',
      'debug',
    ];
    for (const key of keys) expect(control(container, key).disabled, key).toBe(false);
    expect(container.querySelectorAll('input').length).toBe(14);
  });

  it('真实控件暂存整数、选填字符串和布尔值，不会编辑即持久化', () => {
    const { host, container, face } = mount();
    type(control(container, 'observeThresholdTokens'), '4242');
    type(control(container, 'compressProvider'), 'local');
    const enabled = control(container, 'omEnabled');
    act(() => enabled.click());
    expect(face.hooks.omConfigCard.getSnapshot().dirty).toBe(true);
    expect(host.calls).toHaveLength(0);
    expect(host.state.user).toEqual({});
  });

  it('一次保存原子提交全部 14 项和读取时 revision，成功后同步宿主接受值', async () => {
    const { host, container, face } = mount();
    const numberFields = [
      'observeThresholdTokens',
      'reflectThresholdTokens',
      'tailMessageCount',
      'compressMaxTokens',
      'rateLimitWaitMs',
    ];
    const textFields = ['compressProvider', 'compressModel', 'compressReasoningEffort', 'modelDir'];
    const booleanFields = [
      'compressSkipReasoning',
      'omEnabled',
      'recallEnabled',
      'semanticRecallEnabled',
      'debug',
    ];
    for (const key of numberFields) type(control(container, key), '42');
    for (const key of textFields) type(control(container, key), `configured-${key}`);
    for (const key of booleanFields) act(() => control(container, key).click());
    expect(face.hooks.omConfigCard.getSnapshot().dirty).toBe(true);
    expect(host.calls).toHaveLength(0);
    const save = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'config.save',
    );
    expect(save?.disabled).toBe(false);
    await act(async () => {
      save?.click();
      await Promise.resolve();
    });
    expect(host.calls).toHaveLength(1);
    expect(host.calls[0]?.revision).toBe(4);
    expect(host.calls[0]?.ops).toHaveLength(14);
    expect(host.calls[0]?.ops).toContainEqual({
      op: 'set',
      path: ['compressSkipReasoning'],
      value: false,
    });
    expect(host.state.user).toMatchObject({
      observeThresholdTokens: 42,
      compressProvider: 'configured-compressProvider',
    });
    expect(face.hooks.omConfigCard.getSnapshot().dirty).toBe(false);
  });

  it('保存中禁用编辑并显示进度，宿主接受后恢复', async () => {
    const { host, container } = mount();
    let acceptWrite: (() => void) | undefined;
    host.beforeMutation = () =>
      new Promise<void>((resolve) => {
        acceptWrite = resolve;
      });
    type(control(container, 'observeThresholdTokens'), '42');
    const save = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'config.save',
    );
    await act(async () => {
      save?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('config.saving');
    expect(control(container, 'observeThresholdTokens').disabled).toBe(true);
    await act(async () => {
      acceptWrite?.();
      await Promise.resolve();
    });
    expect(host.state.user).toEqual({ observeThresholdTokens: 42 });
    expect(control(container, 'observeThresholdTokens').disabled).toBe(false);
  });

  it('撤销整份草稿不写宿主；字段恢复默认原子清除同值覆盖', async () => {
    const { host, container, face } = mount();
    act(() => host.publish({ user: { observeThresholdTokens: 35000 } }));
    expect(
      container.querySelector('[data-om-field="observeThresholdTokens"]')?.textContent,
    ).toContain('config.overridden');
    type(control(container, 'compressProvider'), 'local');
    const undo = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'config.discard',
    );
    expect(undo).toBeDefined();
    act(() => undo?.click());
    expect(face.hooks.omConfigCard.getSnapshot().dirty).toBe(false);
    expect(host.calls).toHaveLength(0);
    const reset = [
      ...(container
        .querySelector('[data-om-field="observeThresholdTokens"]')
        ?.querySelectorAll('button') ?? []),
    ].find((button) => button.textContent === 'config.reset');
    act(() => reset?.click());
    expect(face.hooks.omConfigCard.getSnapshot().fields.observeThresholdTokens.overridden).toBe(
      false,
    );
    await act(async () => face.save());
    expect(host.calls).toEqual([
      { ops: [{ op: 'unset', path: ['observeThresholdTokens'] }], revision: 4 },
    ]);
    expect(host.state.user).toEqual({});
  });

  it('区分加载/不可用，且只读时全部控件和保存均不可用', () => {
    const loading = mount({ status: 'loading', value: undefined });
    expect(loading.container.textContent).toContain('config.loading');
    expect(loading.container.querySelectorAll('input')).toHaveLength(0);
    const missing = mount({ status: 'unavailable', value: undefined });
    expect(missing.container.textContent).toContain('config.unavailable');
    const locked = mount({ writable: false });
    expect(locked.container.textContent).toContain('config.readOnly');
    expect([...locked.container.querySelectorAll('input')].every((input) => input.disabled)).toBe(
      true,
    );
    const save = [...locked.container.querySelectorAll('button')].find(
      (button) => button.textContent === 'config.save',
    );
    expect(save?.disabled).toBe(true);
  });

  it('小数/指数/非数字不能保存；选填字符串留空会清除覆盖', async () => {
    const { host, container, face } = mount({
      value: { observeThresholdTokens: 35000, compressProvider: 'local' },
      user: { compressProvider: 'local' },
    });
    const number = control(container, 'observeThresholdTokens');
    for (const bad of ['2.5', '1e3', 'NaN']) {
      type(number, bad);
      expect(number.getAttribute('aria-invalid')).toBe('true');
      expect(face.hooks.omConfigCard.getSnapshot().invalid).toBe(true);
      await act(async () => face.save());
      expect(host.calls).toHaveLength(0);
    }
    type(number, '-13');
    type(control(container, 'compressProvider'), '');
    await act(async () => face.save());
    expect(host.calls[0]?.ops).toEqual([
      { op: 'set', path: ['observeThresholdTokens'], value: -13 },
      { op: 'unset', path: ['compressProvider'] },
    ]);
    expect(host.state.user).not.toHaveProperty('compressProvider');
  });

  it('宿主拒绝提交时保留草稿并提示失败；版本变化拒绝时明确提示冲突且不覆盖宿主值', async () => {
    const { host, container, face } = mount();
    type(control(container, 'observeThresholdTokens'), '77');
    host.accept = false;
    await act(async () => face.save());
    expect(container.textContent).toContain('config.saveFailed');
    expect(control(container, 'observeThresholdTokens').value).toBe('77');
    act(() =>
      host.publish({
        revision: 5,
        user: { observeThresholdTokens: 9 },
        value: { observeThresholdTokens: 9 },
      }),
    );
    host.accept = true;
    await act(async () => face.save());
    expect(host.calls.at(-1)?.revision).toBe(4);
    expect(container.textContent).toContain('config.versionConflict');
    expect(host.state.user).toEqual({ observeThresholdTokens: 9 });
    expect(control(container, 'observeThresholdTokens').value).toBe('77');
  });

  it('真实中英字典在 DOM 中显示全部 14 项标题、说明和保存失败反馈', async () => {
    const keys = [
      'observeThresholdTokens',
      'reflectThresholdTokens',
      'tailMessageCount',
      'compressMaxTokens',
      'compressProvider',
      'compressModel',
      'compressReasoningEffort',
      'compressSkipReasoning',
      'rateLimitWaitMs',
      'modelDir',
      'omEnabled',
      'recallEnabled',
      'semanticRecallEnabled',
      'debug',
    ] as const;
    for (const dictionary of [zh, en]) {
      const view = mount(undefined, dictionary);
      for (const key of keys) {
        const row = view.container.querySelector(`[data-om-field="${key}"]`);
        expect(row?.textContent).toContain(dictionary[`config.${key}`]);
        expect(row?.textContent).toContain(dictionary[`config.${key}.hint`]);
      }
      expect(view.container.textContent).toContain(dictionary['config.save']);
      view.host.accept = false;
      type(control(view.container, 'observeThresholdTokens'), '411');
      await act(async () => view.face.save());
      expect(view.container.textContent).toContain(dictionary['config.saveFailed']);
    }
  });

  it('debug 跟随宿主生效值显示，不假定浏览器中的 NODE_ENV 默认值', () => {
    const { container, face } = mount({ value: { debug: true }, user: {} });
    expect(control(container, 'debug').checked).toBe(true);
    expect(face.hooks.omConfigCard.getSnapshot().fields.debug.overridden).toBe(false);
  });
});
