/**
 * 核心流水线模块
 * 
 * 对齐 DataFlow 官方流水线的 forward 模式。
 * 将整个 PDF 到 QA 对的抽取过程分解为一系列独立的、可测试的算子。
 * 
 * 流水线阶段：
 * 1. Input Formatting：加载并格式化 MinerU 输出
 * 2. LLM Extraction：调用 LLM 进行抽取
 * 3. Output Parsing：解析 LLM 输出（强制 ID-Only）
 * 4. QA Merging：合并问题和答案
 * 5. Quality Filtering：过滤低质量数据
 * 
 * 设计原则：
 * - 每个阶段都有明确的输入输出
 * - 每个阶段都可以独立测试和替换
 * - 使用质量门进行校验和容错
 * - 提供详细的日志和指标
 */

import {
  ConvertedBlock,
  ExtractedQAPair,
  MergedQAPair,
  LLMConfig,
  LLMResult,
  Chunk,
  StageLog
} from './types';
import { LLMOutputParser } from './llm-output-parser';
import { QAMerger } from './qa-merger';
import { QualityGate, FallbackHandler, isValidXMLStructure } from './quality-gate';

/**
 * 流水线配置
 */
export interface PipelineConfig {
  llmConfig: LLMConfig;           // LLM 配置
  imagePrefix: string;            // 图片路径前缀
  chunkSize?: number;             // 每个 chunk 的 block 数量（默认 50）
  chunkOverlap?: number;          // chunk 之间的重叠 block 数量（默认 5）
  strictTitleMatch?: boolean;     // 是否使用严格标题匹配（默认 false）
  enableQualityGate?: boolean;    // 是否启用质量门（默认 true）
  logCallback?: (log: StageLog) => void; // 日志回调函数
}

/**
 * 流水线结果
 */
export interface PipelineResult {
  mergedPairs: MergedQAPair[];    // 合并后的 QA 对列表
  metrics: PipelineMetrics;       // 流水线指标
}

/**
 * 流水线指标
 */
export interface PipelineMetrics {
  totalBlocks: number;            // 总 block 数
  totalChunks: number;            // 总 chunk 数
  successfulChunks: number;       // 成功处理的 chunk 数
  failedChunks: number;           // 失败的 chunk 数
  extractedQuestions: number;     // 抽取的问题数
  extractedAnswers: number;       // 抽取的答案数
  mergedPairs: number;            // 合并后的 QA 对数
  filteredPairs: number;          // 过滤掉的低质量 QA 对数
  totalTime: number;              // 总耗时（毫秒）
}

/**
 * 核心流水线类
 */
export class ExtractionPipeline {
  private readonly config: Required<PipelineConfig>;
  private readonly qualityGate: QualityGate;
  private readonly fallbackHandler: FallbackHandler;

  constructor(config: PipelineConfig) {
    this.config = {
      llmConfig: config.llmConfig,
      imagePrefix: config.imagePrefix,
      chunkSize: config.chunkSize ?? 50,
      chunkOverlap: config.chunkOverlap ?? 5,
      strictTitleMatch: config.strictTitleMatch ?? false,
      enableQualityGate: config.enableQualityGate ?? true,
      logCallback: config.logCallback ?? (() => {})
    };

    this.qualityGate = new QualityGate({
      enablePreParseGate: this.config.enableQualityGate,
      enablePostParseGate: this.config.enableQualityGate,
      enablePostMergeGate: this.config.enableQualityGate,
      logCallback: this.config.logCallback
    });

    this.fallbackHandler = new FallbackHandler();
  }

  /**
   * 执行完整的抽取流水线
   * 
   * @param questionBlocks - 问题 PDF 的 ConvertedBlock 列表
   * @param answerBlocks - 答案 PDF 的 ConvertedBlock 列表（可选）
   * @returns 流水线结果
   */
  public async run(
    questionBlocks: ConvertedBlock[],
    answerBlocks?: ConvertedBlock[]
  ): Promise<PipelineResult> {
    const startTime = Date.now();

    this.logStage('pipeline_start', {
      question_blocks: questionBlocks.length,
      answer_blocks: answerBlocks?.length || 0
    });

    // 阶段 1: 切分数据块
    const questionChunks = this.chunkBlocks(questionBlocks);
    const answerChunks = answerBlocks ? this.chunkBlocks(answerBlocks) : [];

    this.logStage('chunking_complete', {
      question_chunks: questionChunks.length,
      answer_chunks: answerChunks.length
    });

    // 阶段 2: LLM 抽取（并行处理问题和答案）
    const [extractedQuestions, extractedAnswers] = await Promise.all([
      this.extractFromChunks(questionChunks, questionBlocks, 'question'),
      answerChunks.length > 0
        ? this.extractFromChunks(answerChunks, answerBlocks!, 'answer')
        : Promise.resolve([])
    ]);

    this.logStage('extraction_complete', {
      extracted_questions: extractedQuestions.length,
      extracted_answers: extractedAnswers.length
    });

    // 阶段 3: 问答对合并
    const merger = new QAMerger({ strictTitleMatch: this.config.strictTitleMatch });
    let mergedPairs = merger.merge(extractedQuestions, extractedAnswers);

    this.logStage('merging_complete', {
      merged_pairs: mergedPairs.length
    });

    // 阶段 4: 质量评估与过滤
    const beforeFilterCount = mergedPairs.length;
    const qualityResult = this.qualityGate.validatePostMerge(mergedPairs);
    
    if (qualityResult.passed) {
      mergedPairs = this.qualityGate.filterLowQualityPairs(mergedPairs);
    }

    const filteredCount = beforeFilterCount - mergedPairs.length;

    this.logStage('filtering_complete', {
      before_filter: beforeFilterCount,
      after_filter: mergedPairs.length,
      filtered_count: filteredCount
    });

    // 构建指标
    const metrics: PipelineMetrics = {
      totalBlocks: questionBlocks.length + (answerBlocks?.length || 0),
      totalChunks: questionChunks.length + answerChunks.length,
      successfulChunks: questionChunks.length + answerChunks.length, // 简化版，未来可细化
      failedChunks: 0,
      extractedQuestions: extractedQuestions.length,
      extractedAnswers: extractedAnswers.length,
      mergedPairs: mergedPairs.length,
      filteredPairs: filteredCount,
      totalTime: Date.now() - startTime
    };

    this.logStage('pipeline_complete', metrics);

    return { mergedPairs, metrics };
  }

  /**
   * 切分数据块
   * 
   * @param blocks - ConvertedBlock 列表
   * @returns Chunk 列表
   */
  private chunkBlocks(blocks: ConvertedBlock[]): Chunk[] {
    const chunks: Chunk[] = [];
    const chunkSize = this.config.chunkSize;
    const overlap = this.config.chunkOverlap;

    for (let i = 0; i < blocks.length; i += chunkSize - overlap) {
      const chunkBlocks = blocks.slice(i, i + chunkSize);
      if (chunkBlocks.length === 0) break;

      chunks.push({
        index: chunks.length,
        blocks: chunkBlocks,
        startId: chunkBlocks[0].id,
        endId: chunkBlocks[chunkBlocks.length - 1].id
      });

      // 如果已经到达末尾，停止
      if (i + chunkSize >= blocks.length) break;
    }

    return chunks;
  }

  /**
   * 从数据块列表中抽取 QA 对
   * 
   * @param chunks - Chunk 列表
   * @param allBlocks - 完整的 ConvertedBlock 列表（用于 ID 回填）
   * @param mode - 抽取模式（question 或 answer）
   * @returns ExtractedQAPair 列表
   */
  private async extractFromChunks(
    chunks: Chunk[],
    allBlocks: ConvertedBlock[],
    mode: 'question' | 'answer'
  ): Promise<ExtractedQAPair[]> {
    const allPairs: ExtractedQAPair[] = [];

    for (const chunk of chunks) {
      try {
        // 调用 LLM
        const llmOutput = await this.callLLM(chunk, mode);

        // 质量门：解析前校验
        const preParseResult = this.qualityGate.validatePreParse(llmOutput, chunk.index);
        if (!preParseResult.passed) {
          console.warn(`[Pipeline] Chunk ${chunk.index} failed pre-parse gate: ${preParseResult.reason}`);
          continue; // 跳过该 chunk
        }

        // 解析 LLM 输出
        const parser = new LLMOutputParser(allBlocks, this.config.imagePrefix);
        const pairs = parser.parse(llmOutput, chunk.index);

        // 质量门：解析后校验
        const postParseResult = this.qualityGate.validatePostParse(pairs, chunk.index);
        if (!postParseResult.passed) {
          console.warn(`[Pipeline] Chunk ${chunk.index} failed post-parse gate: ${postParseResult.reason}`);
          continue; // 跳过该 chunk
        }

        allPairs.push(...pairs);

      } catch (error: any) {
        // 使用回退处理器决定是否跳过
        const shouldSkip = this.fallbackHandler.handleParseFailure(
          error,
          chunk.index,
          this.config.llmConfig.onSoftFail || 'skip'
        );

        if (shouldSkip) {
          continue; // 跳过该 chunk
        }
      }
    }

    return allPairs;
  }

  /**
   * 调用 LLM（占位符，需要与现有 LLM 调用逻辑集成）
   * 
   * @param chunk - 数据块
   * @param mode - 抽取模式
   * @returns LLM 输出字符串
   */
  private async callLLM(chunk: Chunk, mode: 'question' | 'answer'): Promise<string> {
    // 这里需要调用现有的 LLM 调用逻辑
    // 暂时返回占位符，后续集成时替换
    throw new Error('LLM call not implemented yet. Please integrate with existing callLLMForTextExtraction function.');
  }

  /**
   * 记录阶段日志
   */
  private logStage(stage: string, metrics: Record<string, any>) {
    const log: StageLog = {
      taskId: 'pipeline',
      stage,
      timestamp: Date.now(),
      metrics
    };
    this.config.logCallback(log);
  }
}

/**
 * 便捷函数：运行完整的抽取流水线
 * 
 * @param questionBlocks - 问题 PDF 的 ConvertedBlock 列表
 * @param answerBlocks - 答案 PDF 的 ConvertedBlock 列表（可选）
 * @param config - 流水线配置
 * @returns 流水线结果
 */
export async function runExtractionPipeline(
  questionBlocks: ConvertedBlock[],
  answerBlocks: ConvertedBlock[] | undefined,
  config: PipelineConfig
): Promise<PipelineResult> {
  const pipeline = new ExtractionPipeline(config);
  return pipeline.run(questionBlocks, answerBlocks);
}
