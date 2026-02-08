/**
 * 共享类型定义文件
 * 
 * 本文件定义了 Mineru2Questions 项目中所有核心数据结构。
 * 对齐 DataFlow 官方流水线的类型约定。
 * 
 * 主要类型分类：
 * 1. MinerU 输入/输出类型
 * 2. LLM 配置与结果类型
 * 3. 抽取的 QA 对类型
 * 4. 合并后的 QA 对类型
 */

// ============= MinerU 相关类型 =============

/**
 * MinerU content_list.json 中的原始内容块类型
 * 
 * 这是 MinerU 输出的标准格式，包含文本、图片、表格、公式等多种类型。
 */
export interface ContentBlock {
  type: string;           // 类型: text, image, table, equation, list, header, footer 等
  text?: string;          // 文本内容
  img_path?: string;      // 图片相对路径
  image_caption?: string[]; // 图片标题
  image_footnote?: string[]; // 图片脚注
  page_idx?: number;      // 页码索引 (从 0 开始)
  bbox?: number[];        // 边界框 [x0, y0, x1, y1]
  list_items?: string[];  // 列表项 (type=list 时)
  sub_type?: string;      // 子类型
  text_level?: number;    // 文本层级 (用于标题)
}

/**
 * 转换后的 LLM 输入格式
 * 
 * 对齐 DataFlow 的 MinerU2LLMInputOperator 输出格式。
 * 每个 block 都有唯一的 ID，用于 LLM 输出引用。
 */
export interface ConvertedBlock {
  id: number;             // 唯一 ID (从 0 开始递增)
  type: string;           // 类型: text, image, table, equation 等
  text?: string;          // 文本内容
  img_path?: string;      // 图片相对路径
  image_caption?: string; // 图片标题 (合并为单个字符串)
  page_idx?: number;      // 页码索引
}

// ============= LLM 配置与结果类型 =============

/**
 * LLM 配置
 * 
 * 包含 API 调用所需的所有参数，以及容错配置。
 */
export interface LLMConfig {
  apiUrl: string;         // LLM API 地址
  apiKey: string;         // API 密钥
  modelName: string;      // 模型名称
  maxWorkers: number;     // 最大并发数
  timeout: number;        // 超时时间 (秒)
  maxRetries?: number;    // 最大重试次数
  onSoftFail?: 'skip' | 'loosen' | 'default'; // 软失败处理策略
}

/**
 * LLM 调用结果
 * 
 * 用于在流水线中传递 LLM 的原始输出。
 */
export interface LLMResult {
  chunkIndex: number;     // 数据块索引
  output: string;         // LLM 原始输出 (XML 格式)
  success: boolean;       // 是否成功
  error?: string;         // 错误信息 (如果失败)
}

// ============= 抽取的 QA 对类型 =============

/**
 * 从 LLM 输出中抽取的 QA 对
 * 
 * 对齐 DataFlow 的 LLMOutputParser 输出格式。
 * 关键约束：question 和 solution 必须通过 ID 回填，不能是自由文本。
 */
export interface ExtractedQAPair {
  label: string;                // 题号 (如 "1", "例1", "习题3")
  question: string;             // 问题文本 (通过 questionIds 回填)
  answer: string;               // 答案 (可以是短文本)
  solution: string;             // 解答过程 (通过 solutionIds 回填)
  chapter_title: string;        // 章节标题 (通过 chapterTitleIds 回填)
  images: string[];             // 关联图片路径列表
  
  // 用于追溯和去重的元数据
  questionIds?: string;         // 问题的 ID 序列 (如 "10,11,12")
  solutionIds?: string;         // 解答的 ID 序列 (如 "20,21,22")
  chapterTitleIds?: string;     // 章节标题的 ID 序列
  chunkIndex?: number;          // 来源数据块索引
  sourcePageIndex?: number;     // 来源页码
  rawChapterTitle?: string;     // 原始章节标题 (未规范化)
}

// ============= 合并后的 QA 对类型 =============

/**
 * 合并后的完整 QA 对
 * 
 * 对齐 DataFlow 的 QA_Merger 输出格式。
 * 用于最终输出到 JSON/Markdown 文件。
 */
export interface MergedQAPair {
  label: string;                    // 题号
  question_chapter_title: string;   // 问题所在章节标题
  answer_chapter_title: string;     // 答案所在章节标题
  question: string;                 // 问题文本
  answer: string;                   // 答案文本
  solution: string;                 // 解答过程
  images: string[];                 // 关联图片路径列表
}

// ============= 任务与流程类型 =============

/**
 * 处理任务配置
 * 
 * 定义一个完整的 PDF 到 QA 对的抽取任务。
 */
export interface Task {
  id: string;                       // 任务 ID
  questionContentListPath: string;  // 问题 PDF 的 content_list.json 路径
  answerContentListPath: string;    // 答案 PDF 的 content_list.json 路径
  imagePrefix: string;              // 图片路径前缀
  outputDir: string;                // 输出目录
}

/**
 * 数据块 (Chunk)
 * 
 * 用于将大文档切分为多个小块，控制 LLM 输入 token 数量。
 */
export interface Chunk {
  index: number;                    // 块索引
  blocks: ConvertedBlock[];         // 包含的 block 列表
  startId: number;                  // 起始 ID
  endId: number;                    // 结束 ID
}

// ============= 审计日志类型 =============

/**
 * 审计日志回调函数类型
 * 
 * 用于记录流水线每个阶段的处理情况。
 */
export type AuditLogFn = (
  stage: string,              // 阶段名称
  inputLen: number,           // 输入长度
  outputLen: number,          // 输出长度
  rejectReason: string | null, // 拒绝原因 (如果有)
  fallbackUsed: boolean,      // 是否使用了回退机制
  timestamp: number           // 时间戳
) => void;

/**
 * 阶段日志
 * 
 * 用于记录流水线每个阶段的详细指标。
 */
export interface StageLog {
  taskId: string;             // 任务 ID
  stage: string;              // 阶段名称
  timestamp: number;          // 时间戳
  metrics: Record<string, any>; // 指标数据
}
