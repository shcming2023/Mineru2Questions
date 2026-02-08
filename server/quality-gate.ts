/**
 * 质量门与回退机制
 * 
 * 对齐 DataFlow 官方流水线的质量评估和容错策略。
 * 
 * 核心功能：
 * 1. 在解析 LLM 输出之前，校验基本的 XML 结构
 * 2. 在合并 QA 对之后，校验数据完整性
 * 3. 提供回退机制，当主方案失败时启用备用方案
 * 4. 记录详细的质量指标，便于分析和优化
 * 
 * 质量门类型：
 * - Pre-Parse Gate：解析前的结构校验
 * - Post-Parse Gate：解析后的内容校验
 * - Post-Merge Gate：合并后的完整性校验
 * 
 * 回退策略：
 * - Skip：跳过错误的数据块，继续处理下一个
 * - Loosen：放宽约束，尝试解析部分内容
 * - Fallback：调用备用 LLM 或 VQA 提取逻辑
 */

import { ExtractedQAPair, MergedQAPair, StageLog } from './types';

/**
 * 质量门配置
 */
export interface QualityGateConfig {
  enablePreParseGate?: boolean;   // 是否启用解析前校验（默认 true）
  enablePostParseGate?: boolean;  // 是否启用解析后校验（默认 true）
  enablePostMergeGate?: boolean;  // 是否启用合并后校验（默认 true）
  minQuestionLength?: number;     // 问题最小长度（默认 5）
  minAnswerLength?: number;       // 答案最小长度（默认 1）
  logCallback?: (log: StageLog) => void; // 日志回调函数
}

/**
 * 质量门结果
 */
export interface QualityGateResult {
  passed: boolean;          // 是否通过质量门
  reason?: string;          // 未通过的原因
  metrics?: Record<string, any>; // 质量指标
}

/**
 * 质量门类
 */
export class QualityGate {
  private readonly config: Required<QualityGateConfig>;

  constructor(config: QualityGateConfig = {}) {
    this.config = {
      enablePreParseGate: config.enablePreParseGate ?? true,
      enablePostParseGate: config.enablePostParseGate ?? true,
      enablePostMergeGate: config.enablePostMergeGate ?? true,
      minQuestionLength: config.minQuestionLength ?? 5,
      minAnswerLength: config.minAnswerLength ?? 1,
      logCallback: config.logCallback ?? (() => {})
    };
  }

  /**
   * 解析前的结构校验（Pre-Parse Gate）
   * 
   * @param llmOutput - LLM 原始输出
   * @param chunkIndex - 数据块索引
   * @returns 质量门结果
   * 
   * 校验内容：
   * 1. 输出不为空
   * 2. 包含基本的 XML 标签（<chapter>、<qa_pair>）
   * 3. 标签是否闭合（简单检查）
   */
  public validatePreParse(llmOutput: string, chunkIndex: number): QualityGateResult {
    if (!this.config.enablePreParseGate) {
      return { passed: true };
    }

    // 1. 检查是否为空或只包含 <empty>
    if (!llmOutput || llmOutput.trim() === '') {
      return {
        passed: false,
        reason: 'LLM output is empty'
      };
    }

    if (llmOutput.includes('<empty>')) {
      // <empty> 是合法的输出，表示没有内容
      return { passed: true };
    }

    // 2. 检查是否包含基本的 XML 标签
    const hasChapter = llmOutput.includes('<chapter>') && llmOutput.includes('</chapter>');
    const hasPair = llmOutput.includes('<qa_pair>') && llmOutput.includes('</qa_pair>');

    if (!hasChapter || !hasPair) {
      return {
        passed: false,
        reason: 'Missing required XML tags (<chapter> or <qa_pair>)'
      };
    }

    // 3. 简单检查标签是否闭合
    const openChapterCount = (llmOutput.match(/<chapter>/g) || []).length;
    const closeChapterCount = (llmOutput.match(/<\/chapter>/g) || []).length;
    const openPairCount = (llmOutput.match(/<qa_pair>/g) || []).length;
    const closePairCount = (llmOutput.match(/<\/qa_pair>/g) || []).length;

    if (openChapterCount !== closeChapterCount || openPairCount !== closePairCount) {
      return {
        passed: false,
        reason: 'XML tags are not properly closed'
      };
    }

    // 记录日志
    this.logStage('pre_parse_gate', chunkIndex, {
      passed: true,
      output_length: llmOutput.length,
      chapter_count: openChapterCount,
      pair_count: openPairCount
    });

    return { passed: true };
  }

  /**
   * 解析后的内容校验（Post-Parse Gate）
   * 
   * @param pairs - 解析后的 QA 对列表
   * @param chunkIndex - 数据块索引
   * @returns 质量门结果
   * 
   * 校验内容：
   * 1. 至少解析出一个 QA 对
   * 2. 每个 QA 对至少有 question 或 answer/solution 之一
   * 3. 统计质量指标（空字段比例、平均长度等）
   */
  public validatePostParse(pairs: ExtractedQAPair[], chunkIndex: number): QualityGateResult {
    if (!this.config.enablePostParseGate) {
      return { passed: true };
    }

    // 1. 检查是否至少解析出一个 QA 对
    if (pairs.length === 0) {
      return {
        passed: false,
        reason: 'No QA pairs were parsed from LLM output'
      };
    }

    // 2. 统计质量指标
    let emptyQuestionCount = 0;
    let emptyAnswerCount = 0;
    let emptyBothCount = 0;
    let totalQuestionLength = 0;
    let totalAnswerLength = 0;

    for (const pair of pairs) {
      const hasQuestion = pair.question && pair.question.trim().length > 0;
      const hasAnswer = (pair.answer && pair.answer.trim().length > 0) || 
                        (pair.solution && pair.solution.trim().length > 0);

      if (!hasQuestion) emptyQuestionCount++;
      if (!hasAnswer) emptyAnswerCount++;
      if (!hasQuestion && !hasAnswer) emptyBothCount++;

      totalQuestionLength += pair.question?.length || 0;
      totalAnswerLength += (pair.answer?.length || 0) + (pair.solution?.length || 0);
    }

    // 3. 如果所有 QA 对都是空的，视为失败
    if (emptyBothCount === pairs.length) {
      return {
        passed: false,
        reason: 'All parsed QA pairs are empty (no question and no answer)'
      };
    }

    // 记录日志
    this.logStage('post_parse_gate', chunkIndex, {
      passed: true,
      total_pairs: pairs.length,
      empty_question_count: emptyQuestionCount,
      empty_answer_count: emptyAnswerCount,
      empty_both_count: emptyBothCount,
      avg_question_length: totalQuestionLength / pairs.length,
      avg_answer_length: totalAnswerLength / pairs.length
    });

    return { passed: true };
  }

  /**
   * 合并后的完整性校验（Post-Merge Gate）
   * 
   * @param pairs - 合并后的 QA 对列表
   * @returns 质量门结果
   * 
   * 校验内容：
   * 1. 统计完整 QA 对的比例
   * 2. 统计只有问题或只有答案的比例
   * 3. 过滤掉完全空的 QA 对
   */
  public validatePostMerge(pairs: MergedQAPair[]): QualityGateResult {
    if (!this.config.enablePostMergeGate) {
      return { passed: true };
    }

    let completeCount = 0;
    let questionOnlyCount = 0;
    let answerOnlyCount = 0;
    let emptyCount = 0;

    for (const pair of pairs) {
      const hasQuestion = pair.question && pair.question.trim().length >= this.config.minQuestionLength;
      const hasAnswer = (pair.answer && pair.answer.trim().length >= this.config.minAnswerLength) ||
                        (pair.solution && pair.solution.trim().length >= this.config.minAnswerLength);

      if (hasQuestion && hasAnswer) {
        completeCount++;
      } else if (hasQuestion) {
        questionOnlyCount++;
      } else if (hasAnswer) {
        answerOnlyCount++;
      } else {
        emptyCount++;
      }
    }

    // 记录日志
    this.logStage('post_merge_gate', 0, {
      passed: true,
      total_pairs: pairs.length,
      complete_count: completeCount,
      question_only_count: questionOnlyCount,
      answer_only_count: answerOnlyCount,
      empty_count: emptyCount,
      complete_ratio: completeCount / pairs.length
    });

    return { passed: true };
  }

  /**
   * 过滤低质量的 QA 对
   * 
   * @param pairs - 合并后的 QA 对列表
   * @returns 过滤后的 QA 对列表
   * 
   * 过滤规则：
   * 1. 问题和答案都为空的 QA 对
   * 2. 问题长度小于最小长度且答案为空的 QA 对
   */
  public filterLowQualityPairs(pairs: MergedQAPair[]): MergedQAPair[] {
    return pairs.filter(pair => {
      const hasQuestion = pair.question && pair.question.trim().length >= this.config.minQuestionLength;
      const hasAnswer = (pair.answer && pair.answer.trim().length >= this.config.minAnswerLength) ||
                        (pair.solution && pair.solution.trim().length >= this.config.minAnswerLength);

      // 至少有问题或答案之一
      return hasQuestion || hasAnswer;
    });
  }

  /**
   * 记录阶段日志
   */
  private logStage(stage: string, chunkIndex: number, metrics: Record<string, any>) {
    const log: StageLog = {
      taskId: 'current',
      stage,
      timestamp: Date.now(),
      metrics: {
        chunk_index: chunkIndex,
        ...metrics
      }
    };
    this.config.logCallback(log);
  }
}

/**
 * 校验 XML 结构的辅助函数
 * 
 * @param output - LLM 输出
 * @returns 是否是合法的 XML 结构
 * 
 * 这是一个简化版的校验函数，用于快速检查基本结构。
 * 生产环境中可使用更可靠的 XML 解析库。
 */
export function isValidXMLStructure(output: string): boolean {
  if (!output || output.trim() === '') return false;
  if (output.includes('<empty>')) return true;

  const hasChapter = output.includes('<chapter>') && output.includes('</chapter>');
  const hasPair = output.includes('<qa_pair>') && output.includes('</qa_pair>');

  return hasChapter && hasPair;
}

/**
 * 回退策略处理器
 * 
 * 当主方案失败时，决定采取什么回退策略。
 */
export class FallbackHandler {
  /**
   * 处理解析失败的情况
   * 
   * @param error - 错误对象
   * @param chunkIndex - 数据块索引
   * @param strategy - 回退策略
   * @returns 是否应该跳过该数据块
   * 
   * 策略：
   * - 'skip'：跳过该数据块，继续处理下一个
   * - 'loosen'：放宽约束，尝试部分解析（未来实现）
   * - 'fallback'：调用备用 LLM 或 VQA 提取（未来实现）
   */
  public handleParseFailure(
    error: Error,
    chunkIndex: number,
    strategy: 'skip' | 'loosen' | 'fallback' = 'skip'
  ): boolean {
    console.error(`[FallbackHandler] Parse failed for chunk ${chunkIndex}:`, error.message);

    switch (strategy) {
      case 'skip':
        console.warn(`[FallbackHandler] Skipping chunk ${chunkIndex}`);
        return true; // 跳过该数据块

      case 'loosen':
        console.warn(`[FallbackHandler] Loosen strategy not implemented yet. Skipping chunk ${chunkIndex}`);
        return true;

      case 'fallback':
        console.warn(`[FallbackHandler] Fallback strategy not implemented yet. Skipping chunk ${chunkIndex}`);
        return true;

      default:
        return true;
    }
  }

  /**
   * 处理 LLM 调用失败的情况
   * 
   * @param error - 错误对象
   * @param chunkIndex - 数据块索引
   * @param retryCount - 已重试次数
   * @param maxRetries - 最大重试次数
   * @returns 是否应该重试
   */
  public handleLLMFailure(
    error: Error,
    chunkIndex: number,
    retryCount: number,
    maxRetries: number
  ): boolean {
    console.error(`[FallbackHandler] LLM call failed for chunk ${chunkIndex} (retry ${retryCount}/${maxRetries}):`, error.message);

    if (retryCount < maxRetries) {
      console.warn(`[FallbackHandler] Retrying chunk ${chunkIndex}...`);
      return true; // 重试
    } else {
      console.error(`[FallbackHandler] Max retries reached for chunk ${chunkIndex}. Skipping.`);
      return false; // 不再重试，跳过
    }
  }
}
