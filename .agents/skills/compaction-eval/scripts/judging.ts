/**
 * facts 与评审文件的共享类型、判定词与校验逻辑，供 aggregate.ts 与 merge.ts 使用。
 */

import { createHash } from 'node:crypto';
import type { Position } from './prepare.ts';

/** 事实分类。 */
export type Category = 'A' | 'B' | 'C';

/** facts.json 中的关键事实。 */
export interface Fact {
  id: string;
  fact: string;
  category: Category;
  position: Position;
  source_indices: number[];
  check_hint: string;
  evidence_after?: string;
}

/** facts.json 中的无关信息。 */
export interface Irrelevant {
  id: string;
  fact: string;
  is_credential?: boolean;
}

/** facts.json 内容。 */
export interface FactList {
  facts: Fact[];
  irrelevant: Irrelevant[];
}

/** 评审条目：判定词加可选依据。 */
export interface JudgeItem {
  id: string;
  verdict: string;
  quote?: string;
  note?: string;
}

/** judge-<V>-<N>.json 内容。 */
export interface Judge {
  facts: JudgeItem[];
  irrelevant: JudgeItem[];
  unsupported_claims?: { quote?: string; reason?: string }[];
  extra_irrelevant?: { content?: string; chars_estimate?: number }[];
  overall_comment?: string;
  /** 合并时所用 facts.json 的哈希，aggregate 校验评审与清单同版。 */
  facts_sha?: string;
}

/** 事实判定词到得分。 */
export const VERDICT: Record<string, number> = { 保留: 1, 部分: 0.5, 丢失: 0, 歪曲: -1 };

/** 无关信息判定词到得分。 */
export const D_VERDICT: Record<string, number> = { 已省略: 1, 已概括: 0.7, 详细保留: 0 };

/** 事实分类权重。 */
export const W: Record<Category, number> = { A: 3, B: 2, C: 1 };

/** 位置分段名。 */
export const POSITIONS: Position[] = ['head', 'mid', 'tail'];

/**
 * 校验单个评审内容：事实与无关信息全覆盖、无重复、无未知 id、判定词合法。
 * 返回全部问题（带评审文件名前缀），为空即通过。
 */
export function judgeProblems(judge: Judge, fj: FactList, name: string): string[] {
  const problems: string[] = [];
  for (const [items, words, label, all] of [
    [judge.facts, VERDICT, '事实', fj.facts] as const,
    [judge.irrelevant, D_VERDICT, '无关信息', fj.irrelevant] as const,
  ]) {
    const byId = new Map<string, JudgeItem>();
    for (const x of items ?? []) {
      if (byId.has(x.id)) problems.push(`${name} ${label} ${x.id} 重复判定`);
      else byId.set(x.id, x);
    }
    for (const f of all) {
      const x = byId.get(f.id);
      if (x === undefined) {
        problems.push(`${name} 未覆盖${label} ${f.id}`);
      } else if (!(x.verdict in words)) {
        problems.push(`${name} ${label} ${f.id} 判定词非法：${x.verdict}`);
      }
    }
    for (const x of items ?? []) {
      if (!all.some((f) => f.id === x.id)) problems.push(`${name} ${label} ${x.id} 不在清单中`);
    }
  }
  return problems;
}

/** facts.json 的规范哈希：按稳定序列化计算，供评审文件记录与 aggregate 比对。 */
export function factsHash(fj: FactList): string {
  const canon = JSON.stringify({
    facts: fj.facts.map((f) => ({
      id: f.id,
      fact: f.fact,
      category: f.category,
      position: f.position,
      source_indices: f.source_indices,
      check_hint: f.check_hint,
      evidence_after: f.evidence_after ?? '',
    })),
    irrelevant: fj.irrelevant.map((d) => ({
      id: d.id,
      fact: d.fact,
      is_credential: d.is_credential ?? false,
    })),
  });
  return createHash('sha256').update(canon, 'utf8').digest('hex');
}
