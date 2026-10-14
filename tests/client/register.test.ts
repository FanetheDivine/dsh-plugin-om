// 客户端入口注册测试：压缩卡片槽注入宿主 openSession，并转发到 uiWorkspace。

import type { Context } from '@deepseek-ai/cordis';
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client';
import { describe, expect, it, vi } from 'vitest';
import { apply, inject } from '../../src/client/index.ts';

interface Registration {
  name: string;
  key: string;
  inject?: () => { openSession?: (target: SubagentAddress) => void };
}

/** 构造只实现入口实际读取服务的宿主桩，并收集所有槽注册。 */
function setup() {
  const registrations: Registration[] = [];
  const openSession = vi.fn();
  const ctx = {
    effect: (factory: () => (() => void) | undefined) => factory(),
    locale: { register: () => () => {} },
    uiConversation: { events: { register: () => () => {} } },
    uiWorkspace: { openSession },
    configForms: {
      get: () => ({
        subscribe: () => () => {},
        getSnapshot: () => ({ status: 'unavailable' }),
      }),
      whileServed: (_names: string[], fn: () => () => void) => fn(),
    },
    slots: {
      inject: (_name: string, callback: () => () => void) => callback(),
      register: (entry: Registration) => {
        registrations.push(entry);
        return () => {};
      },
    },
  };
  apply(ctx as unknown as Context);
  return { registrations, openSession };
}

describe('client apply', () => {
  it('依赖宿主 uiWorkspace', () => {
    expect(inject).toContain('uiWorkspace');
  });

  it('om-compaction 槽注入的 openSession 转发到 uiWorkspace.openSession', () => {
    const { registrations, openSession } = setup();
    const entry = registrations.find((item) => item.key === 'om-compaction');
    const target = {
      parentSessionId: 'parent-1',
      childSessionId: 'diag-1',
      mode: 'one-shot',
    } as unknown as SubagentAddress;
    entry?.inject?.().openSession?.(target);
    expect(openSession).toHaveBeenCalledExactlyOnceWith(target);
  });
});
