/**
 * 共享的 Block 展平模块
 * 
 * 统一 chapterPreprocess.ts 和 extraction.ts 的 block 展平逻辑，
 * 确保两个模块使用完全相同的 ID 空间。
 * 
 * 展平规则（按优先级）：
 * 1. 过滤噪声块：page_number, footer, header
 * 2. 过滤目录条目：纯"目录"文本、带省略号+页码的条目
 * 3. 展平 list 块：每个 list_item 变为独立的 text block
 * 4. 展平 table 块：
 *    a. 如果有 inside 子块 → 展平子块（保留 text_level 等元数据）
 *    b. 如果有 HTML table_body → 按 <tr> 拆分
 *    c. 否则作为普通 block 处理
 * 5. 其他类型（text, equation, image）直接转换
 * 
 * @module blockFlattener
 */

import { ConvertedBlock } from './types';

/**
 * 扩展的展平 block 类型（包含章节预处理需要的额外字段）
 */
export interface FlatBlock extends ConvertedBlock {
  text_level: number | null;
}

/**
 * content_list.json 中的原始 block（比 ContentBlock 更宽松）
 */
interface RawBlock {
  type?: string;
  text?: string;
  text_level?: number;
  page_idx?: number;
  img_path?: string;
  image_caption?: string[];
  list_items?: string[];
  inside?: RawBlock[];
  table_body?: string;
  bbox?: number[];
  sub_type?: string;
  [key: string]: any;
}

/**
 * 统一的 block 展平函数
 * 
 * 将 content_list.json 的原始 block 列表展平为带连续 ID 的 FlatBlock 列表。
 * chapterPreprocess 和 extraction 都必须使用此函数，确保 ID 空间一致。
 * 
 * @param raw - content_list.json 的原始内容
 * @returns 展平后的 FlatBlock 数组
 */
export function flattenContentList(raw: RawBlock[]): FlatBlock[] {
  const blocks: FlatBlock[] = [];
  let currentId = 0;

  for (const block of raw) {
    if (!block || typeof block !== 'object') continue;

    const type = block.type ?? 'text';
    const page = block.page_idx ?? 0;

    // ── 1. 过滤噪声块 ──
    if (['page_number', 'footer', 'header'].includes(type)) {
      continue;
    }

    // ── 2. 过滤目录条目 ──
    if (block.text && (
      block.text.trim() === '目录' ||
      /\.{4,}\s*\d+$/.test(block.text)
    )) {
      continue;
    }

    // ── 3. 展平 list 块 ──
    // 修复 P0-002: 对齐官方 MinerU2LLMInputOperator 的 list 展平逻辑
    // 只展平 sub_type='text' 的列表;非文本列表作为整体 block 保留
    if (type === 'list' && Array.isArray(block.list_items) && block.list_items.length > 0) {
      if (block.sub_type === 'text') {
        for (const itemText of block.list_items) {
          blocks.push({
            id: currentId++,
            type: 'text',
            text: (itemText ?? '').trim(),
            page_idx: page,
            text_level: null,
          });
        }
        continue;
      }
      // 非文本列表(如图片列表)作为整体 block 保留,ID 保持连续
    }

    // ── 4. 展平 table 块 ──
    if (type === 'table') {
      // 4a. 优先使用 inside 子块（Mineru 新版格式，保留结构化信息）
      if (Array.isArray(block.inside) && block.inside.length > 0) {
        for (const sub of block.inside) {
          blocks.push({
            id: currentId++,
            type: sub.type ?? 'text',
            text: (sub.text ?? '').trim(),
            page_idx: page,
            text_level: sub.text_level ?? null,
            img_path: sub.img_path,
          });
        }
        continue;
      }

      // 4b. 使用 HTML table_body 按行拆分
      const tableContent = block.text || block.table_body;
      if (typeof tableContent === 'string' && tableContent.includes('<tr')) {
        const rows = tableContent.match(/<tr[\s\S]*?<\/tr>/gi) || [];
        for (const rowHtml of rows) {
          blocks.push({
            id: currentId++,
            type: 'text',
            text: `[Table Row] ${rowHtml}`,
            page_idx: page,
            text_level: null,
          });
        }
        continue;
      }

      // 4c. 无法展平的 table，作为普通 block
      blocks.push({
        id: currentId++,
        type: 'text',
        text: (block.text ?? '').trim(),
        page_idx: page,
        text_level: block.text_level ?? null,
      });
      continue;
    }

    // ── 5. 其他类型（text, equation, image 等）──
    const newBlock: FlatBlock = {
      id: currentId,
      type,
      page_idx: page,
      text_level: block.text_level ?? null,
    };

    if (block.text) {
      newBlock.text = block.text.trim();
    }

    if (type === 'image' && block.img_path) {
      newBlock.img_path = block.img_path;
      if (block.image_caption && block.image_caption.length > 0) {
        newBlock.image_caption = block.image_caption.join(' ');
      }
    }

    blocks.push(newBlock);
    currentId++;
  }

  return blocks;
}

/**
 * 将 FlatBlock 转换为 ConvertedBlock（去掉 text_level 和官方不需要的字段）
 *
 * 用于 extraction.ts 中需要 ConvertedBlock 类型的场景。
 *
 * 对齐官方 MinerU2LLMInputOperator._convert_json():
 * - 强制剔除 page_idx 字段,避免污染 LLM 上下文
 * - 官方理由: 这个字段会污染 LLM 的上下文窗口,导致 token 浪费
 * - bbox 字段在 RawBlock 中存在,但在展平时已被过滤,不会进入 FlatBlock
 *
 * @param flatBlocks - 展平后的 FlatBlock 数组
 * @returns 转换后的 ConvertedBlock 数组
 */
export function toConvertedBlocks(flatBlocks: FlatBlock[]): ConvertedBlock[] {
  // 修复 P0-001: 剔除 page_idx,对齐官方 MinerU2LLMInputOperator
  // bbox 已在展平时被过滤,无需再次处理
  return flatBlocks.map(({ text_level, page_idx, ...rest }) => rest);
}
