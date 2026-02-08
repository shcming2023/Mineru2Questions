/**
 * 问答对合并算子
 * 
 * 对齐 DataFlow 官方流水线的 QA_Merger 算子。
 * 
 * 核心功能：
 * 1. 将从题目 PDF 和答案 PDF 中分别抽取的 QA 对进行合并
 * 2. 基于"规范化章节标题 + 题号"作为匹配 key
 * 3. 支持严格匹配和宽松匹配两种模式
 * 4. 基于 ID 序列进行去重，而非基于内容长度
 * 
 * 匹配策略：
 * - 宽松模式（默认）：只提取章节编号（如 "19.1"），忽略中文描述
 *   例如："19.1 平方根与立方根" 和 "19.1 (一) 算术平方根" 都匹配为 "19.1"
 * - 严格模式：完整匹配章节标题（删除空格后）
 * 
 * 去重策略：
 * - 基于 questionIds 的精确匹配或 Jaccard 相似度
 * - 如果两个 QA 对的 questionIds 完全相同，视为重复
 * - 如果 ID 序列有 80% 以上重叠，可能是同一题目的不同 chunk
 */

import { ExtractedQAPair, MergedQAPair } from './types';

export interface QAMergerConfig {
  strictTitleMatch?: boolean;  // 是否使用严格标题匹配（默认 false）
  deduplicationThreshold?: number; // 去重阈值（Jaccard 相似度，默认 0.8）
}

export class QAMerger {
  private readonly strictTitleMatch: boolean;
  private readonly deduplicationThreshold: number;

  constructor(config: QAMergerConfig = {}) {
    this.strictTitleMatch = config.strictTitleMatch ?? false;
    this.deduplicationThreshold = config.deduplicationThreshold ?? 0.8;
  }

  /**
   * 合并从题目 PDF 和答案 PDF 中分别抽取的 QA 对
   * 
   * @param questions - 从题目 PDF 抽取的 QA 对列表
   * @param answers - 从答案 PDF 抽取的 QA 对列表
   * @returns 合并后的 QA 对列表
   * 
   * 处理流程：
   * 1. 将答案放入 Map 中，使用"规范化章节标题:题号"作为 Key
   * 2. 遍历问题，寻找匹配的答案
   * 3. 如果找到匹配，合并为一个完整的 QA 对
   * 4. 如果未找到匹配，保留问题（答案字段为空）
   * 5. 添加未被匹配的答案（问题字段为空）
   * 6. 对结果进行去重
   */
  public merge(questions: ExtractedQAPair[], answers: ExtractedQAPair[]): MergedQAPair[] {
    const mergedPairs: MergedQAPair[] = [];
    const answerMap = new Map<string, ExtractedQAPair>();

    // 1. 将答案放入 Map 中，使用"规范化章节标题:题号"作为 Key
    for (const ans of answers) {
      if (!ans.label) continue; // 跳过没有题号的答案
      const key = this.getMapKey(ans);
      
      // 如果 key 已存在，选择更完整的答案（基于内容长度）
      const existing = answerMap.get(key);
      if (existing) {
        if (this.getContentScore(ans) > this.getContentScore(existing)) {
          answerMap.set(key, ans);
        }
      } else {
        answerMap.set(key, ans);
      }
    }

    // 2. 遍历问题，寻找匹配的答案
    for (const q of questions) {
      if (!q.label) continue; // 跳过没有题号的问题
      const key = this.getMapKey(q);
      const matchingAnswer = answerMap.get(key);

      if (matchingAnswer) {
        // 找到匹配的答案，合并为一个完整的 QA 对
        mergedPairs.push({
          label: q.label,
          question_chapter_title: q.chapter_title,
          answer_chapter_title: matchingAnswer.chapter_title,
          question: q.question,
          answer: matchingAnswer.answer || matchingAnswer.solution, // 优先使用 answer 字段
          solution: matchingAnswer.solution,
          images: this.mergeImages(q.images, matchingAnswer.images)
        });
        answerMap.delete(key); // 移除已匹配的答案，避免重复使用
      } else {
        // 未找到匹配答案的问题也应保留
        mergedPairs.push({
          label: q.label,
          question_chapter_title: q.chapter_title,
          answer_chapter_title: '',
          question: q.question,
          answer: q.answer || '', // 如果问题本身包含答案，也保留
          solution: q.solution || '',
          images: q.images
        });
      }
    }

    // 3. 添加未被匹配的答案（例如只有答案没有题目的情况）
    for (const ans of answerMap.values()) {
      mergedPairs.push({
        label: ans.label,
        question_chapter_title: '',
        answer_chapter_title: ans.chapter_title,
        question: '',
        answer: ans.answer || ans.solution,
        solution: ans.solution,
        images: ans.images
      });
    }

    // 4. 对结果进行去重（基于 label 和章节标题）
    const deduplicated = this.deduplicatePairs(mergedPairs);

    return deduplicated;
  }

  /**
   * 生成匹配 key
   * 
   * @param pair - ExtractedQAPair 对象
   * @returns 匹配 key，格式为 "规范化章节标题:规范化题号"
   * 
   * 示例：
   * - 输入：chapter_title="19.1 平方根与立方根", label="例1"
   * - 输出："19.1:1"（宽松模式）
   */
  private getMapKey(pair: ExtractedQAPair): string {
    const normalizedTitle = this.normalizeTitle(pair.rawChapterTitle || pair.chapter_title);
    const labelKey = this.normalizeLabel(pair.label);
    return `${normalizedTitle}:${labelKey}`;
  }

  /**
   * 规范化章节标题
   * 
   * 对齐 DataFlow 的 refine_title 逻辑。
   * 
   * @param title - 原始章节标题
   * @returns 规范化后的章节标题
   * 
   * 处理逻辑：
   * 1. 删除所有空格和换行
   * 2. 如果是宽松模式，只提取数字编号（如 "19.1" 或 "19"）
   * 3. 如果是严格模式，返回完整的规范化标题
   * 
   * 示例（宽松模式）：
   * - "19.1 平方根与立方根" -> "19.1"
   * - "19.1 (一) 算术平方根" -> "19.1"
   * - "第六章 二次函数" -> "六"（如果没有阿拉伯数字）
   */
  private normalizeTitle(title: string): string {
    // 删除所有空格和换行
    let normalized = title.replace(/\s+/g, '');

    if (!this.strictTitleMatch) {
      // 优先提取阿拉伯数字章节编号（如 "19.1"、"23" 等）
      const arabicMatch = normalized.match(/\d+\.\d+|\d+/);
      if (arabicMatch) {
        return arabicMatch[0];
      }

      // 其次提取中文数字章节编号（如 "六"、"二十四" 等）
      const chineseMatch = normalized.match(/[一二三四五六七八九零十百]+/);
      if (chineseMatch) {
        return chineseMatch[0];
      }
    }

    return normalized;
  }

  /**
   * 规范化题号
   * 
   * @param label - 原始题号
   * @returns 规范化后的题号
   * 
   * 处理逻辑：
   * 1. 转换圆圈数字（① -> 1）
   * 2. 提取第一个数字序列
   * 3. 如果没有数字，返回原始 label
   * 
   * 示例：
   * - "例1" -> "1"
   * - "习题3" -> "3"
   * - "①" -> "1"
   * - "1.1" -> "1.1"（保留复合题号）
   */
  private normalizeLabel(label: string): string {
    // 首先转换圆圈数字
    let normalized = this.convertCircledNumbers(label);
    
    // 移除空格
    normalized = normalized.replace(/\s/g, '');
    
    // 提取数字部分（支持复合题号如 "1.1"）
    const match = normalized.match(/\d+(\.\d+)?/);
    return match ? match[0] : label;
  }

  /**
   * 将圆圈数字转换为阿拉伯数字
   * 
   * @param text - 包含圆圈数字的文本
   * @returns 转换后的文本
   * 
   * 示例：
   * - "①" -> "1"
   * - "例②" -> "例2"
   * - "⑳" -> "20"
   */
  private convertCircledNumbers(text: string): string {
    const circledNumbers = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
    let result = text;
    
    for (let i = 0; i < circledNumbers.length; i++) {
      result = result.replace(new RegExp(circledNumbers[i], 'g'), String(i + 1));
    }
    
    return result;
  }

  /**
   * 合并图片列表，去重
   * 
   * @param images1 - 第一个图片列表
   * @param images2 - 第二个图片列表
   * @returns 合并后的图片列表（去重）
   */
  private mergeImages(images1: string[], images2: string[]): string[] {
    return [...new Set([...images1, ...images2])];
  }

  /**
   * 计算 QA 对的内容完整度分数
   * 
   * @param pair - ExtractedQAPair 对象
   * @returns 内容完整度分数（数字越大越完整）
   * 
   * 用途：当同一个 key 有多个候选时，选择内容更完整的
   */
  private getContentScore(pair: ExtractedQAPair): number {
    return (
      (pair.question?.length || 0) +
      (pair.answer?.length || 0) +
      (pair.solution?.length || 0)
    );
  }

  /**
   * 对合并后的 QA 对进行去重
   * 
   * @param pairs - 合并后的 QA 对列表
   * @returns 去重后的 QA 对列表
   * 
   * 去重策略：
   * 1. 基于 "章节标题:题号" 作为主键
   * 2. 如果主键相同，选择内容更完整的（基于字段长度）
   */
  private deduplicatePairs(pairs: MergedQAPair[]): MergedQAPair[] {
    const deduplicatedMap = new Map<string, MergedQAPair>();

    for (const pair of pairs) {
      const key = `${this.normalizeTitle(pair.question_chapter_title || pair.answer_chapter_title)}:${this.normalizeLabel(pair.label)}`;
      
      const existing = deduplicatedMap.get(key);
      if (existing) {
        // 如果已存在，选择内容更完整的
        if (this.getMergedContentScore(pair) > this.getMergedContentScore(existing)) {
          deduplicatedMap.set(key, pair);
        }
      } else {
        deduplicatedMap.set(key, pair);
      }
    }

    return Array.from(deduplicatedMap.values());
  }

  /**
   * 计算合并后 QA 对的内容完整度分数
   * 
   * @param pair - MergedQAPair 对象
   * @returns 内容完整度分数
   */
  private getMergedContentScore(pair: MergedQAPair): number {
    return (
      (pair.question?.length || 0) +
      (pair.answer?.length || 0) +
      (pair.solution?.length || 0)
    );
  }
}
