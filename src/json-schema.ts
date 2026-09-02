/**
 * zod schema → 工具 wire 参数 JSON Schema 的转换工具。
 *
 * 官方 API（如 api.deepseek.com 的 /chat/completions）要求 tools[].function.parameters
 * 为根级带 type:'object' 的标准 JSON Schema；工具的参数定义统一由 zod 的 toJSONSchema
 * 生成，避免手写属性 map 与执行期解析 schema 双份定义漂移。剥除 $schema 元键与
 * additionalProperties：未知键不在 wire 层拒绝，执行期仍由 zod 解析剥离。
 */
import { type $ZodType, toJSONSchema } from 'zod/v4/core';

/** 由 zod schema 生成 wire 参数 JSON Schema（根 type:'object'，含 properties/required 与 describe 描述）。 */
export function parametersFromZod<T extends $ZodType>(schema: T): Record<string, unknown> {
  const json = toJSONSchema(schema);
  const { $schema: _schema, additionalProperties: _additional, ...rest } = json;
  return rest;
}
