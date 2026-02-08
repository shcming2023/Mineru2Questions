/**
 * 严格的 LLM 输出解析器
 * 
 * 对齐 DataFlow 官方流水线的 LLMOutputParser 算子。
 * 核心约束：强制执行 "ID-Only" 原则。
 * 
 * 设计原则：
 * 1. LLM 必须且只能输出 ID 序列（逗号分隔的数字），不能输出自由文本
 * 2. 任何不符合 ID-Only 格式的输出都视为格式错误，触发异常
 * 3. 所有文本内容必须通过 ID 回填机制从 content_list.json 获取
 * 4. 提供详细的错误信息和日志，便于调试和追溯
 * 
 * 异常处理：
 * - 如果 <title>、<question>、<solution> 包含非 ID 内容，抛出 Error
 * - 如果 XML 结构不完整或标签不匹配，抛出 Error
 * - 调用方应捕获异常并决定是跳过该 chunk 还是触发回退机制
 */

import { ExtractedQAPair, ConvertedBlock } from './types';

export class LLMOutputParser {
  private readonly blocks: ConvertedBlock[];
  private readonly imagePrefix: string;

  constructor(blocks: ConvertedBlock[], imagePrefix: string) {
    this.blocks = blocks;
    this.imagePrefix = imagePrefix;
  }

  /**
   * 解析 LLM 输出的 XML 字符串
   * 
   * @param llmOutput - LLM 返回的原始 XML 字符串
   * @param chunkIndex - 当前处理的块索引，用于调试和追溯
   * @returns 解析后的 QA 对数组
   * @throws Error - 如果输出格式不符合 "ID-Only" 原则
   * 
   * 预期的 LLM 输出格式：
   * <chapter><title>7</title>
   * <qa_pair><label>1</label><question>2,3,4,5</question>
   * <answer>Yes</answer><solution>8,9,10,11,12</solution></qa_pair>
   * </chapter>
   */
  public parse(llmOutput: string, chunkIndex: number): ExtractedQAPair[] {
    // 处理空输出或 <empty> 标记
    if (!llmOutput || llmOutput.trim() === '' || llmOutput.includes('<empty>')) {
      return [];
    }

    const qaPairs: ExtractedQAPair[] = [];

    // 使用正则提取所有 <chapter>...</chapter> 块
    // 注意：使用 /gs 标志支持多行匹配和贪婪匹配
    const chapterMatches = llmOutput.match(/<chapter>(.*?)<\/chapter>/gs);
    
    if (!chapterMatches || chapterMatches.length === 0) {
      throw new Error(
        `[Chunk ${chunkIndex}] Invalid XML structure: No <chapter> tags found. ` +
        `LLM output must contain at least one <chapter>...</chapter> block.`
      );
    }

    for (const chapterMatch of chapterMatches) {
      // 提取章节标题 ID
      const titleMatch = chapterMatch.match(/<title>(.*?)<\/title>/);
      const chapterTitleIds = titleMatch ? titleMatch[1].trim() : '';

      // **关键校验 1**：确保 <title> 是纯粹的 ID 序列
      if (chapterTitleIds && !this.isIdSequence(chapterTitleIds)) {
        throw new Error(
          `[Chunk ${chunkIndex}] Invalid format: <title> must contain only comma-separated IDs. ` +
          `Found: "${chapterTitleIds}". ` +
          `LLM should output IDs like "7" or "10,11", not free text.`
        );
      }

      // 通过 ID 回填章节标题文本
      const chapterTitle = this.getTextFromIds(chapterTitleIds);

      // 提取所有 <qa_pair>...</qa_pair> 块
      const pairMatches = chapterMatch.match(/<qa_pair>(.*?)<\/qa_pair>/gs);
      
      if (!pairMatches || pairMatches.length === 0) {
        // 如果章节内没有 qa_pair，跳过（可能是纯标题章节）
        continue;
      }

      for (const pairMatch of pairMatches) {
        const label = pairMatch.match(/<label>(.*?)<\/label>/)?.[1]?.trim() || '';
        const questionIds = pairMatch.match(/<question>(.*?)<\/question>/)?.[1]?.trim() || '';
        const answer = pairMatch.match(/<answer>(.*?)<\/answer>/)?.[1]?.trim() || '';
        const solutionIds = pairMatch.match(/<solution>(.*?)<\/solution>/)?.[1]?.trim() || '';

        // **关键校验 2**：确保 <question> 是纯粹的 ID 序列
        if (questionIds && !this.isIdSequence(questionIds)) {
          throw new Error(
            `[Chunk ${chunkIndex}] Invalid format: <question> must be ID sequence. ` +
            `Found: "${questionIds.substring(0, 100)}...". ` +
            `LLM should output IDs like "10,11,12", not question text.`
          );
        }

        // **关键校验 3**：确保 <solution> 是纯粹的 ID 序列
        if (solutionIds && !this.isIdSequence(solutionIds)) {
          throw new Error(
            `[Chunk ${chunkIndex}] Invalid format: <solution> must be ID sequence. ` +
            `Found: "${solutionIds.substring(0, 100)}...". ` +
            `LLM should output IDs like "20,21,22", not solution text.`
          );
        }

        // 通过 ID 回填问题和解答文本，同时提取关联的图片
        const { text: questionText, images: questionImages } = this.getTextAndImagesFromIds(questionIds);
        const { text: solutionText, images: solutionImages } = this.getTextAndImagesFromIds(solutionIds);

        // 构建 ExtractedQAPair 对象
        qaPairs.push({
          label,
          question: questionText,
          answer, // 答案可以是短文本，不强制要求 ID
          solution: solutionText,
          chapter_title: chapterTitle,
          images: [...questionImages, ...solutionImages],
          // 保存原始 ID 序列用于去重和追溯
          questionIds,
          solutionIds,
          chapterTitleIds,
          chunkIndex,
          rawChapterTitle: chapterTitle,
          sourcePageIndex: this.getFirstPageFromIds(questionIds || solutionIds)
        });
      }
    }

    // **关键校验 4**：如果有输出但没解析出任何内容，也视为一种格式错误
    if (qaPairs.length === 0 && llmOutput.trim() !== '' && !llmOutput.includes('<empty>')) {
      throw new Error(
        `[Chunk ${chunkIndex}] LLM output was not empty but no valid <qa_pair> could be parsed. ` +
        `Please check if the output follows the required XML format.`
      );
    }

    return qaPairs;
  }

  /**
   * 校验一个字符串是否是合法的、逗号分隔的 ID 序列
   * 
   * 合法格式：
   * - 空字符串（允许）
   * - "10"（单个 ID）
   * - "10,11,12"（多个 ID）
   * - "10, 11, 12"（允许空格）
   * 
   * 非法格式：
   * - "这是一段文本"（包含非数字字符）
   * - "10,11,some text"（混合 ID 和文本）
   * - "例① 实数..."（自由文本）
   */
  private isIdSequence(ids: string): boolean {
    if (ids.trim() === '') return true; // 空序列是合法的
    
    // 移除所有空格后，检查是否只包含数字和逗号
    const normalized = ids.replace(/\s/g, '');
    return /^[\d,]+$/.test(normalized);
  }

  /**
   * 根据 ID 序列从 blocks 中提取文本
   * 
   * @param ids - 逗号分隔的 ID 序列，如 "10,11,12"
   * @returns 拼接后的文本字符串
   * 
   * 处理逻辑：
   * 1. 将 ID 序列拆分为数字数组
   * 2. 从 blocks 中查找对应的 block
   * 3. 提取 text 字段并拼接（用空格分隔）
   * 4. 如果某个 ID 不存在，跳过（不抛出异常，保证鲁棒性）
   */
  private getTextFromIds(ids: string): string {
    if (!ids || ids.trim() === '') return '';

    const idList = ids.split(',').map(id => parseInt(id.trim(), 10));
    const textParts: string[] = [];

    for (const id of idList) {
      const block = this.blocks.find(b => b.id === id);
      if (block && block.text) {
        textParts.push(block.text);
      }
      // 如果 block 不存在或没有 text，跳过（可能是图片 block）
    }

    return textParts.join(' ').trim();
  }

  /**
   * 根据 ID 序列从 blocks 中提取文本和图片
   * 
   * @param ids - 逗号分隔的 ID 序列
   * @returns 包含 text 和 images 的对象
   * 
   * 处理逻辑：
   * 1. 遍历 ID 列表
   * 2. 如果 block 类型是 image，提取 img_path 并加上前缀
   * 3. 如果 block 类型是 text，提取 text 字段
   * 4. 保持 ID 的顺序，确保文本和图片的位置关系正确
   */
  private getTextAndImagesFromIds(ids: string): { text: string; images: string[] } {
    if (!ids || ids.trim() === '') {
      return { text: '', images: [] };
    }

    const idList = ids.split(',').map(id => parseInt(id.trim(), 10));
    const textParts: string[] = [];
    const images: string[] = [];

    for (const id of idList) {
      const block = this.blocks.find(b => b.id === id);
      if (!block) continue;

      if (block.type === 'image' && block.img_path) {
        // 图片 block：记录图片路径
        images.push(`${this.imagePrefix}/${block.img_path}`);
      } else if (block.text) {
        // 文本 block：记录文本内容
        textParts.push(block.text);
      }
      // 其他类型（如 table、equation）暂时跳过，未来可扩展
    }

    return {
      text: textParts.join(' ').trim(),
      images
    };
  }

  /**
   * 从 ID 序列中获取第一个 block 的页码
   * 
   * @param ids - 逗号分隔的 ID 序列
   * @returns 第一个 block 的页码索引，如果不存在则返回 undefined
   * 
   * 用途：用于记录题目的来源页码，便于追溯和调试
   */
  private getFirstPageFromIds(ids: string): number | undefined {
    if (!ids || ids.trim() === '') return undefined;

    const firstId = parseInt(ids.split(',')[0].trim(), 10);
    const block = this.blocks.find(b => b.id === firstId);
    return block?.page_idx;
  }
}
