# Mineru2Questions 项目代码改进方案

## 概述

本文档提供基于 OpenDCAI/DataFlow 官方最佳实践的 TypeScript 代码改进方案。所有改进方案均可直接落地到现有项目中,遵循以下原则:

1. **严格对齐官方流水线**的职责划分和数据流
2. **LLM 只输出 ID 引用**,文本只通过 ID 回填
3. **不靠硬编码特例**,使用可泛化的信号
4. **增强可观测性**,提供清晰的日志和中间产物
5. **TypeScript/Node.js/SQLite** 环境可直接运行

---

## 改进 1: 移除输入阶段的过严过滤

### 问题定位

**当前阶段**: 输入格式化与标准化 (对应官方 `MinerU2LLMInputOperator`)

**问题描述**: `convertContentList()` 函数在输入阶段使用 `isTocList()` 过滤目录列表,可能误判选项列表 (A. B. C. D.) 导致选择题选项丢失。

**官方做法**: 不在输入阶段过滤,而是依赖 LLM 提示词和后处理阶段过滤。

### 改进代码

**文件**: `server/extraction.ts`

**修改前** (当前实现):
```typescript
export function convertContentList(blocks: ContentBlock[]): ConvertedBlock[] {
  const converted: ConvertedBlock[] = [];
  let id = 0;
  
  for (const block of blocks) {
    // 问题: 在输入阶段过滤目录
    if (block.type === 'list' && isTocList(block.list_items || [])) {
      continue; // 可能误判选项列表
    }
    
    if (block.type === 'list' && block.sub_type === 'text') {
      for (const item of block.list_items || []) {
        converted.push({ id: id++, type: 'text', text: item });
      }
    } else {
      converted.push({
        id: id++,
        type: block.type,
        text: block.text,
        img_path: block.img_path,
        image_caption: block.image_caption?.join(' ')
      });
    }
  }
  return converted;
}
```

**修改后** (对齐官方):
```typescript
/**
 * 将 MinerU 的 content_list.json 转换为 LLM 输入格式
 * 对齐 DataFlow 的 MinerU2LLMInputOperator
 * 
 * 关键改进:
 * 1. 移除输入阶段的目录过滤 (isTocList)
 * 2. 展平 list 类型的 list_items
 * 3. 重新分配连续 ID
 * 4. 移除 bbox 和 page_idx 减少 token 消耗
 */
export function convertContentList(blocks: ContentBlock[]): ConvertedBlock[] {
  const converted: ConvertedBlock[] = [];
  let id = 0;
  
  for (const block of blocks) {
    // 展平 list 类型 (不再过滤目录)
    if (block.type === 'list' && block.sub_type === 'text') {
      for (const item of block.list_items || []) {
        converted.push({ 
          id: id++, 
          type: 'text', 
          text: item 
        });
      }
    } else {
      // 保留其他类型
      converted.push({
        id: id++,
        type: block.type,
        text: block.text,
        img_path: block.img_path,
        image_caption: block.image_caption?.join(' ')
      });
    }
  }
  
  return converted;
}
```

**后处理过滤** (在 `parseLLMOutput()` 中增加):
```typescript
/**
 * 判断是否为目录条目 (后处理阶段)
 * 
 * 目录条目特征:
 * 1. 以页码数字结尾 (如 "19.1 算术平方根(1) 2")
 * 2. 长度较短 (< 100 字符)
 * 3. 包含章节编号模式
 * 
 * 注意: 不会误判选项列表,因为选项列表通常较长且不以页码结尾
 */
function isTocEntry(question: string): boolean {
  if (question.length > 100) return false;
  
  // 匹配 "数字.数字 + 中文 + (数字) + 页码" 模式
  // 例: "19.1 算术平方根(1) 2"
  const tocPattern1 = /^\d+\.\d+\s+[\u4e00-\u9fff]+\(\d+\)\s+\d{1,3}$/;
  if (tocPattern1.test(question.trim())) return true;
  
  // 匹配 "中文 + (数字) + 页码" 模式
  // 例: "算术平方根(1) 2"
  const tocPattern2 = /^[\u4e00-\u9fff]+\(\d+\)\s+\d{1,3}$/;
  if (tocPattern2.test(question.trim())) return true;
  
  return false;
}

// 在 parseLLMOutput() 的最后增加过滤
export function parseLLMOutput(
  output: string, 
  blocks: ConvertedBlock[],
  imagePrefix: string = "images",
  mode: 'question' | 'answer' = 'question'
): ExtractedQAPair[] {
  // ... 现有的解析逻辑 ...
  
  // 后处理过滤: 移除目录条目
  qaPairs = qaPairs.filter(qa => !isTocEntry(qa.question));
  
  return qaPairs;
}
```

**日志增强** (用于诊断):
```typescript
export function convertContentList(
  blocks: ContentBlock[],
  logPath?: string // 可选: 日志文件路径
): ConvertedBlock[] {
  const converted: ConvertedBlock[] = [];
  const skippedLists: Array<{ index: number; items: string[] }> = [];
  let id = 0;
  
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    
    if (block.type === 'list' && block.sub_type === 'text') {
      // 记录被展平的 list (用于诊断)
      if (logPath) {
        console.log(`[convertContentList] Flattening list at index ${i}: ${block.list_items?.length || 0} items`);
      }
      
      for (const item of block.list_items || []) {
        converted.push({ id: id++, type: 'text', text: item });
      }
    } else {
      converted.push({
        id: id++,
        type: block.type,
        text: block.text,
        img_path: block.img_path,
        image_caption: block.image_caption?.join(' ')
      });
    }
  }
  
  // 保存日志
  if (logPath) {
    const log = {
      totalBlocks: blocks.length,
      convertedBlocks: converted.length,
      timestamp: new Date().toISOString()
    };
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
  }
  
  return converted;
}
```

---

## 改进 2: 简化合并索引结构

### 问题定位

**当前阶段**: 问答对合并与去重 (对应官方 `QA_Merger`)

**问题描述**: `mergeQAPairs()` 函数使用三层索引结构 (`questionByIds`, `questionMapExact`, `questionMapFuzzy`),偏离官方的简单 `(chapter_title, label)` 索引,且缺失字段级别的增量更新。

**官方做法**: 只使用 `(chapter_title, label)` 作为唯一键,并在 answer 阶段进行字段级别的增量更新。

### 改进代码

**文件**: `server/extraction.ts`

**完整重构** (对齐官方 `merge_qa_pair`):
```typescript
/**
 * 合并问题和答案列表
 * 严格对齐 DataFlow 的 merge_qa_pair 实现
 * 
 * 关键改进:
 * 1. 移除三层索引,简化为单层索引 (chapterId:chapter:label)
 * 2. 增加字段级别的增量更新 (对齐官方 L98-L101)
 * 3. 使用 chapter_id 递增机制处理章节边界 (对齐官方 L42-L48)
 * 4. 已完整的题目直接输出 (对齐官方 L53-L63)
 * 
 * @param questions 问题列表
 * @param answers 答案列表
 * @param strictTitleMatch 是否严格匹配章节标题
 * @returns 合并后的问答对列表
 */
export function mergeQAPairs(
  questions: ExtractedQAPair[],
  answers: ExtractedQAPair[],
  strictTitleMatch: boolean = false
): MergedQAPair[] {
  const merged: MergedQAPair[] = [];
  let alreadyCompleteCount = 0;
  
  // 单层索引: chapterId:chapter:label
  const questionMap = new Map<string, ExtractedQAPair>();
  const answerMap = new Map<string, ExtractedQAPair>();
  
  // ========== 处理问题列表 ==========
  
  // 章节边界检测变量 (对齐官方 L24-L26)
  let questionChapterId = 0;
  let questionChapterTitle = '';
  let questionLastLabel = Infinity;
  
  for (const q of questions) {
    // 提取数字 label (对齐官方 L31-L33)
    const labelNum = normalizeLabel(q.label);
    if (labelNum === null || labelNum <= 0) continue;
    
    // 填充空 chapter_title (对齐官方 L34-L35)
    if (!q.chapter_title || q.chapter_title === '') {
      q.chapter_title = questionChapterTitle;
    }
    
    // 章节边界检测 (对齐官方 L42-L48)
    if (q.chapter_title && q.chapter_title !== '' && q.chapter_title !== questionChapterTitle) {
      if (labelNum < questionLastLabel) {
        // label 回退,说明进入新章节
        questionChapterId++;
        questionChapterTitle = q.chapter_title;
      } else {
        // label 增加但 chapter_title 变化,可能是错误提取的子标题
        // 继续使用之前的 chapter_title
        q.chapter_title = questionChapterTitle;
      }
    }
    questionLastLabel = labelNum;
    
    // 规范化章节标题 (对齐官方 L50)
    const normalizedChapter = normalizeTitle(q.chapter_title, strictTitleMatch);
    
    // 已完整的题目直接输出 (对齐官方 L53-L63)
    if (q.question && (q.answer || q.solution)) {
      alreadyCompleteCount++;
      merged.push({
        label: labelNum,
        question_chapter_title: normalizedChapter,
        answer_chapter_title: normalizedChapter,
        question: q.question,
        answer: q.answer,
        solution: q.solution,
        images: q.images
      });
    } else {
      // 未完整的题目缓存到 Map (对齐官方 L66)
      const key = `${questionChapterId}:${normalizedChapter}:${labelNum}`;
      questionMap.set(key, {
        ...q,
        chapter_title: normalizedChapter
      });
    }
  }
  
  // ========== 处理答案列表 ==========
  
  // 章节边界检测变量 (对齐官方 L68-L70)
  let answerChapterId = 0;
  let answerChapterTitle = '';
  let answerLastLabel = Infinity;
  
  for (const a of answers) {
    // 提取数字 label (对齐官方 L73-L75)
    const labelNum = normalizeLabel(a.label);
    if (labelNum === null || labelNum <= 0) continue;
    
    // 填充空 chapter_title (对齐官方 L76-L77)
    if (!a.chapter_title || a.chapter_title === '') {
      a.chapter_title = answerChapterTitle;
    }
    
    // 章节边界检测 (对齐官方 L84-L90)
    if (a.chapter_title && a.chapter_title !== '' && a.chapter_title !== answerChapterTitle) {
      if (labelNum < answerLastLabel) {
        answerChapterId++;
        answerChapterTitle = a.chapter_title;
      } else {
        a.chapter_title = answerChapterTitle;
      }
    }
    answerLastLabel = labelNum;
    
    // 规范化章节标题 (对齐官方 L92)
    const normalizedChapter = normalizeTitle(a.chapter_title, strictTitleMatch);
    const key = `${answerChapterId}:${normalizedChapter}:${labelNum}`;
    
    // 字段级别的增量更新 (对齐官方 L95-L101)
    if (!answerMap.has(key)) {
      answerMap.set(key, {
        ...a,
        chapter_title: normalizedChapter
      });
    } else {
      const existing = answerMap.get(key)!;
      // 只更新缺失的字段
      if (!existing.solution && a.solution) {
        existing.solution = a.solution;
      }
      if (!existing.answer && a.answer) {
        existing.answer = a.answer;
      }
      // 合并图片
      if (a.images && a.images.length > 0) {
        existing.images = Array.from(new Set([...existing.images, ...a.images]));
      }
    }
  }
  
  // ========== 合并问题和答案 ==========
  
  for (const [key, q] of questionMap.entries()) {
    if (answerMap.has(key)) {
      const a = answerMap.get(key)!;
      const labelNum = parseInt(key.split(':')[2], 10);
      
      merged.push({
        label: labelNum,
        question_chapter_title: q.chapter_title,
        answer_chapter_title: a.chapter_title,
        question: q.question,
        answer: a.answer,
        solution: a.solution,
        images: Array.from(new Set([...q.images, ...a.images]))
      });
    }
  }
  
  console.log(`[mergeQAPairs] Merged ${merged.length} QA pairs (${alreadyCompleteCount} already complete, ${merged.length - alreadyCompleteCount} matched)`);
  
  return merged;
}
```

**移除的函数** (不再需要):
```typescript
// 移除 shouldReplaceQAPair() - 不再使用择优保留策略
// 移除 questionByIds 索引 - 不再使用 questionIds 去重
// 移除 questionMapExact 和 questionMapFuzzy - 简化为单层索引
```

---

## 改进 3: 增加二次提示机制

### 问题定位

**当前阶段**: 基于上下文的 LLM 抽取 (对应官方 `ChunkedPromptedGenerator`)

**问题描述**: 当 LLM 返回 `<empty></empty>` 时,直接丢弃该 chunk,可能导致数据丢失。

**官方可能的做法**: 使用二次提示或回退策略。

### 改进代码

**文件**: `server/extraction.ts`

**新增函数**:
```typescript
/**
 * 带二次提示的 LLM 调用
 * 
 * 如果第一次返回空结果,使用增强提示词重试
 * 
 * @param config LLM 配置
 * @param contentJson 要分析的 JSON 内容
 * @param systemPrompt 系统提示词
 * @param maxTokens 最大 token 数
 * @param chunkIndex 当前 chunk 索引 (用于日志)
 * @returns LLM 输出的文本
 */
export async function callLLMWithRetry(
  config: LLMConfig,
  contentJson: string,
  systemPrompt: string = QA_EXTRACT_PROMPT,
  maxTokens: number = 16384,
  chunkIndex: number = 0
): Promise<string> {
  // 第一次尝试
  console.log(`[LLM] Chunk ${chunkIndex}: First attempt...`);
  let output = await callLLMForTextExtraction(config, contentJson, systemPrompt, maxTokens);
  
  // 检查是否返回空结果
  const isEmpty = output.includes('<empty></empty>') || output.includes('<empty/>');
  
  if (isEmpty) {
    console.log(`[LLM] Chunk ${chunkIndex}: First attempt returned empty, retrying with enhanced prompt...`);
    
    // 使用增强提示词
    const enhancedPrompt = systemPrompt + `

## IMPORTANT: Retry Attempt

This is a **retry attempt**. The previous attempt returned empty result.

Please carefully re-examine the content and check if there are:
1. Math problems (marked as "例①", "例1", "习题1", etc.)
2. Exercises or practice questions
3. Examples with solutions
4. Question-answer pairs

**Even if the problems are incomplete or unclear, please try to extract them.**

If you are unsure about the chapter title or label, you can:
- Leave the chapter title blank
- Use the most likely label based on context
- Extract partial content (e.g., only question without solution)

**DO NOT return empty unless the page is truly a cover, catalog, or non-content page.**`;
    
    // 第二次尝试
    output = await callLLMForTextExtraction(config, contentJson, enhancedPrompt, maxTokens);
    
    // 记录第二次尝试的结果
    const isStillEmpty = output.includes('<empty></empty>') || output.includes('<empty/>');
    if (isStillEmpty) {
      console.log(`[LLM] Chunk ${chunkIndex}: Second attempt also returned empty`);
    } else {
      console.log(`[LLM] Chunk ${chunkIndex}: Second attempt succeeded!`);
    }
  }
  
  return output;
}
```

**修改主流程** (使用新函数):
```typescript
// 在主抽取流程中替换 callLLMForTextExtraction 为 callLLMWithRetry
export async function extractQAPairsFromChunks(
  chunks: ConvertedBlock[][],
  llmConfig: LLMConfig,
  systemPrompt: string = QA_EXTRACT_PROMPT
): Promise<ExtractedQAPair[]> {
  const allQAPairs: ExtractedQAPair[] = [];
  
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkJson = JSON.stringify(chunk);
    
    // 使用带重试的 LLM 调用
    const llmOutput = await callLLMWithRetry(
      llmConfig,
      chunkJson,
      systemPrompt,
      16384,
      i // chunk 索引
    );
    
    // 解析输出
    const qaPairs = parseLLMOutput(llmOutput, chunk, "images", "question");
    allQAPairs.push(...qaPairs);
    
    console.log(`[extractQAPairs] Chunk ${i}: Extracted ${qaPairs.length} QA pairs`);
  }
  
  return allQAPairs;
}
```

---

## 改进 4: 增加可观测性和诊断功能

### 问题定位

**所有阶段**: 缺少中间产物保存和质量指标,无法定位问题根因。

### 改进代码

**文件**: `server/extraction.ts`

**新增类型定义**:
```typescript
/**
 * 诊断报告接口
 */
export interface DiagnosticsReport {
  // 基本统计
  totalChunks: number;
  emptyChunks: number;
  retrySuccessChunks: number;
  totalQAPairs: number;
  
  // 章节统计
  chapterStats: Map<string, ChapterStats>;
  
  // 质量指标
  labelGaps: Array<{ chapter: string; from: number; to: number }>;
  avgQuestionLength: number;
  avgSolutionLength: number;
  
  // 时间戳
  timestamp: string;
}

export interface ChapterStats {
  count: number;
  labels: number[];
  avgQuestionLength: number;
  avgSolutionLength: number;
  minLabel: number;
  maxLabel: number;
}
```

**新增诊断函数**:
```typescript
/**
 * 生成诊断报告
 * 
 * @param qaPairs 合并后的问答对列表
 * @param chunkStats 每个 chunk 的统计信息
 * @returns 诊断报告
 */
export function generateDiagnostics(
  qaPairs: MergedQAPair[],
  chunkStats: Array<{ index: number; isEmpty: boolean; retrySuccess: boolean; qaCount: number }>
): DiagnosticsReport {
  const diagnostics: DiagnosticsReport = {
    totalChunks: chunkStats.length,
    emptyChunks: chunkStats.filter(s => s.isEmpty).length,
    retrySuccessChunks: chunkStats.filter(s => s.retrySuccess).length,
    totalQAPairs: qaPairs.length,
    chapterStats: new Map<string, ChapterStats>(),
    labelGaps: [],
    avgQuestionLength: 0,
    avgSolutionLength: 0,
    timestamp: new Date().toISOString()
  };
  
  // 统计每个章节
  for (const qa of qaPairs) {
    const chapter = qa.question_chapter_title;
    
    if (!diagnostics.chapterStats.has(chapter)) {
      diagnostics.chapterStats.set(chapter, {
        count: 0,
        labels: [],
        avgQuestionLength: 0,
        avgSolutionLength: 0,
        minLabel: Infinity,
        maxLabel: -Infinity
      });
    }
    
    const stats = diagnostics.chapterStats.get(chapter)!;
    stats.count++;
    stats.labels.push(qa.label);
    stats.avgQuestionLength += qa.question.length;
    stats.avgSolutionLength += qa.solution.length;
    stats.minLabel = Math.min(stats.minLabel, qa.label);
    stats.maxLabel = Math.max(stats.maxLabel, qa.label);
    
    // 全局平均长度
    diagnostics.avgQuestionLength += qa.question.length;
    diagnostics.avgSolutionLength += qa.solution.length;
  }
  
  // 计算平均值
  if (qaPairs.length > 0) {
    diagnostics.avgQuestionLength /= qaPairs.length;
    diagnostics.avgSolutionLength /= qaPairs.length;
  }
  
  // 检测 label 跳号
  for (const [chapter, stats] of diagnostics.chapterStats.entries()) {
    stats.avgQuestionLength /= stats.count;
    stats.avgSolutionLength /= stats.count;
    
    // 排序 labels
    stats.labels.sort((a, b) => a - b);
    
    // 检测跳号 (gap > 1)
    for (let i = 0; i < stats.labels.length - 1; i++) {
      const gap = stats.labels[i + 1] - stats.labels[i];
      if (gap > 1) {
        diagnostics.labelGaps.push({
          chapter,
          from: stats.labels[i],
          to: stats.labels[i + 1]
        });
      }
    }
  }
  
  return diagnostics;
}

/**
 * 生成诊断报告的 Markdown 格式
 */
export function diagnosticsToMarkdown(diagnostics: DiagnosticsReport): string {
  let md = `# 抽取质量诊断报告\n\n`;
  md += `生成时间: ${diagnostics.timestamp}\n\n`;
  md += `---\n\n`;
  
  // 基本统计
  md += `## 基本统计\n\n`;
  md += `- 总 chunk 数: ${diagnostics.totalChunks}\n`;
  md += `- 空 chunk 数: ${diagnostics.emptyChunks} (${(diagnostics.emptyChunks / diagnostics.totalChunks * 100).toFixed(1)}%)\n`;
  md += `- 重试成功 chunk 数: ${diagnostics.retrySuccessChunks}\n`;
  md += `- 总题目数: ${diagnostics.totalQAPairs}\n`;
  md += `- 平均题目长度: ${diagnostics.avgQuestionLength.toFixed(0)} 字符\n`;
  md += `- 平均解答长度: ${diagnostics.avgSolutionLength.toFixed(0)} 字符\n\n`;
  
  // 章节统计
  md += `## 章节统计\n\n`;
  md += `| 章节 | 题目数 | Label 范围 | 平均题目长度 | 平均解答长度 |\n`;
  md += `|------|--------|-----------|-------------|-------------|\n`;
  
  const sortedChapters = Array.from(diagnostics.chapterStats.entries())
    .sort((a, b) => a[0].localeCompare(b[0]));
  
  for (const [chapter, stats] of sortedChapters) {
    md += `| ${chapter} | ${stats.count} | ${stats.minLabel}-${stats.maxLabel} | ${stats.avgQuestionLength.toFixed(0)} | ${stats.avgSolutionLength.toFixed(0)} |\n`;
  }
  md += `\n`;
  
  // Label 跳号检测
  if (diagnostics.labelGaps.length > 0) {
    md += `## ⚠️ Label 跳号检测\n\n`;
    md += `检测到 ${diagnostics.labelGaps.length} 处 label 跳号:\n\n`;
    for (const gap of diagnostics.labelGaps) {
      md += `- **${gap.chapter}**: Label ${gap.from} → ${gap.to} (跳过 ${gap.to - gap.from - 1} 个)\n`;
    }
    md += `\n`;
  } else {
    md += `## ✅ Label 连续性检查\n\n`;
    md += `未检测到 label 跳号,所有章节的题号都是连续的。\n\n`;
  }
  
  // 建议
  md += `## 诊断建议\n\n`;
  if (diagnostics.emptyChunks > diagnostics.totalChunks * 0.2) {
    md += `- ⚠️ **空 chunk 比例较高** (${(diagnostics.emptyChunks / diagnostics.totalChunks * 100).toFixed(1)}%)，建议检查:\n`;
    md += `  - LLM 提示词是否清晰\n`;
    md += `  - chunk 大小是否合适\n`;
    md += `  - 是否存在大量非内容页 (封面、目录等)\n\n`;
  }
  
  if (diagnostics.labelGaps.length > 0) {
    md += `- ⚠️ **检测到 label 跳号**，可能原因:\n`;
    md += `  - LLM 未提取某些题目 (可能是不完整题目)\n`;
    md += `  - chunk 边界切断了题目\n`;
    md += `  - 原文确实缺少某些题号\n\n`;
  }
  
  if (diagnostics.retrySuccessChunks > 0) {
    md += `- ✅ **二次提示成功** ${diagnostics.retrySuccessChunks} 次，说明重试机制有效。\n\n`;
  }
  
  return md;
}
```

**修改主流程** (保存中间产物和诊断报告):
```typescript
/**
 * 完整的抽取流程 (带诊断)
 */
export async function extractQAPairsWithDiagnostics(
  taskDir: string,
  llmConfig: LLMConfig
): Promise<{ qaPairs: MergedQAPair[], diagnostics: DiagnosticsReport }> {
  const fs = require('fs');
  const path = require('path');
  
  // 创建中间产物目录
  const intermediateDir = path.join(taskDir, 'intermediate');
  if (!fs.existsSync(intermediateDir)) {
    fs.mkdirSync(intermediateDir, { recursive: true });
  }
  
  // 阶段 1: 输入格式化
  console.log('[Stage 1] Converting content_list.json...');
  const contentListPath = path.join(taskDir, 'content_list.json');
  const blocks: ContentBlock[] = JSON.parse(fs.readFileSync(contentListPath, 'utf-8'));
  const converted = convertContentList(blocks);
  
  // 保存中间产物
  const convertedPath = path.join(intermediateDir, 'content_list_converted.json');
  fs.writeFileSync(convertedPath, JSON.stringify(converted, null, 2));
  console.log(`[Stage 1] Saved converted JSON to ${convertedPath}`);
  
  // 阶段 2: 分块
  console.log('[Stage 2] Chunking content blocks...');
  const chunks = chunkContentBlocks(converted, 100000, 15);
  console.log(`[Stage 2] Created ${chunks.length} chunks`);
  
  // 阶段 3: LLM 抽取
  console.log('[Stage 3] Extracting QA pairs from chunks...');
  const allQAPairs: ExtractedQAPair[] = [];
  const chunkStats: Array<{ index: number; isEmpty: boolean; retrySuccess: boolean; qaCount: number }> = [];
  
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkJson = JSON.stringify(chunk);
    
    // 第一次尝试
    let llmOutput = await callLLMForTextExtraction(llmConfig, chunkJson, QA_EXTRACT_PROMPT, 16384);
    const firstIsEmpty = llmOutput.includes('<empty></empty>') || llmOutput.includes('<empty/>');
    
    // 保存 LLM 原始输出
    const llmOutputPath = path.join(intermediateDir, `chunk_${i}_llm_output.xml`);
    fs.writeFileSync(llmOutputPath, llmOutput);
    
    // 如果第一次为空,进行二次提示
    let retrySuccess = false;
    if (firstIsEmpty) {
      console.log(`[Stage 3] Chunk ${i}: First attempt empty, retrying...`);
      llmOutput = await callLLMWithRetry(llmConfig, chunkJson, QA_EXTRACT_PROMPT, 16384, i);
      const secondIsEmpty = llmOutput.includes('<empty></empty>') || llmOutput.includes('<empty/>');
      retrySuccess = !secondIsEmpty;
      
      // 保存重试输出
      const retryOutputPath = path.join(intermediateDir, `chunk_${i}_llm_output_retry.xml`);
      fs.writeFileSync(retryOutputPath, llmOutput);
    }
    
    // 解析
    const qaPairs = parseLLMOutput(llmOutput, chunk, "images", "question");
    allQAPairs.push(...qaPairs);
    
    // 记录统计
    chunkStats.push({
      index: i,
      isEmpty: firstIsEmpty && !retrySuccess,
      retrySuccess,
      qaCount: qaPairs.length
    });
    
    // 保存解析结果
    const parsedPath = path.join(intermediateDir, `chunk_${i}_parsed.json`);
    fs.writeFileSync(parsedPath, JSON.stringify(qaPairs, null, 2));
    
    console.log(`[Stage 3] Chunk ${i}: Extracted ${qaPairs.length} QA pairs`);
  }
  
  // 阶段 4: 合并
  console.log('[Stage 4] Merging QA pairs...');
  const merged = mergeQAPairs(allQAPairs, []);
  
  // 保存合并结果
  const mergedPath = path.join(intermediateDir, 'merged_qa_pairs.json');
  fs.writeFileSync(mergedPath, JSON.stringify(merged, null, 2));
  
  // 阶段 5: 生成诊断报告
  console.log('[Stage 5] Generating diagnostics...');
  const diagnostics = generateDiagnostics(merged, chunkStats);
  
  // 保存诊断报告
  const diagnosticsJsonPath = path.join(intermediateDir, 'diagnostics.json');
  const diagnosticsMdPath = path.join(intermediateDir, 'diagnostics.md');
  fs.writeFileSync(diagnosticsJsonPath, JSON.stringify(diagnostics, null, 2));
  fs.writeFileSync(diagnosticsMdPath, diagnosticsToMarkdown(diagnostics));
  
  console.log(`[Stage 5] Diagnostics saved to ${diagnosticsMdPath}`);
  
  return { qaPairs: merged, diagnostics };
}
```

---

## 改进 5: 动态调整 max_tokens

### 问题定位

**当前阶段**: 基于上下文的 LLM 抽取

**问题描述**: 固定的 `max_tokens=16384` 可能导致大 chunk 的输出被截断。

### 改进代码

**文件**: `server/extraction.ts`

**新增函数**:
```typescript
/**
 * 根据 chunk 大小动态计算 max_tokens
 * 
 * 经验公式: max_tokens = chunk_tokens * 1.5 + 1000
 * - chunk_tokens: 输入 chunk 的 token 数 (粗略估算: 字符数 / 2)
 * - 1.5: 输出通常比输入短 (只输出 ID 而非原文)
 * - 1000: 额外的 buffer
 * 
 * @param chunkJson chunk 的 JSON 字符串
 * @returns 推荐的 max_tokens
 */
export function calculateMaxTokens(chunkJson: string): number {
  // 粗略估算 token 数: 字符数 / 2 (中文约 1.5 字符/token, 英文约 4 字符/token)
  const chunkTokens = Math.ceil(chunkJson.length / 2);
  
  // 输出通常比输入短,但为了安全起见使用 1.5 倍
  const estimatedOutputTokens = Math.ceil(chunkTokens * 1.5) + 1000;
  
  // 限制在合理范围内
  const minTokens = 4096;
  const maxTokens = 32768; // 假设模型支持的最大值
  
  return Math.max(minTokens, Math.min(estimatedOutputTokens, maxTokens));
}
```

**修改 LLM 调用**:
```typescript
export async function callLLMForTextExtraction(
  config: LLMConfig,
  contentJson: string,
  systemPrompt: string = QA_EXTRACT_PROMPT,
  maxTokens?: number // 改为可选参数
): Promise<string> {
  // 如果未指定 max_tokens,动态计算
  if (!maxTokens) {
    maxTokens = calculateMaxTokens(contentJson);
    console.log(`[LLM] Auto-calculated max_tokens: ${maxTokens}`);
  }
  
  // ... 现有的 LLM 调用逻辑 ...
}
```

---

## 改进 6: 增加输出截断检测

### 问题定位

**当前阶段**: ID 回填原文

**问题描述**: 无法检测 LLM 输出是否被截断。

### 改进代码

**文件**: `server/extraction.ts`

**新增函数**:
```typescript
/**
 * 检测 LLM 输出是否被截断
 * 
 * 截断特征:
 * 1. 最后一个 </chapter> 标签不完整
 * 2. 最后一个 </qa_pair> 标签不完整
 * 3. 输出突然结束 (没有正常的结束标签)
 * 
 * @param output LLM 的原始输出
 * @returns 是否被截断
 */
export function isTruncated(output: string): boolean {
  // 检查是否为空
  if (output.includes('<empty></empty>') || output.includes('<empty/>')) {
    return false; // 空结果不算截断
  }
  
  // 检查最后一个 </chapter> 标签
  const lastChapterClose = output.lastIndexOf('</chapter>');
  if (lastChapterClose === -1) {
    return true; // 没有 </chapter> 标签,可能被截断
  }
  
  // 检查 </chapter> 之后是否还有内容 (除了空白字符)
  const afterLastChapter = output.substring(lastChapterClose + '</chapter>'.length).trim();
  if (afterLastChapter.length > 0) {
    // 如果 </chapter> 之后还有非空白内容,可能是未完成的下一个 chapter
    return true;
  }
  
  // 检查 <chapter> 和 </chapter> 数量是否匹配
  const chapterOpenCount = (output.match(/<chapter>/g) || []).length;
  const chapterCloseCount = (output.match(/<\/chapter>/g) || []).length;
  if (chapterOpenCount !== chapterCloseCount) {
    return true;
  }
  
  // 检查 <qa_pair> 和 </qa_pair> 数量是否匹配
  const pairOpenCount = (output.match(/<qa_pair>/g) || []).length;
  const pairCloseCount = (output.match(/<\/qa_pair>/g) || []).length;
  if (pairOpenCount !== pairCloseCount) {
    return true;
  }
  
  return false;
}
```

**在主流程中使用**:
```typescript
// 在 extractQAPairsWithDiagnostics() 中增加截断检测
for (let i = 0; i < chunks.length; i++) {
  const chunk = chunks[i];
  const chunkJson = JSON.stringify(chunk);
  
  // 动态计算 max_tokens
  const maxTokens = calculateMaxTokens(chunkJson);
  
  // 调用 LLM
  let llmOutput = await callLLMForTextExtraction(llmConfig, chunkJson, QA_EXTRACT_PROMPT, maxTokens);
  
  // 检测截断
  if (isTruncated(llmOutput)) {
    console.warn(`[Stage 3] Chunk ${i}: Output may be truncated!`);
    // 可以选择:
    // 1. 增加 max_tokens 重试
    // 2. 记录到诊断报告
    // 3. 将该 chunk 拆分为更小的 sub-chunks
  }
  
  // ... 后续处理 ...
}
```

---

## 使用示例

### 完整的抽取流程

```typescript
import {
  extractQAPairsWithDiagnostics,
  generateResults,
  DiagnosticsReport,
  MergedQAPair
} from './extraction';

async function main() {
  // 任务目录
  const taskDir = '/path/to/task/202602080714-1770506098605';
  
  // LLM 配置
  const llmConfig = {
    apiUrl: 'https://api.example.com/v1/chat/completions',
    apiKey: 'your-api-key',
    modelName: 'gemini-2.5-pro',
    maxWorkers: 10,
    timeout: 120
  };
  
  // 执行抽取 (带诊断)
  const { qaPairs, diagnostics } = await extractQAPairsWithDiagnostics(taskDir, llmConfig);
  
  // 生成结果
  const { json, markdown } = generateResults(qaPairs, 'images');
  
  // 保存结果
  const fs = require('fs');
  const path = require('path');
  const resultsDir = path.join(taskDir, 'results');
  
  fs.writeFileSync(path.join(resultsDir, 'questions.json'), JSON.stringify(json, null, 2));
  fs.writeFileSync(path.join(resultsDir, 'questions.md'), markdown);
  
  // 打印诊断摘要
  console.log('\n========== 诊断摘要 ==========');
  console.log(`总题目数: ${diagnostics.totalQAPairs}`);
  console.log(`空 chunk 数: ${diagnostics.emptyChunks} / ${diagnostics.totalChunks}`);
  console.log(`重试成功: ${diagnostics.retrySuccessChunks}`);
  console.log(`Label 跳号: ${diagnostics.labelGaps.length} 处`);
  console.log(`平均题目长度: ${diagnostics.avgQuestionLength.toFixed(0)} 字符`);
  console.log(`平均解答长度: ${diagnostics.avgSolutionLength.toFixed(0)} 字符`);
  console.log('==============================\n');
  
  // 如果有 label 跳号,打印详情
  if (diagnostics.labelGaps.length > 0) {
    console.log('⚠️ Label 跳号详情:');
    for (const gap of diagnostics.labelGaps) {
      console.log(`  - ${gap.chapter}: ${gap.from} → ${gap.to}`);
    }
  }
}

main().catch(console.error);
```

---

## 总结

本文档提供了 6 个关键改进方案,所有改进均严格对齐 OpenDCAI/DataFlow 官方流水线:

1. **移除输入阶段的过严过滤** - 对齐官方,避免误判选项列表
2. **简化合并索引结构** - 对齐官方的单层索引和字段级别增量更新
3. **增加二次提示机制** - 提高覆盖率,减少数据丢失
4. **增加可观测性和诊断功能** - 保存中间产物,生成质量报告
5. **动态调整 max_tokens** - 避免输出截断
6. **增加输出截断检测** - 及时发现问题

所有代码均可直接集成到现有项目中,无需重构整体架构。建议按照优先级 (P0 → P1 → P2) 逐步实施改进。
