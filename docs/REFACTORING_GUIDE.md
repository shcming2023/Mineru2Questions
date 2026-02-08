# Mineru2Questions 重构指南

**重构日期:** 2026-02-08  
**重构目标:** 对齐 DataFlow 官方流水线标准，强制执行 ID-Only 原则  
**重构范围:** 核心抽取流水线  

---

## 重构概述

本次重构严格对照 OpenDCAI/DataFlow 官方流水线的 `PDF_VQA_extract_optimized_pipeline` 标准，解决了原实现中 LLM 未严格遵守"只输出 ID"指令的核心问题。重构后的系统采用算子化设计，每个处理环节都更加健壮、可测试，并从根本上解决了数据来源不可追溯、去重逻辑不准确、质量无法评估等问题。

---

## 新增文件清单

### 1. `server/types.ts`
**用途:** 共享类型定义文件  
**内容:** 定义了所有核心数据结构，包括 MinerU 输入/输出类型、LLM 配置与结果类型、抽取的 QA 对类型、合并后的 QA 对类型等。

**关键类型:**
- `ContentBlock`: MinerU 原始内容块
- `ConvertedBlock`: 转换后的 LLM 输入格式（带 ID）
- `ExtractedQAPair`: 从 LLM 输出中抽取的 QA 对
- `MergedQAPair`: 合并后的完整 QA 对
- `LLMConfig`: LLM 配置
- `StageLog`: 阶段日志

### 2. `server/llm-output-parser.ts`
**用途:** 严格的 LLM 输出解析器  
**核心约束:** 强制执行 "ID-Only" 原则  

**关键功能:**
- 解析 LLM 输出的 XML 字符串
- 校验 `<title>`、`<question>`、`<solution>` 是否只包含 ID 序列
- 任何包含自由文本的输出都视为格式错误，触发异常
- 通过 ID 回填机制从 `content_list.json` 获取文本
- 提供详细的错误信息和日志

**使用示例:**
```typescript
import { LLMOutputParser } from './llm-output-parser';

const parser = new LLMOutputParser(convertedBlocks, imagePrefix);
try {
  const extractedPairs = parser.parse(llmOutput, chunkIndex);
  // ... 后续处理 ...
} catch (error) {
  console.error(`Failed to parse LLM output:`, error.message);
  // 记录失败的 llmOutput 以便分析
}
```

### 3. `server/qa-merger.ts`
**用途:** 独立的问答对合并算子  
**对齐:** DataFlow 的 QA_Merger 算子  

**关键功能:**
- 基于"规范化章节标题 + 题号"进行匹配
- 支持严格匹配和宽松匹配两种模式
- 标题规范化逻辑对齐 DataFlow 的 `refine_title`
- 基于内容完整度进行去重
- 支持圆圈数字（①②③）的转换

**使用示例:**
```typescript
import { QAMerger } from './qa-merger';

const merger = new QAMerger({ strictTitleMatch: false });
const mergedPairs = merger.merge(extractedQuestions, extractedAnswers);
```

### 4. `server/quality-gate.ts`
**用途:** 质量门与回退机制  
**对齐:** DataFlow 的质量评估和容错策略  

**关键功能:**
- **Pre-Parse Gate:** 解析前的 XML 结构校验
- **Post-Parse Gate:** 解析后的内容校验
- **Post-Merge Gate:** 合并后的完整性校验
- **FallbackHandler:** 处理解析失败和 LLM 调用失败的情况
- 过滤低质量的 QA 对
- 记录详细的质量指标

**使用示例:**
```typescript
import { QualityGate, FallbackHandler } from './quality-gate';

const qualityGate = new QualityGate({ enablePreParseGate: true });
const preParseResult = qualityGate.validatePreParse(llmOutput, chunkIndex);
if (!preParseResult.passed) {
  console.warn(`Pre-parse gate failed: ${preParseResult.reason}`);
  // 跳过或触发回退
}
```

### 5. `server/pipeline.ts`
**用途:** 核心流水线模块  
**对齐:** DataFlow 的 forward 模式  

**关键功能:**
- 将整个 PDF 到 QA 对的抽取过程分解为一系列独立的、可测试的算子
- 明确每个阶段的输入输出
- 集成质量门进行校验和容错
- 提供详细的日志和指标

**流水线阶段:**
1. Input Formatting: 加载并格式化 MinerU 输出
2. LLM Extraction: 调用 LLM 进行抽取
3. Output Parsing: 解析 LLM 输出（强制 ID-Only）
4. QA Merging: 合并问题和答案
5. Quality Filtering: 过滤低质量数据

**使用示例:**
```typescript
import { ExtractionPipeline } from './pipeline';

const pipeline = new ExtractionPipeline({
  llmConfig,
  imagePrefix,
  strictTitleMatch: false,
  enableQualityGate: true
});

const result = await pipeline.run(questionBlocks, answerBlocks);
console.log(`Extracted ${result.mergedPairs.length} QA pairs`);
console.log(`Metrics:`, result.metrics);
```

### 6. `server/prompts.ts`
**用途:** LLM 提示词模板  
**核心改进:** 强化 "ID-Only" 原则  

**关键改进:**
- 更明确地禁止输出自由文本
- 增加更多示例展示正确和错误的输出
- 强调 `<answer>` 字段也应尽量使用 ID（除非是非常短的答案）
- 增加错误示例，帮助 LLM 理解什么是不允许的

**使用示例:**
```typescript
import { getQAExtractPrompt } from './prompts';

const prompt = getQAExtractPrompt('v2'); // 使用强化版提示词
```

---

## 与现有代码的集成

### 兼容性策略

为了确保平滑过渡，新代码采用"渐进式集成"策略：

1. **新文件独立存在:** 所有新增文件（`types.ts`、`llm-output-parser.ts`、`qa-merger.ts`、`quality-gate.ts`、`pipeline.ts`、`prompts.ts`）都是独立的模块，不会破坏现有代码。

2. **现有代码保持不变:** `extraction.ts` 和 `taskProcessor.ts` 等现有文件暂时保持不变，确保系统继续正常运行。

3. **逐步替换:** 可以逐步将现有代码中的函数替换为新的算子，例如：
   - 将 `parseLLMOutput` 替换为 `LLMOutputParser.parse`
   - 将 `mergeQAPairs` 替换为 `QAMerger.merge`
   - 在主流程中增加质量门校验

### 集成步骤

#### 步骤 1: 更新 `extraction.ts` 导入新类型

```typescript
// 在 extraction.ts 顶部添加
import {
  ContentBlock,
  ConvertedBlock,
  ExtractedQAPair,
  MergedQAPair,
  LLMConfig
} from './types';
```

#### 步骤 2: 在 `taskProcessor.ts` 中使用新的解析器

```typescript
// 替换原有的 parseLLMOutput 调用
import { LLMOutputParser } from './llm-output-parser';
import { QualityGate } from './quality-gate';

// 在 processChunk 函数中
const qualityGate = new QualityGate();
const preParseResult = qualityGate.validatePreParse(llmOutput, chunkIndex);

if (!preParseResult.passed) {
  console.warn(`Chunk ${chunkIndex} failed pre-parse gate: ${preParseResult.reason}`);
  // 触发回退或跳过
}

const parser = new LLMOutputParser(ctx.convertedBlocks, ctx.imagesFolder);
const qaPairs = parser.parse(llmOutput, chunkIndex);
```

#### 步骤 3: 使用新的提示词

```typescript
// 在调用 LLM 时使用新提示词
import { getQAExtractPrompt } from './prompts';

const prompt = getQAExtractPrompt('v2');
// 使用 prompt 调用 LLM
```

#### 步骤 4: 使用新的合并算子

```typescript
// 替换原有的 mergeQAPairs 调用
import { QAMerger } from './qa-merger';

const merger = new QAMerger({ strictTitleMatch: false });
const mergedPairs = merger.merge(extractedQuestions, extractedAnswers);
```

---

## 测试与验证

### 单元测试建议

为每个新模块编写单元测试：

1. **LLMOutputParser 测试:**
   - 测试合法的 ID 序列输入
   - 测试非法的自由文本输入（应抛出异常）
   - 测试空输出和 `<empty>` 标记
   - 测试 XML 结构错误

2. **QAMerger 测试:**
   - 测试标题规范化逻辑
   - 测试题号规范化逻辑
   - 测试圆圈数字转换
   - 测试去重逻辑

3. **QualityGate 测试:**
   - 测试 Pre-Parse Gate 的 XML 校验
   - 测试 Post-Parse Gate 的内容校验
   - 测试 Post-Merge Gate 的完整性校验
   - 测试低质量数据过滤

### 集成测试建议

使用现有的测试任务进行端到端测试：

```bash
# 运行测试任务
npm run test:extraction

# 对比新旧实现的输出
diff old_output/questions.json new_output/questions.json
```

### 验证清单

- [ ] LLM 输出是否严格遵守 ID-Only 原则？
- [ ] 解析器是否正确拒绝包含自由文本的输出？
- [ ] 质量门是否正确校验 XML 结构？
- [ ] 合并逻辑是否正确匹配问题和答案？
- [ ] 去重逻辑是否正确去除重复的 QA 对？
- [ ] 日志是否记录了每个阶段的详细指标？

---

## 回滚计划

如果新实现出现问题，可以快速回滚到原实现：

1. **删除新文件:**
   ```bash
   rm server/types.ts
   rm server/llm-output-parser.ts
   rm server/qa-merger.ts
   rm server/quality-gate.ts
   rm server/pipeline.ts
   rm server/prompts.ts
   ```

2. **恢复原有代码:**
   ```bash
   git checkout server/extraction.ts
   git checkout server/taskProcessor.ts
   ```

3. **重启服务:**
   ```bash
   npm run dev
   ```

---

## 后续优化建议

1. **完善 Pipeline 的 LLM 调用:**
   - 当前 `pipeline.ts` 中的 `callLLM` 方法是占位符，需要与现有的 `callLLMForTextExtraction` 函数集成。

2. **增加更多回退策略:**
   - 当 ID-based 方案失败时，自动调用 VQA 提取逻辑。
   - 实现 "loosen" 策略，放宽约束尝试部分解析。

3. **优化提示词:**
   - 根据实际测试结果，继续优化提示词，提高 LLM 的输出质量。
   - 考虑使用 few-shot learning，提供更多示例。

4. **增加性能监控:**
   - 记录每个阶段的耗时，识别性能瓶颈。
   - 监控 LLM 调用的成功率和失败率。

5. **完善文档:**
   - 为每个算子编写详细的 API 文档。
   - 提供更多使用示例和最佳实践。

---

## 联系与支持

如有问题或建议，请提交 GitHub Issue 或联系项目维护者。

**项目仓库:** https://github.com/shcming2023/Mineru2Questions  
**官方参考:** https://github.com/OpenDCAI/DataFlow
