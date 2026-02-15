# Mineru2Questions 项目代码评审报告 (v2.0)

**评审时间**: 2026-02-15
**评审人**: Manus AI (Mineru2Questions 技术评审与开发助手)
**目标版本**: `e195b8d` (2026-02-14)

## 1. 整体结论

本次评审严格依据 `Mineru2Questions_PRD_v2.0` 文档，对项目当前的代码实现、测试结果和开发方案进行了全面对齐。评审发现，项目流水线虽然基本搭建完成，但在核心策略和关键算子上存在三处 **P0 级严重偏差**，直接导致测试任务输出质量不达标，阻塞了核心产品目标的实现。此外，还存在一处 **P1 级中等风险** 问题和多处 **P2 级优化建议**。

**核心结论**：项目**必须**优先解决 PRD 路线图中定义的 P0-1, P0-2, P0-3 问题，否则无法进入有效的测试和发布阶段。当前章节处理逻辑存在根本性缺陷，导致章节归属准确率远低于 95% 的发布标准。

### PRD 对齐度评估表

| 算子 | 名称 | 实现状态 | PRD 对齐度 | 关键偏差说明 |
| :--- | :--- | :--- | :--- | :--- |
| ① | **BlockFlattener** | 已实现 | ✅ 已对齐 | `blockFlattener.ts` 实现了统一的展平逻辑，符合 PRD §5.2 要求。 |
| ② | **ChapterPreprocess** | 部分实现 | ⚠️ **偏离** | 实现了两轮 LLM 抽取，但分块模式存在致命的 ID 空间错误 (P0-3)。 |
| ③ | **ChapterValidation** | **未实现** | ❌ **严重偏离** | **P0-1 缺陷**：代码中完全缺失此算子，无法验证章节候选的合法性。 |
| ④ | **QuestionExtract** | 已实现 | ⚠️ **偏离** | 并发抽取已实现，但 PRD §5.5 要求的 Sanity Check 策略未有效实现 (P1-2)。 |
| ⑤ | **Parser** | 已实现 | ✅ 已对齐 | `parser.ts` 实现了严格/宽松双模式解析和 ID 回填，符合 PRD §5.6 要求。 |
| ⑥ | **ChapterMerge** | **未实现** | ❌ **严重偏离** | **P0-2 缺陷**：当前实现为 `ChapterOverwrite`（强制覆盖），而非 PRD §5.7 要求的 `ChapterMerge`（融合）。 |
| ⑦ | **PostProcess & Export**| 已实现 | ✅ 已对齐 | 基于 `questionIds` 的去重和导出逻辑已实现，符合 PRD §5.8 要求。 |

### KPI 达成情况评估

| 目标 | KPI | 目标值 | 当前状态 (基于 Task 1 & 2) | 评估 |
| :--- | :--- | :--- | :--- | :--- |
| 题目提取完整性 | 提取完整率 | > 99% | ~98% (估算) | ⚠️ **部分达成** |
| 章节归属准确性 | 章节覆盖率 | > 99% | Task 1: 100%; Task 2: ~50% | ❌ **未达成** |
| | 章节准确率 | > 95% | Task 1: 0%; Task 2: < 50% | ❌ **严重未达成** |
| 流水线鲁棒性 | LLM 输出有效率 | > 98% | > 95% (估算) | ⚠️ **部分达成** |
| 降低人工成本 | 人工干预率 | < 1% | > 50% (因章节错误) | ❌ **未达成** |
| 处理性能 | 1500 页/5000 题 | ≤ 30 分钟 | 尚可 | ✅ **基本达成** |

---

## 2. P0 级严重偏差 (必须立即解决)

### P0-1: [算子 ③ ChapterValidation] 算子完全缺失

**PRD 要求**: PRD §5.4 明确要求实现 `ChapterValidation` 算子，用于“验证章节候选的 JSON 格式、ID 合法性和逻辑合理性，失败时输出 `null`”。这是防止下游算子接收到污染数据的关键屏障。

**当前实现**: 通过对 `chapterPreprocess.ts` 和 `taskProcessor.ts` 的审查，未发现任何与 `ChapterValidation` 相关的函数调用或逻辑实现。`preprocessChapters` 函数的输出被直接传递给 `extractQuestions`，没有经过任何验证环节。

**偏差影响**: 缺少验证导致了两个直接后果：
1.  **格式错误无法捕获**：如果 LLM 在章节预处理阶段返回了格式错误的 JSON，将直接导致下游 `buildFlatMap` 函数崩溃。
2.  **逻辑谬误无法处理**：如 Task 2 中出现的 ID 空间错误，本应由 `ChapterValidation` 算子检测到（例如，通过检查 ID 是否在 `chunkValidIds` 范围内），但由于算子缺失，错误数据被直接用于构建 `chapter_flat_map`，污染了整个流水线。

**修复建议**: 在 `chapterPreprocess.ts` 中，`preprocessChapters` 函数返回结果前，必须增加一个独立的 `validateChapterCandidates` 函数。

```typescript
// In chapterPreprocess.ts

// ... (after finalEntries are generated)

// NEW: Step 5.5 - ChapterValidation Operator
const validationResult = validateChapterCandidates(finalEntries, blocks);
if (!validationResult.isValid) {
  console.warn(`[ChapterValidation] Chapter candidates failed validation: ${validationResult.error}. Returning null.`);
  // 根据 PRD §5.4，失败时必须返回 null，触发下游回退
  return {
    flatMap: null, // <-- CRITICAL: Return null on failure
    blocks,
    coverageRate: 0,
    // ... other stats
  };
}

// Step 6: Build flat_map (only if validation passes)
const flatMap = buildFlatMap(finalEntries, blocks);

// ...

/**
 * [NEW OPERATOR] ChapterValidation: Validates chapter candidates.
 * PRD §5.4
 */
function validateChapterCandidates(entries: DirectoryEntry[], allBlocks: FlatBlock[]): { isValid: boolean; error: string | null } {
  if (entries.length === 0) {
    return { isValid: true, error: null }; // Empty is valid
  }

  const allBlockIds = new Set(allBlocks.map(b => b.id));

  for (const entry of entries) {
    const ids = Array.isArray(entry.id) ? entry.id : [entry.id];
    
    // 1. ID Legitimacy Check
    for (const id of ids) {
      if (!allBlockIds.has(id)) {
        return { isValid: false, error: `Invalid block ID ${id} found in chapter entry.` };
      }
    }

    // 2. Logical Plausibility Check (add more rules as needed)
    if (entry.level < 1 || entry.level > 4) {
        return { isValid: false, error: `Invalid level ${entry.level} for entry with ID ${ids[0]}.` };
    }
  }

  return { isValid: true, error: null };
}
```

**风险评估**: **阻塞性**。不实现此算子，章节预处理流程完全不可靠，无法保证数据质量，下游的 ChapterMerge 策略也无从谈起。

### P0-2: [算子 ⑥ ChapterMerge] 当前实现为 ChapterOverwrite，违反 PRD §5.7

**PRD 要求**: PRD §5.7 明确指出，v2.0 的核心改进之一是将章节信息处理从 `ChapterOverwrite` (强制覆盖) 修订为 `ChapterMerge` (融合)。这意味着系统应“同时保留两个来源的章节信息（章节预处理、题目抽取），并根据可靠性进行融合决策”。PRD §15 的历史教训中也明确将“强制覆盖章节信息”列为必须避免的失败策略。

**当前实现**: `extraction.ts` 的 `extractQuestions` 函数 (L249-L264) 存在一个 `if (chapterFlatMap && chapterFlatMap.length > 0)` 判断。如果为真，则**无条件**使用 `findChapterForBlock` 的结果覆盖从题目抽取阶段 LLM 输出中解析出的 `chapter_title`。

```typescript
// In server/extraction.ts (Lines 249-261)

if (chapterFlatMap && chapterFlatMap.length > 0) {
  // ... log message ...
  for (const q of uniqueQuestions) {
    if (q.questionIds) {
      const firstId = parseInt(q.questionIds.split(",")[0].trim(), 10);
      if (!isNaN(firstId)) {
        const chapterPath = findChapterForBlock(firstId, chapterFlatMap);
        if (chapterPath) {
          // THIS IS ChapterOverwrite
          q.chapter_title = chapterPath;
        }
      }
    }
  }
}
```

**偏差影响**: **灾难性**。Task 1 的测试结果是该问题的直接体现。`chapter_flat_map` 中最后一个条目“参考答案”覆盖了从 block 119 到 3469 的巨大范围。由于所有抽取的题目 ID 均在此范围内，`findChapterForBlock` 函数为**每一道题**都返回了“参考答案”作为其章节。题目抽取阶段 LLM 本身识别出的正确章节信息（如“19.1(二) 平方根”）被完全丢弃。这导致章节准确率降至 0%，严重违反了产品原则一（准确性高于一切）和原则四（优雅降级）。

**修复建议**: 必须重构此部分逻辑，实现 `ChapterMerge`。核心思路是：仅当章节预处理的结果（`chapterFlatMap`）有效 **且** 题目抽取阶段 LLM 未提供章节信息时，才使用 `chapterFlatMap` 的结果。如果两个来源都有信息，应优先信任题目抽取阶段的近距离上下文判断，或引入更复杂的融合策略。

```typescript
// In server/extraction.ts (replace lines 249-268)

// 5.5. [OPERATOR ⑥ ChapterMerge] Merging chapter information
console.log("[ChapterMerge] Starting chapter merge process...");
for (const q of uniqueQuestions) {
  const llmChapterTitle = q.chapter_title; // From QuestionExtract operator
  let preprocessedChapterTitle: string | null = null;

  if (chapterFlatMap && q.questionIds) {
    const firstId = parseInt(q.questionIds.split(",")[0].trim(), 10);
    if (!isNaN(firstId)) {
      // findChapterForBlock should return a full path
      preprocessedChapterTitle = findChapterForBlock(firstId, chapterFlatMap);
    }
  }

  // PRD §5.7: Fusion Logic
  // Principle: Trust local context (LLM extraction) unless it's missing.
  if (llmChapterTitle && llmChapterTitle.trim().length > 0) {
    // Source 1: QuestionExtract LLM provided a title. Use it.
    q.chapter_title = llmChapterTitle;
  } else if (preprocessedChapterTitle) {
    // Source 2: Preprocessing is available and LLM extraction missed it. Fill it in.
    q.chapter_title = preprocessedChapterTitle;
    console.log(`[ChapterMerge] Filled missing chapter for Q(${q.label}) with preprocessed: "${preprocessedChapterTitle}"`);
  } else {
    // No source available, remains empty.
    q.chapter_title = "";
  }
}

// Now, apply a single, unified cleaning function to the merged titles
const cleanedQuestions = cleanChapterTitles(uniqueQuestions);
```

**风险评估**: **阻塞性**。这是 v2.0 版本的核心需求之一。不修复此问题，章节预处理算子带来的价值为零甚至为负，产品无法达到预期的章节准确性目标。

### P0-3: [算子 ② ChapterPreprocess] 分块模式下存在致命的 ID 空间错误

**PRD 要求**: PRD §5.3 描述的章节预处理，无论是全量还是分块，都必须在全局统一的 `FlatBlock[]` ID 空间上操作。LLM 的输出必须引用全局唯一的 Block ID。

**当前实现**: `chapterPreprocess.ts` 的分块处理逻辑存在设计缺陷。在 `splitBlocksIntoChunks` 之后，传递给 `callChapterLLM` 的 `chunkPrompt` 虽然包含了**全局 ID**（例如 `[12479|p394|T1] 12.5 Quartiles`），但 LLM 的输出（如 `chapter_chunk_1_response_attempt1.json`）却返回了**从 0 开始的相对 ID**（例如 `{"id": 0, "level": 1, "title": "Front Matter"}`）。更严重的是，`parseLLMOutput` 函数在校验 ID 时，使用的 `validIds` 集合是当前 Chunk 的 ID 集合（例如 0-12479）。由于 LLM 输出的相对 ID (0, 1, 2...) 恰好落在这个合法的全局 ID 范围内，校验被**错误地通过**了。这导致 `buildFlatMap` 函数接收了错误的 ID 映射，生成了覆盖范围完全错误的 `chapter_flat_map`。

**偏差影响**: **灾难性**。在 Task 2 中，由于第一个 Chunk 的 LLM 输出了错误的相对 ID，导致 `chapter_flat_map` 从 block 12448 才开始有条目，整个文档前半部分（0-12447）的章节信息完全丢失，章节覆盖率直接腰斩至约 49%。这严重违反了产品原则二（过程必须可观测）和原则三（坚持 ID-Only）。

**修复建议**: 必须在分块处理流程中强制实现 ID 空间的转换和校验。LLM prompt 需要更明确地指示它输出所见到的全局 ID。

1.  **强化 Prompt**: 明确告知 LLM，它看到的 ID 是全局 ID，必须原样返回。

    ```
    // In chapterPreprocess.ts, inside buildExtractionPrompt
    // Add this critical instruction to the prompt template:
    "## CRITICAL RULE: RETURN ORIGINAL IDs
    The block IDs you see (e.g., [12479|p394|T1]) are GLOBAL IDs. You MUST return these exact IDs. DO NOT generate your own sequential IDs starting from 0.
    - ✅ CORRECT: {"id": 12479, ...}
    - ❌ WRONG: {"id": 0, ...} (when the block shown was [12479|...])"
    ```

2.  **改造 `parseLLMOutput`**：虽然 Prompt 应该修复大部分问题，但代码层面必须有防御。`parseLLMOutput` 应该能够检测到这种 ID 空间漂移。

    ```typescript
    // In chapterPreprocess.ts -> parseLLMOutput
    function parseLLMOutput(raw: string, chunkBlockIds: Set<number>): { ... } {
      // ... after parsing rawEntries

      // NEW: ID Space Drift Detection
      const outputIds = new Set(rawEntries.map(e => Array.isArray(e.id) ? e.id[0] : e.id));
      if (outputIds.size > 0 && Math.max(...outputIds) < 100 && Math.min(...chunkBlockIds) > 1000) {
        // Heuristic: If output IDs are all small, but chunk IDs are all large, 
        // it's highly likely the LLM has reset the ID space.
        warnings.push("FATAL: LLM appears to have reset the ID space to 0-based. Discarding results.");
        return { entries: [], warnings };
      }

      for (const item of rawEntries) {
        const id = item.id;
        // The existing validation is correct, but it failed because the condition above was not met
        if (typeof id === 'number') {
          if (!chunkBlockIds.has(id)) { invalidCount++; continue; }
        } // ...
      }
      // ...
    }
    ```

**风险评估**: **阻塞性**。不修复此问题，对于任何需要分块处理的文档（即绝大部分真实文档），章节预处理功能都将完全失效，无法为下游提供任何有效价值。

---

## 3. P1 级中等风险 (建议尽快解决)

### P1-2: [算子 ④ QuestionExtract] Sanity Check 策略未有效实现

**PRD 要求**: PRD §5.5 和 §15 历史教训均强调，需要有 `Sanity Check` 机制来应对 LLM 的“注意力衰减”问题（即对于一个包含很多题目的 Chunk，LLM 只返回了很少几道题）。

**当前实现**: `extraction.ts` (L167-L179) 中虽然有名为 `Sanity Check` 的代码块，但其逻辑过于简单且存在风险。它仅检查“题目数量 / block 数量”的比例，如果低于一个固定的阈值（0.02）就抛出错误触发重试。但注释中也提到 `// 除非这是最后一次重试，否则我们应该重试`，这意味着在最后一次尝试时，即使 Sanity Check 失败，结果也会被接受。

**偏差影响**: 当前的实现方式可能会因为正常的稀疏题目分布（例如，大段的讲解文字中夹杂少量题目）而误触发重试，增加不必要的成本和延迟。而在真正发生注意力衰减时，最后一次重试的结果仍然可能是有问题的，但会被系统接受，导致题目提取不完整。

**修复建议**: 增强 Sanity Check 策略，使其更智能。

1.  **引入动态阈值**: 阈值不应是固定的，可以根据 Chunk 内的文本密度、图片数量等特征动态调整。
2.  **增加“题号”信号检测**: 在触发重试前，先扫描 Chunk 内的 `FlatBlock` 文本，检查是否存在明显的题号模式（如 `\d+\.`、`例\d`）。如果存在大量题号信号但 LLM 输出为空或极少，则可以高置信度地判断为注意力衰减，并强制重试。

```typescript
// In server/extraction.ts, inside the worker loop

// ... after `questions` are parsed

// Enhanced Sanity Check (PRD §5.5)
const hasNumericLabels = chunk.blocks.some(b => b.text && /^\s*\d+[.．、]/.test(b.text));
const hasExampleLabels = chunk.blocks.some(b => b.text && /例\d/.test(b.text));

if (questions.length === 0 && (hasNumericLabels || hasExampleLabels)) {
    // High-confidence failure: visible question labels but zero output.
    if (retries < maxRetries) {
        throw new Error(`Sanity Check Failed: Visible question labels found, but LLM returned zero questions.`);
    }
}

// The original ratio check can be a secondary, lower-confidence signal.
const ratio = questions.length / chunk.blocks.length;
if (chunk.blocks.length > 50 && ratio < 0.02 && !hasNumericLabels) {
    // Low-confidence: many blocks, few questions, but no obvious labels. Maybe it's just text.
    // Maybe log a warning instead of retrying, or use a separate, lower retry count for this case.
    console.warn(`[Sanity Check] Low question ratio (${ratio.toFixed(3)}) for chunk ${chunk.index}, but no strong evidence of missed questions.`);
}
```

**风险评估**: **中等风险**。当前实现可能导致题目提取不完整（漏题），影响核心 KPI `提取完整率`。虽然有重试机制，但不够精确，可能在不该重试时重试，或在应该拒绝结果时接受了坏结果。

---

## 4. P2 级优化建议

### [算子 ⑥ ChapterMerge] `cleanChapterTitles` 使用硬编码黑名单

**PRD 要求**: PRD 产品原则五明确反对“硬编码 if/else + 特例补丁”，要求所有规则和策略应以可泛化的信号为基础。

**当前实现**: `extraction.ts` 中的 `cleanChapterTitles` 函数（L576）使用了一个硬编码的 `titleBlacklist` 来过滤“选择题”、“填空题”等噪声标题。

**偏差影响**: 这种方法脆弱且难以维护。当遇到新的题型或噪声模式时，就需要修改代码。它不具备可扩展性，也违背了项目追求可泛化解决方案的原则。

**修复建议**: 将黑名单外部化为可配置的 JSON 文件。更理想的方案是，利用 LLM 在一个单独的 `TitleValidation` 步骤中，根据上下文判断一个标题是否是结构性标题，而不是一个临时性的题型标签。

```typescript
// Suggestion: Move blacklist to a config file, e.g., `config/noise_titles.json`
// ["选择题", "填空题", "判断题", ...]

// In extraction.ts
// const titleBlacklist = JSON.parse(fs.readFileSync('./config/noise_titles.json', 'utf-8'));
```

**风险评估**: **低风险**。当前功能可用，但可维护性和可扩展性差，长期来看会增加维护成本。


## 5. 总结与后续步骤

项目当前版本在核心的章节处理逻辑上与 PRD v2.0 的设计存在严重偏差，必须作为最高优先级进行修复。建议开发团队严格按照本报告中 P0 级别问题的修复建议，依次完成以下工作：

1.  **实现 `ChapterValidation` 算子**，建立数据质量的“防火墙”。
2.  **将 `ChapterOverwrite` 彻底重构为 `ChapterMerge`**，真正利用起两个来源的章节信息。
3.  **修复章节预处理在分块模式下的 ID 空间错误**，确保 LLM 在正确的坐标系下工作。

完成以上 P0 级修复后，再进行完整的回归测试，并着手解决 P1 级问题。
