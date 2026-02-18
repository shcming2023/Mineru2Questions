
# Mineru2Questions 项目 PRD v2.0 对齐评审报告

**日期**: 2026-02-16
**评审人**: Manus AI
**目标**: 依据 `Mineru2Questions_PRD_v2.0`，对项目当前的代码实现、测试结果进行全面评审，识别与 PRD 的偏差，并提供根因分析与修复建议。

---

## 1. 评审总结

项目在核心的题目抽取（ID-Only）、Block 展平、并发处理等方面与 PRD v2.0 和上游参考架构保持了较好的一致性。然而，在 **v2.0 新增的核心功能——章节预处理与融合（ChapterPreprocess & ChapterMerge）上，存在 P0 级严重偏差**。当前的实现不仅未能达到 PRD 设计目标，其内置的验证机制也已失效，导致在两个测试任务中均输出了错误的章节数据，严重影响了“章节归属准确性”这一核心 KPI。

此外，在题目抽取质量、解析鲁棒性等方面也发现了一些 P1 和 P2 级问题。当前实现距离 PRD §7 定义的发布标准尚有较大差距，必须优先解决 P0 级问题。

### PRD 对齐度评估表

| 算子 | 名称 | 实现状态 | PRD 对齐度 | 关键偏差说明 |
| :--- | :--- | :--- | :--- | :--- |
| ① | **BlockFlattener** | 已实现 | ✅ 已对齐 | 功能符合 PRD 要求，且有增强。 |
| ② | **ChapterPreprocess** | 已实现 | ❌ 严重偏离 | **P0-3**: 分块模式下存在严重的 ID 空间错乱问题。 **P1-1**: 章节识别质量极低，将大量非标题内容（题目、普通文本）识别为章节。 |
| ③ | **ChapterValidation** | 已实现 | ❌ 严重偏离 | **P0-1**: 验证逻辑在当前测试输出中完全失效，未能拦截不合理的章节结构，导致下游数据污染。 |
| ④ | **QuestionExtract** | 已实现 | ✅ 已对齐 | 核心的 ID-Only 题目抽取逻辑符合 PRD 要求。 |
| ⑤ | **Parser** | 已实现 | ⚠️ 部分对齐 | **P2-3**: 存在对超大 `equation` Block 的不合理回填，导致生成了数万字符的“题目”，影响可读性。 |
| ⑥ | **ChapterMerge** | 已实现 | ❌ 严重偏离 | **P0-2**: 当前实现为 `ChapterOverwrite`（强制覆盖），而非 PRD 要求的 `ChapterMerge`（融合），导致预处理的错误被无条件应用。 |
| ⑦ | **PostProcess & Export** | 已实现 | ✅ 已对齐 | 基于 `questionIds` 的去重策略已正确实现，符合 PRD §5.8 和历史教训。 |

### KPI 达成情况评估 (基于 Task 1 & 2)

| KPI | 目标值 | 当前状态 | 评估 |
| :--- | :--- | :--- | :--- |
| 提取完整率 | > 99% | 较高 | ✅ 接近达成。未发现大规模题目遗漏。 |
| 章节覆盖率 | > 99% | 100% | ⚠️ **误导性指标**。虽然所有题目都有章节，但几乎都是错误的。 |
| 章节准确率 | > 95% | **< 5%** | ❌ **严重未达标**。由于 P0 级偏差，章节映射基本完全错误。 |
| LLM 输出有效率 | > 98% | 较高 | ✅ 题目抽取阶段 LLM 遵守了 XML 格式。章节预处理阶段 LLM 输出的 JSON 存在截断问题。 |
| 人工干预率 | < 1% | **> 95%** | ❌ **严重未达标**。当前的章节结果完全不可用，需要 100% 人工干预。 |
| 端到端处理时间 | ≤ 30 分钟 | 未测试 | - | 

---

## 2. P0 级偏差：必须立即解决

### [算子 ③ ChapterValidation] P0-1: 验证逻辑失效，未能拦截异常章节结构

**PRD 要求**: PRD §5.4 明确要求 `ChapterValidation` 算子需对 `ChapterPreprocess` 输出的章节候选进行逻辑合理性验证，并在失败时输出 `null` 以触发下游回退。PRD §15 的历史教训也强调“LLM 输出不做验证直接使用”是必须避免的失败策略。

**上游对齐检查**: 此问题为**本项目特有**。上游 `OpenDCAI/DataFlow` 无独立的章节预处理和验证算子，因此无参考实现。

**根因分析**: 
1.  **问题现象**: 在 Task 1 和 Task 2 中，`debug/chapter_flat_map.json` 文件均被成功生成。然而，分析其内容发现，Task 1 的 492 个条目和 Task 2 的 426 个条目，**全部都是 `level: 1`**。
2.  **逻辑审查**: 根据 `server/chapterPreprocess.ts` 中 `validateChapterEntries` 函数的逻辑（L656），当 `totalEntries > 20` 且 `level1Count / totalEntries > 0.5` 时，应返回 `{ ok: false }`。在两个 Task 中，该条件（`492/492 > 0.5` 和 `426/426 > 0.5`）均成立，验证本应失败。
3.  **结论**: `chapter_flat_map.json` 的存在证明了验证逻辑返回了 `{ ok: true }`，这与代码逻辑严重不符。最可能的原因是，**当前 `main` 分支中的测试输出 (`server/uploads/tasks`) 是在一个较旧的代码版本上生成的，当时 `validateChapterEntries` 的逻辑尚未实现或存在 Bug**。`git log` 显示 `validateChapterEntries` 的相关实现在近期的提交中才被整合。因此，这是一个**流程问题**：代码更新后，没有使用最新的代码重新运行测试并更新测试产物。

**偏差影响**: 这是流水线中最严重的问题。失效的验证层使得后续所有基于章节的操作（特别是 P0-2 的强制覆盖）都建立在垃圾数据之上，导致“章节准确率”KPI 彻底失败。它破坏了 PRD “拥抱失败，优雅降级”的核心原则。

**修复建议**: 
1.  **立即使用当前最新的 `main` 分支代码，重新运行 Task 1 和 Task 2**。这会验证 `ChapterValidation` 是否能如预期般触发失败，并生成空的 `chapter_flat_map.json`。
2.  在 `taskProcessor.ts` 中，必须确保当 `chapterPreprocess` 返回的 `flatMap` 为空时，传递给 `extraction` 算子的 `chapterFlatMap` 确实是 `[]` 或 `null`。

**优先级**: **P0-1** (引自 PRD §8.1)

---

### [算子 ⑥ ChapterMerge] P0-2: 当前实现为 ChapterOverwrite，违反 PRD §5.7

**PRD 要求**: PRD §5.7 明确指出，v2.0 的核心增强之一是将 v1.x 的 `ChapterOverwrite`（强制覆盖）修订为 `ChapterMerge`（融合），以应对章节预处理不稳定的问题。PRD §15 的历史教训中，`强制覆盖章节信息 (ChapterOverwrite)` 被列为“已验证的失败策略”。

**上游对齐检查**: 此问题为**本项目特有**。上游 `QA_Merger` 不涉及章节信息融合。

**根因分析**: 代码审查 `server/extraction.ts` 中的 `processChunk` 函数（L200-L210），发现其通过 `findChapterForBlock` 函数为每个提取出的题目重新确定章节。`findChapterForBlock` 的实现是基于 `chapterFlatMap` 进行查找。这意味着，无论题目抽取阶段 LLM 自己输出的 `<chapter><title>` 是什么，都会被 `chapterFlatMap` 的结果**无条件覆盖**。

**偏差影响**: 此问题与 P0-1 共同导致了灾难性后果。当 `ChapterValidation` 失效时，一个充满噪声的 `chapter_flat_map.json` 被生成；然后 `ChapterOverwrite` 将这些错误的章节信息强制应用到所有题目上。例如，在 Task 2 中，大量题目的章节被错误地标为“3 Simplify. Show the steps in your working.”或“Cambridge IGCSE Mathematics (0580) Paper 21 Q14, June 2020”等显然是题目或备注的文本。

**修复建议**: 必须重构 `processChunk` 中的章节处理逻辑，实现 PRD 定义的 `ChapterMerge`。伪代码如下：

```typescript
// In server/extraction.ts, inside processChunk

for (const extracted_question of extracted_from_llm) {
  const llm_chapter_title = extracted_question.chapter_title; // From QuestionExtract stage
  
  // findChapterForBlock can be reused, but its result is now just one source of truth
  const preprocessed_chapter_title = findChapterForBlock(extracted_question.questionIds[0], chapterFlatMap);

  // *** NEW MERGE LOGIC START ***
  let final_chapter_title = llm_chapter_title; // Default to LLM's own extraction

  // PRD §5.7.2: If ChapterPreprocess failed, chapterFlatMap will be empty.
  // In that case, preprocessed_chapter_title will be empty, and we gracefully use llm_chapter_title.
  if (chapterFlatMap && chapterFlatMap.length > 0) {
      // Here, implement the actual merge logic.
      // For now, a simple priority: prefer preprocessed if it's not noisy.
      if (preprocessed_chapter_title && !isNoisy(preprocessed_chapter_title)) {
          final_chapter_title = preprocessed_chapter_title;
      } else if (!llm_chapter_title && isNoisy(preprocessed_chapter_title)) {
          // If both are bad, prefer empty.
          final_chapter_title = '';
      }
  }
  // *** NEW MERGE LOGIC END ***

  // Use the merged title
  const final_question = {
    ...extracted_question,
    chapter_title: final_chapter_title,
  };
  
  processed_questions.push(final_question);
}
```

**优先级**: **P0-2** (引自 PRD §8.1)

---

### [算子 ② ChapterPreprocess] P0-3: 分块模式下 ID 空间错乱

**PRD 要求**: PRD §5.3 要求章节预处理必须能处理大型文档，并正确映射 Block ID。所有算子都必须在全局统一的 `FlatBlock[]` ID 空间下工作。

**上游对齐检查**: 此问题为**本项目特有**。

**根因分析**: 
1.  **问题现象**: Task 2（大型文档）触发了章节预处理的分块模式。分析 `debug/chapter_chunk_1_response_attempt1.json` 发现，LLM 返回的 JSON 中包含了大量 Block ID，其范围从 237 到 12532。然而，`debug/chapter_flat_map.json` 的 ID 范围却是从 12448 到 12877。
2.  **结论**: 这表明，在为章节预处理准备 Prompt 时，传递给 LLM 的 Block 信息可能使用了**相对于 Chunk 的局部 ID**，或者在 ID 回填时发生了严重错误。LLM 无法在没有全局上下文的情况下正确输出全局 ID。这违反了“坚持 ID-Only”原则背后的“全局唯一 ID”假设。

**偏差影响**: 这是导致 Task 2 章节预处理完全失败的直接原因。错误的 ID 使得后续所有处理步骤都无法正确映射回原始 Block，最终生成了无意义的 `chapter_flat_map`。

**修复建议**: 必须审查 `server/chapterPreprocess.ts` 中处理分块的逻辑 (`if (estTokens > limit)`)。确保传递给 `getChapterJSON` 的 `chunkBlocks` 参数中的每个 `FlatBlock` 都保留其**原始的、全局的 ID**。同时，确保 Prompt 中明确指示 LLM 使用这些全局 ID。

```typescript
// In server/chapterPreprocess.ts, inside the chunking loop

const chunkBlocks = blocks.slice(i, i + chunkSize);

// CRITICAL: Ensure chunkBlocks contains blocks with their ORIGINAL global IDs.
// The prompt sent to LLM for this chunk MUST contain these global IDs.
const prompt = buildChapterPrompt(chunkBlocks, round); // This function must use global IDs

// ... when processing the response
const llmJson = await getChapterJSON(...);

// The IDs inside llmJson.directory should be GLOBAL IDs, which can be directly
// validated against the full `blocks` array.
```

**优先级**: **P0-3** (引自 PRD §8.1)

---

## 3. P1 级问题：应尽快解决

### [算子 ② ChapterPreprocess] P1-1: 章节识别质量极低，混入大量噪声

**PRD 要求**: PRD §5.3 的核心职责是“识别全文章节结构”。

**上游对齐检查**: 此问题为**本项目特有**。

**根因分析**: 分析两个 Task 的 `chapter_flat_map.json`（即使它们本应被 P0-1 拦截），发现内容质量极低。LLM 将大量非章节标题的内容识别为了章节，包括：
*   **题目文本**: “3 Simplify. Show the steps in your working.” (Task 2)
*   **解题步骤**: “$z^3 = -1,331$” (Task 1)
*   **图片说明**: “The diagram shows two parallel lines...” (Task 2)
*   **普通段落**: “Your Task: Going, Going, Gone?” (Task 1)

这表明当前的 Prompt 不足以让 LLM 准确区分章节标题和普通内容，或者 LLM 的能力不足以完成这个复杂的区分任务。

**偏差影响**: 即使 P0 级问题被修复，低质量的章节识别结果也会严重影响“章节准确率”，无法达到 >95% 的目标。

**修复建议**: 
1.  **增强 Prompt**: 在 `chapterPreprocess` 的 Prompt 中增加更严格的 few-shot 示例，明确给出反例（哪些是题目、哪些是普通文本，不应被提取）。
2.  **引入 Block 类型作为信号**: 在 Prompt 中利用 `FlatBlock` 的 `type` 属性（如 `heading`, `text`, `list_item`），告知 LLM 章节标题通常具有 `heading` 类型，这能提供强有力的结构化信号。
3.  **后处理清洗**: 在 `postProcessCleanup` 函数中增加规则，过滤掉明显是噪声的章节条目（例如，包含 “=”, “$”, “solve” 等关键词，或长度过短/过长）。

**优先级**: **P1-1** (引自 PRD §8.2)

---

## 4. P2 级问题：可以后续优化

### [算子 ⑤ Parser] P2-1 (新发现): 超大 Equation Block 导致题目内容过长

**PRD 要求**: PRD §5.6 要求对 LLM 输出的 XML 进行解析和 ID 回填。

**上游对齐检查**: 上游 `_id_to_text` 函数同样是直接回填，未考虑内容长度。

**根因分析**: 在 Task 2 中，发现 Q815 和 Q832 的 `question` 字段长度分别达到了惊人的 49KB 和 16KB。分析其 `questionIds` 发现，它们包含了一个 `type: 'equation'` 的 Block。这个 Block 的 `text` 属性包含了巨量的、可能是由 MinerU OCR 错误产生的 LaTeX 文本。

**偏差影响**: 虽然这不影响题目提取的完整性，但生成了几乎不可读的 `questions.json` 和 `.md` 文件，降低了最终产物的可用性，也可能给前端渲染带来压力。

**修复建议**: 在 `parser.ts` 的 `idToText` 函数中增加一个长度限制。当遇到超长的 Block（特别是 `equation` 类型）时，可以进行截断，并附上提示，例如 `[... long equation truncated ...]`。

```typescript
// In server/parser.ts, inside idToText

const MAX_BLOCK_LENGTH = 4096; // Example limit

// ... inside the loop over blocks
let blockText = block.text;
if (blockText && blockText.length > MAX_BLOCK_LENGTH) {
  blockText = blockText.substring(0, MAX_BLOCK_LENGTH) + `\n[... content truncated ...]`
}
texts.push(blockText);
```

**优先级**: **P2 (新发现)**

---

## 5. 总结与后续步骤

当前项目构建在坚实的基础（ID-Only, 并发抽取）之上，但 v2.0 的核心功能 `ChapterPreprocess` 和 `ChapterMerge` 的实现存在根本性偏差，且验证机制失效，导致无法交付可用的章节数据。**强烈建议暂停所有其他功能的开发，集中力量解决上述三个 P0 级问题。**

**建议路线图**:
1.  **第一步 (P0-1 & P0-3)**: 修复 `ChapterPreprocess` 的 ID 空间问题，并使用最新代码重新运行测试，确保 `ChapterValidation` 能够按预期工作，对于低质量的章节输出生成空的 `chapter_flat_map.json`。
2.  **第二步 (P0-2)**: 实现真正的 `ChapterMerge` 逻辑，确保在 `chapter_flat_map.json` 为空时，系统能优雅地回退到使用题目抽取阶段自带的章节信息。
3.  **第三步 (P1)**: 在 P0 问题解决后，迭代优化 `ChapterPreprocess` 的 Prompt 和后处理逻辑，以提升章节识别的准确率。
4.  **第四步 (P2)**: 解决内容过长等体验优化问题。

完成以上步骤后，项目才能重新对齐 PRD v2.0 的核心目标，并向可发布的标准迈进。
