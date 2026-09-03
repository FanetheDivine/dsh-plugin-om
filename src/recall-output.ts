/**
 * recall / recall-semantic 共享输出契约：输出值为固定形态 { text, images }。
 *  - text：完整消息内容的文本部分（与压缩路径同一套渲染），带图消息在此追加
 *    [图片附件：…] 标注行，帮助模型把文本段落与随后的 image 块对应；
 *  - images：引用会话日志中既有 image 块的持久附件元数据（与宿主 ImageAttachmentRef
 *    同构的无损 JSON，不含图片字节），宿主请求序列化时经 attachment 服务按
 *    attachmentId 解析字节。
 * output.render 把值投影为 text 块 + 逐个 image 块（模式同宿主 read_image 工具）。
 */

import type { ContentBlock, ImageBlock } from '@deepseek-ai/dsh-llm';
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools';

/** 一张图片的持久元数据（与宿主 ImageAttachmentRef 同构的无损 JSON 形态）。 */
export type ImageRefValue = {
  /** attachment 服务的持久图片 id（宿主按此解析图片字节）。 */
  attachmentId: string;
  /** 图片媒体类型（image/png 等）。 */
  mediaType: string;
  /** 字节数。 */
  bytes: number;
  /** 固有显示宽度（px）。 */
  width: number;
  /** 固有显示高度（px）。 */
  height: number;
  /** 原始文件名（可选）。 */
  name?: string;
};

/** recall / recall-semantic 的输出值：text 为文本部分（含图片标注行），images 按文本段出现顺序。 */
export type RecallOutputValue = {
  text: string;
  images: ImageRefValue[];
};

/** 纯文本结果（无图片）的便捷构造。 */
export function textOnly(text: string): RecallOutputValue {
  return { text, images: [] };
}

/** 一张图片的文本标注行：[图片附件：name（mediaType W×H，N bytes）]（无名时省略名称）。 */
export function imageNote(ref: ImageRefValue): string {
  const name = ref.name ? `：${ref.name}` : '';
  return `[图片附件${name}（${ref.mediaType} ${ref.width}×${ref.height}，${ref.bytes} bytes）]`;
}

/** 输出值 wire schema：宿主按此校验 execute 返回值（元数据仅引用既有附件，不含字节）。 */
export const RECALL_OUTPUT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: {
      type: 'string',
      description: '完整消息内容的文本部分（带图位置以 [图片附件：…] 标注行提示）。',
    },
    images: {
      type: 'array',
      description:
        '文本中引用的图片附件元数据（按出现顺序；渲染为随文本之后的 image 内容块，宿主按 attachmentId 解析字节）。',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          attachmentId: { type: 'string', description: '附件服务的持久图片 id。' },
          mediaType: { type: 'string', description: '图片媒体类型（如 image/png）。' },
          bytes: { type: 'integer', description: '字节数。' },
          width: { type: 'integer', description: '固有显示宽度（px）。' },
          height: { type: 'integer', description: '固有显示高度（px）。' },
          name: { type: 'string', description: '原始文件名（可选）。' },
        },
        required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
      },
    },
  },
  required: ['text', 'images'],
};

/** 把输出值投影为模型内容：text 块在前，images 逐个投影为 image 块。 */
export function renderRecallOutput(value: RecallOutputValue): ContentBlock[] {
  /** 内容块（text 信封 + 图片）。 */
  const blocks: ContentBlock[] = [{ type: 'text', text: value.text }];
  for (const ref of value.images) {
    // ref 来自会话日志中既有 image 块的 attachment（宿主 admission 校验过的
    // ImageAttachmentRef），经无损 JSON 往返后按结构还原；品牌类型由宿主解析，此处仅透传
    /** 图片块（attachment 元数据）。 */
    const block: ImageBlock = {
      type: 'image',
      attachment: ref as unknown as ImageBlock['attachment'],
    };
    blocks.push(block);
  }
  return blocks;
}
