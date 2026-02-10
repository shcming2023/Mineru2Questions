/**
 * 题目解析器 (v1.1 - 增强容错与日志)
 * 
 * 对齐 PRD v1.1 和 DataFlow 官方流水线的 LLMOutputParser 算子。
 * 
 * 核心功能：
 * 1. 严格解析：强制执行 "ID-Only" 原则
 * 2. 容错回退：当严格解析失败时，启动宽松解析模式
 * 3. 日志记录：保存 LLM 原始输出和解析结果
 * 4. 题目类型识别：自动识别 example vs exercise
 * 
 * 设计原则：
 * - LLM 必须且只能输出 ID 序列（逗号分隔的数字），不能输出自由文本
 * - 任何不符合 ID-Only 格式的输出都触发宽松解析
 * - 所有文本内容必须通过 ID 回填机制从 content_list.json 获取
 * - 提供详细的错误信息和日志，便于调试和追溯
 */

import * as fs from 'fs';
import * as path from 'path';
import { ConvertedBlock } from './types';

/**
 * 提取的题目数据结构
 */
export interface ExtractedQuestion {
  label: string;                // 题号，如 "1", "例1", "①"
  type: 'example' | 'exercise'; // 题目类型
  chapter_title: string;        // 章节标题
  question: string;             // 题目文本
  solution: string;             // 解答文本（仅对 example 类型）
  images: string[];             // 图片路径列表
  page_idx?: number;            // 页码
  has_answer: boolean;          // 是否提取到答案
  
  // 用于调试和追溯的字段
  questionIds?: string;
  solutionIds?: string;
  chapterTitleIds?: string;
  chunkIndex?: number;
}

/**
 * 题目解析器
 */
export class QuestionParser {
  private readonly blocks: ConvertedBlock[];
  private readonly imagePrefix: string;
  private readonly logDir?: string;

  constructor(blocks: ConvertedBlock[], imagePrefix: string, logDir?: string) {
    this.blocks = blocks;
    this.imagePrefix = imagePrefix;
    this.logDir = logDir;
  }

  /**
   * 解析 LLM 输出（带容错回退）
   * 
   * @param llmOutput - LLM 返回的原始 XML 字符串
   * @param chunkIndex - 当前处理的块索引
   * @returns 解析后的题目数组
   */
  public parseWithFallback(llmOutput: string, chunkIndex: number): ExtractedQuestion[] {
    // 保存 LLM 原始输出
    if (this.logDir) {
      this.saveLog(chunkIndex, 'llm_output', llmOutput);
    }

    try {
      // 尝试严格解析
      const questions = this.strictParse(llmOutput, chunkIndex);
      
      // 保存解析结果
      if (this.logDir) {
        this.saveLog(chunkIndex, 'parsed_questions', JSON.stringify(questions, null, 2));
      }
      
      return questions;
      
    } catch (strictError: any) {
      console.warn(`[Chunk ${chunkIndex}] Strict parse failed: ${strictError.message}`);
      console.warn(`[Chunk ${chunkIndex}] Trying lenient parse...`);
      
      try {
        // 启动宽松解析
        const questions = this.lenientParse(llmOutput, chunkIndex);
        
        // 保存解析结果
        if (this.logDir) {
          this.saveLog(chunkIndex, 'parsed_questions_lenient', JSON.stringify(questions, null, 2));
        }
        
        return questions;
        
      } catch (lenientError: any) {
        console.error(`[Chunk ${chunkIndex}] Lenient parse also failed: ${lenientError.message}`);
        console.error(`[Chunk ${chunkIndex}] Skipping this chunk.`);
        
        // 保存错误信息
        if (this.logDir) {
          this.saveLog(chunkIndex, 'parse_error', `Strict Error: ${strictError.message}\n\nLenient Error: ${lenientError.message}`);
        }
        
        // 返回空数组，确保流水线继续
        return [];
      }
    }
  }

  /**
   * 严格解析：强制执行 ID-Only 原则
   */
  private strictParse(llmOutput: string, chunkIndex: number): ExtractedQuestion[] {
    // 处理空输出或 <empty> 标记
    if (!llmOutput || llmOutput.trim() === '' || llmOutput.includes('<empty>')) {
      return [];
    }

    const questions: ExtractedQuestion[] = [];

    // 提取所有 <chapter>...</chapter> 块
    const chapterMatches = llmOutput.match(/<chapter>([\s\S]*?)<\/chapter>/g);
    
    if (!chapterMatches || chapterMatches.length === 0) {
      throw new Error(
        `Invalid XML structure: No <chapter> tags found. ` +
        `LLM output must contain at least one <chapter>...</chapter> block.`
      );
    }

    for (const chapterMatch of chapterMatches) {
      // 提取章节标题 ID
      const titleMatch = chapterMatch.match(/<title>(.*?)<\/title>/);
      const chapterTitleIds = titleMatch ? titleMatch[1].trim() : '';

      // 校验 <title> 是纯粹的 ID 序列
      if (chapterTitleIds && !this.isIdSequence(chapterTitleIds)) {
        throw new Error(
          `Invalid format: <title> must contain only comma-separated IDs. ` +
          `Found: "${chapterTitleIds}". ` +
          `LLM should output IDs like "7" or "10,11", not free text.`
        );
      }

      // 通过 ID 回填章节标题文本
      const chapterTitle = this.getTextFromIds(chapterTitleIds);

      // 提取所有 <qa_pair>...</qa_pair> 块
      const pairMatches = chapterMatch.match(/<qa_pair>([\s\S]*?)<\/qa_pair>/g);
      
      if (!pairMatches || pairMatches.length === 0) {
        // 如果章节内没有 qa_pair，跳过（可能是纯标题章节）
        continue;
      }

      for (const pairMatch of pairMatches) {
        const label = pairMatch.match(/<label>(.*?)<\/label>/)?.[1]?.trim() || '';
        const type = pairMatch.match(/<type>(.*?)<\/type>/)?.[1]?.trim() as 'example' | 'exercise' || 'exercise';
        const questionIds = pairMatch.match(/<question>(.*?)<\/question>/)?.[1]?.trim() || '';
        const solutionIds = pairMatch.match(/<solution>(.*?)<\/solution>/)?.[1]?.trim() || '';

        // 校验 <question> 是纯粹的 ID 序列
        if (questionIds && !this.isIdSequence(questionIds)) {
          throw new Error(
            `Invalid format: <question> must be ID sequence. ` +
            `Found: "${questionIds.substring(0, 100)}...". ` +
            `LLM should output IDs like "10,11,12", not question text.`
          );
        }

        // 校验 <solution> 是纯粹的 ID 序列
        if (solutionIds && !this.isIdSequence(solutionIds)) {
          throw new Error(
            `Invalid format: <solution> must be ID sequence. ` +
            `Found: "${solutionIds.substring(0, 100)}...". ` +
            `LLM should output IDs like "20,21,22", not solution text.`
          );
        }

        // 通过 ID 回填问题和解答文本，同时提取关联的图片
        const { text: questionText, images: questionImages } = this.getTextAndImagesFromIds(questionIds);
        const { text: solutionText, images: solutionImages } = this.getTextAndImagesFromIds(solutionIds);

        // 构建 ExtractedQuestion 对象
        questions.push({
          label,
          type,
          chapter_title: chapterTitle,
          question: questionText,
          solution: solutionText,
          images: [...questionImages, ...solutionImages],
          page_idx: this.getFirstPageFromIds(questionIds || solutionIds),
          has_answer: solutionText.length > 0,
          // 保存原始 ID 序列用于去重和追溯
          questionIds,
          solutionIds,
          chapterTitleIds,
          chunkIndex
        });
      }
    }

    return questions;
  }

  /**
   * 宽松解析：尝试从混乱的输出中提取有用信息
   * 
   * 策略：
   * 1. 使用更宽松的正则表达式提取 <qa_pair>
   * 2. 尝试从混杂文本中提取数字ID
   * 3. 如果完全无法解析，返回空数组而不是抛出异常
   */
  private lenientParse(llmOutput: string, chunkIndex: number): ExtractedQuestion[] {
    const questions: ExtractedQuestion[] = [];

    // 尝试提取所有 <qa_pair>...</qa_pair> 块（忽略 chapter 结构）
    const pairMatches = llmOutput.match(/<qa_pair>([\s\S]*?)<\/qa_pair>/g);
    
    if (!pairMatches || pairMatches.length === 0) {
      console.warn(`[Chunk ${chunkIndex}] Lenient parse: No <qa_pair> tags found.`);
      return [];
    }

    for (const pairMatch of pairMatches) {
      try {
        const label = pairMatch.match(/<label>(.*?)<\/label>/)?.[1]?.trim() || '';
        const type = pairMatch.match(/<type>(.*?)<\/type>/)?.[1]?.trim() as 'example' | 'exercise' || 'exercise';
        const questionContent = pairMatch.match(/<question>(.*?)<\/question>/)?.[1]?.trim() || '';
        const solutionContent = pairMatch.match(/<solution>(.*?)<\/solution>/)?.[1]?.trim() || '';

        // 尝试从内容中提取 ID 序列
        const questionIds = this.extractIdsFromMixedContent(questionContent);
        const solutionIds = this.extractIdsFromMixedContent(solutionContent);

        if (!questionIds) {
          console.warn(`[Chunk ${chunkIndex}] Lenient parse: Cannot extract question IDs from: ${questionContent.substring(0, 50)}...`);
          continue;
        }

        // 通过 ID 回填文本和图片
        const { text: questionText, images: questionImages } = this.getTextAndImagesFromIds(questionIds);
        const { text: solutionText, images: solutionImages } = this.getTextAndImagesFromIds(solutionIds);

        questions.push({
          label,
          type,
          chapter_title: '',
          question: questionText,
          solution: solutionText,
          images: [...questionImages, ...solutionImages],
          page_idx: this.getFirstPageFromIds(questionIds),
          has_answer: solutionText.length > 0,
          questionIds,
          solutionIds,
          chunkIndex
        });
      } catch (error: any) {
        console.warn(`[Chunk ${chunkIndex}] Lenient parse: Failed to parse a qa_pair: ${error.message}`);
        continue;
      }
    }

    return questions;
  }

  /**
   * 从混杂内容中提取 ID 序列
   * 
   * 策略：
   * 1. 如果内容是纯 ID 序列，直接返回
   * 2. 如果内容包含数字和文本，尝试提取所有数字
   * 3. 如果完全无法提取，返回空字符串
   */
  private extractIdsFromMixedContent(content: string): string {
    if (!content || content.trim() === '') return '';

    // 如果已经是纯 ID 序列，直接返回
    if (this.isIdSequence(content)) {
      return content;
    }

    // 尝试提取所有数字（假设它们是 ID）
    const numbers = content.match(/\d+/g);
    if (numbers && numbers.length > 0) {
      return numbers.join(',');
    }

    return '';
  }

  /**
   * 校验一个字符串是否是合法的、逗号分隔的 ID 序列
   */
  private isIdSequence(ids: string): boolean {
    if (ids.trim() === '') return true;
    const normalized = ids.replace(/\s/g, '');
    return /^[\d,]+$/.test(normalized);
  }

  /**
   * 根据 ID 序列从 blocks 中提取文本
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
    }

    return textParts.join(' ').trim();
  }

  /**
   * 根据 ID 序列从 blocks 中提取文本和图片
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
        // 使用 path.join 确保路径正确
        images.push(path.join(this.imagePrefix, block.img_path));
      } else if (block.text) {
        // 只要有 text 字段就提取，支持 text, equation, table row 等
        textParts.push(block.text);
      }
    }

    return {
      text: textParts.join(' ').trim(),
      images
    };
  }

  /**
   * 从 ID 序列中获取第一个 block 的页码
   */
  private getFirstPageFromIds(ids: string): number | undefined {
    if (!ids || ids.trim() === '') return undefined;

    const firstId = parseInt(ids.split(',')[0].trim(), 10);
    const block = this.blocks.find(b => b.id === firstId);
    
    return block?.page_idx;
  }

  /**
   * 保存日志到文件
   */
  private saveLog(chunkIndex: number, stage: string, content: string): void {
    if (!this.logDir) return;

    try {
      // 确保日志目录存在
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }

      const filename = `chunk_${chunkIndex}_${stage}.log`;
      const filepath = path.join(this.logDir, filename);
      fs.writeFileSync(filepath, content, 'utf-8');
    } catch (error: any) {
      console.error(`Failed to save log: ${error.message}`);
    }
  }
}
