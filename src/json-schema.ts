/**
 * zod schema → 工具 wire 参数 JSON Schema 的转换工具。导出 parametersFromZod。
 * 工具参数定义统一由 zod 的 toJSONSchema 生成（.describe() 描述透传），剥除
 * $schema 元键与 additionalProperties（未知键在执行期由 zod 解析剥离）。
 */
import { type $ZodType, toJSONSchema } from 'zod/v4/core';

/** 由 zod schema 生成 wire 参数 JSON Schema（根 type:'object'，含 properties/required）。 */
export function parametersFromZod<T extends $ZodType>(schema: T): Record<string, unknown> {
  const json = toJSONSchema(schema);
  const { $schema: _schema, additionalProperties: _additional, ...rest } = json;
  return rest;
}
