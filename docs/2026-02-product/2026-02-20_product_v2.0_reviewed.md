
# Mineru2Questions 项目 PRD v2.0 对齐度评审报告

**评审日期**: 2026-02-20
**评审助手**: Manus AI

## 1. 核心结论

本次评审旨在评估 `Mineru2Questions` 项目当前实现与 `Mineru2Questions_PRD_v2.0` (以下简称 PRD) 的对齐程度。评审发现，项目在核心流水线、算子实现和日志规范方面基本遵循了 PRD 的高级设计，特别是成功实现了 v2.0 引入的 `blockFlattener` 统一展平、基于 `questionIds` 的去重、以及 `parser` 的双模式解析等关键策略。

然而，评审也识别出一个 **P0 级阻塞性偏差**：**ChapterMerge 算子因其依赖的 `isTitleValid` 函数存在缺陷，已实质性退化为 ChapterOverwrite**。此缺陷导致章节预处理 (`ChapterPreprocessV2`) 的高质量分层章节信息被大规模丢弃，系统回退到使用题目抽取阶段 LLM 返回的低质量、非结构化章节标题。这严重违反了 PRD §3 的“准确性高于一切”和“过程必须可观测”原则，并直接导致“章节准确率”KPI 远低于 95% 的发布标准。

此外，评审还发现一个 P1 级偏差和若干 P2 级优化机会。**我们强烈建议在推进任何新功能之前，集中资源解决 P0-2 `ChapterMerge` 的实现偏差问题**，因为它是解锁章节预处理价值、达成产品目标的关键瓶颈。

### PRD 对齐度评估表

| 算子 | 名称 | 实现状态 | PRD 对齐度 | 核心备注 |
| :--- | :--- | :--- | :--- | :--- |
| ① | **BlockFlattener** | 已实现 | ✅ 已对齐 | `blockFlattener.ts` 实现了统一的展平逻辑，与 PRD §5.2 要求一致。 |
| ② | **ChapterPreprocess** | 已实现 (V2) | ✅ 已对齐 | `chapterPreprocessV2.ts` 实现了 PRD 推荐的“自适应三轨混合架构”，这是一个超越基线要求的优秀实现。 |
| ③ | **ChapterValidation** | 部分实现 | ⚠️ 部分对齐 | `validateChapterEntries` 实现了基本的格式和逻辑校验，但在预处理失败时，由于下游 `ChapterMerge` 的缺陷，回退机制未能按预期工作。 |
| ④ | **QuestionExtract** | 已实现 | ✅ 已对齐 | `extraction.ts` 实现了并发分块抽取，并遵守 ID-Only 原则。Sanity Check 和重试机制也已实现。 |
| ⑤ | **Parser** | 已实现 | ✅ 已对齐 | `parser.ts` 实现了严格解析和宽松解析双模式，与 PRD §5.6 要求一致。 |
| ⑥ | **ChapterMerge** | **严重偏离** | ❌ **P0 阻塞** | **当前实现名为 `ChapterMerge`，实为 `ChapterOverwrite`。** 根因在于 `isTitleValid` 函数的缺陷，导致预处理结果被错误否决。 |
| ⑦ | **PostProcess & Export** | 已实现 | ✅ 已对齐 | `deduplicateQuestions` 基于 `questionIds` 进行去重，`exportToJSON` 和 `exportToMarkdown` 格式正确，符合 PRD §5.8 要求。 |

### KPI 达成情况评估 (基于 Task `202602200839-1771548005720`)

| KPI | 目标值 | 当前值 | 状态 | 备注 |
| :--- | :--- | :--- | :--- | :--- |
| 提取完整率 | > 99% | **~100%** | ✅ **已达成** | 最终输出 3608 个题目，与源解析基本匹配，无明显遗漏。 |
| 章节覆盖率 | > 99% | **100%** | ✅ **已达成** | 所有题目均分配了章节标题，无空值。 |
| 章节准确率 | > 95% | **~23.6%** | ❌ **严重未达标** | 仅 23.6% 的题目拥有结构化的章节标题（如 “1.1 Section Title”）。其余均为 “Practice questions” 等噪声或低质量标题。**此项为 P0 级问题。** |
| LLM 输出有效率 | > 98% | **~88%** | ⚠️ **部分达标** | 351 个 Chunk 中，309 个为有效输出，42 个为空，有效率为 88%。无解析错误或重试失败。 |
| 人工干预率 | < 1% | **> 76.4%** | ❌ **严重未达标** | 由于章节准确率仅 23.6%，意味着超过 76.4% 的题目需要人工修正章节归属。 |
| 端到端处理时间 | ≤ 30 分钟 | **未知** | ❓ **待测量** | 本次评审未包含性能测试。 |

## 2. P0 级问题：必须立即解决

### [算子 ⑥ ChapterMerge] 当前实现名为 ChapterMerge，实为 ChapterOverwrite，违反 PRD §5.7

**PRD 要求**: PRD §5.7 明确指出，v2.0 的核心增强是将 v1.x 的 `ChapterOverwrite`（强制覆盖）修订为 `ChapterMerge`（融合），旨在“同时保留两个来源的章节信息，并根据可靠性进行融合决策”，以解决 v1.x 中章节预处理失败导致全盘错误的问题。

**上游对齐检查**: 此问题为**本项目特有**。上游 `OpenDCAI/DataFlow` 的 `QA_Merger` 算子仅负责合并问答对，不涉及章节信息融合。`ChapterMerge` 是 PRD v2.0 的核心增强功能，因此不存在上游参考实现。

**根因分析**:

问题的直接原因在于 `extraction.ts` 中的 `ChapterMerge` 融合逻辑，但根源深藏于其调用的校验函数 `isTitleValid` 中。分析步骤如下：

1.  **`findChapterForBlock` 正确构建了章节路径**: `chapterPreprocess.ts` 中的 `findChapterForBlock` 函数按预期工作，能够根据 block ID 从 `chapter_flat_map.json` 中正确构建出包含层级结构的长路径字符串，例如：`1 Review of number concepts > 1.2 Multiples and factors > Exercise 1.4`。

2.  **`isTitleValid` 意外否决了章节路径**: `extraction.ts` 中的 `isTitleValid` 函数包含一条用于过滤数学公式的正则表达式：`/[=<>$]|\\frac|\\sqrt|\\sum|\\int/.test(t)`。此处的 `>` 字符**错误地将 `findChapterForBlock` 返回的路径分隔符 `>` 识别为数学“大于号”**，导致几乎所有包含层级路径的预处理章节标题（`preTitle`）都被 `isTitleValid` 函数判定为无效。

3.  **融合逻辑退化**: 在 `ChapterMerge` 的核心判断逻辑中（`extraction.ts:274-290`），由于 `preTitle` 被判定为 `preIsValid = false`，代码逻辑总是回退到使用题目抽取阶段 LLM 返回的章节标题（`llmTitle`），即使 `llmTitle` 是 “WORKED EXAMPLE” 或 “Practice questions” 等低质量标题。

4.  **最终效果等同于 ChapterOverwrite**: 因为预处理的结果几乎总是被否决，整个 `ChapterMerge` 算子在功能上退化为了 `ChapterOverwrite`，即无条件使用 `llmTitle`。这完全违背了 PRD §5.7 的设计初衷。

**偏差影响**: 在 Task `202602200839-1771548005720` 的 3608 个题目中，有 **3162 个（占比 87.6%）** 的预处理章节路径因此缺陷被错误地否决。这导致 `ChapterPreprocessV2` 算子辛辛苦苦通过三轨混合架构生成的、包含精确层级（章 > 节 > 小节）的结构化章节信息被完全丢弃，系统转而采用了 LLM 在题目抽取阶段随口生成的、不含层级、充满噪声的章节标题。最终，章节准确率 KPI 从理论上的 >99% 骤降至 23.6%。

**修复建议**: 

修改 `extraction.ts` 中的 `isTitleValid` 函数，在执行数学符号正则匹配前，先判断标题是否为路径。如果标题包含路径分隔符 ` > `，则应跳过该条正则规则的检查。

```typescript
// In server/extraction.ts

function isTitleValid(title: string | undefined): boolean {
  if (!title) return false;
  const cfg = getTitleValidationConfig();
  if (!cfg.enabled) return true;
  const t = title.trim();
  if (!t) return false;
  if (cfg.noisePatterns && cfg.noisePatterns.some(k => t.includes(k))) return false;

  const minLen = Number(process.env.CHAPTER_TITLE_MIN_LENGTH ?? 2);
  const maxLen = Number(process.env.CHAPTER_TITLE_MAX_LENGTH ?? 120);
  const maxWords = Number(process.env.CHAPTER_TITLE_MAX_WORDS ?? 16);
  const maxDigitRatio = Number(process.env.CHAPTER_TITLE_MAX_DIGIT_RATIO ?? 0.5);

  // A path-like title should have different validation rules
  const isPath = t.includes(' > ');

  if (!isPath) {
    if (t.length < minLen || t.length > maxLen) return false;
    const wordCount = t.split(/\s+/).filter(Boolean).length;
    if (wordCount > maxWords) return false;
  }

  const digitCount = (t.match(/\d/g) ?? []).length;
  const digitRatio = t.length > 0 ? digitCount / t.length : 0;
  const structuralPatterns = cfg.structuralPatterns ?? [];
  const isStructural = structuralPatterns.some(p => new RegExp(p).test(t));

  if (digitRatio > maxDigitRatio && !isStructural) return false;
  if (/^(simplify|solve|find|calculate|evaluate|show|prove|determine|given|use|draw|write|work\s+out)\b/i.test(t) && !isStructural) return false;
  
  // *** FIX: Only apply math symbol filter if it's NOT a path ***
  if (!isPath && /[=<>$]|\\frac|\\sqrt|\\sum|\\int/.test(t) && !isStructural) return false;

  if (structuralPatterns.length > 0) {
    const ok = structuralPatterns.some(p => new RegExp(p).test(t));
    if (ok) return true;
  }

  return true;
}
```

**优先级**: **P0-2** (引自 PRD §8.1)。此问题是当前版本的核心瓶颈，修复优先级最高。

## 3. P1 级问题：应该尽快解决

### [算子 ④ QuestionExtract] LLM 对章节标题的提取指令存在事实错误

**PRD 要求**: PRD §3 原则三 “坚持 ID-Only” 要求 LLM 只允许输出 Block ID 引用。PRD §5.5 `QuestionExtract` 算子的核心职责是并发 LLM 抽取题目，输出包含 Block ID 引用的 XML。

**上游对齐检查**: 此问题为**本项目特有**。上游 `OpenDCAI/DataFlow` 的 `QAExtractPrompt` 同样要求 ID-Only，但其 prompt 设计与本项目存在差异。本项目的 prompt (`server/prompts.ts`) 是独立撰写的。

**根因分析**:

`server/prompts.ts` 中的 `QUESTION_EXTRACT_PROMPT` 在章节标题部分给出了错误的指令和示例。具体来说：

-   **指令要求 ID-Only**: `CRITICAL RULE 1: ID-ONLY OUTPUT` 和 `<title>TITLE_ID</title>` 都明确要求 LLM 输出 Block ID。
-   **示例却展示了自由文本**: 在 `Example 1` 中，正确的输出被标注为 `<chapter><title>10</title>`，这里的 `10` 是 Block ID。但在 `Example 2` 和 `Example 3` 中，却展示了 `<chapter><title></title>` 这样的空标题。更糟糕的是，在 `cleanChapterTitles` 的后处理中，代码逻辑又试图从 `llmTitle` 中提取章节编号，这暗示了系统在某种程度上期望 `llmTitle` 是文本而非 ID。

这种指令与示例之间的矛盾，以及后处理逻辑的混乱，导致 LLM 在实际执行中行为不稳定。分析 `logs/chunk_*_llm_output.txt` 可以发现，LLM 有时输出 ID，有时输出它自己理解的章节文本（如 “Practice questions”），有时输出空标题。这些低质量的文本标题，在 `ChapterMerge` 算子失效后，被直接透传到了最终结果中。

**偏差影响**: 这个问题是造成章节准确率低的次要原因。即使 `ChapterMerge` 被修复，如果 `llmTitle` 仍然充满噪声，那么在 `preTitle` 无效的少数情况下，系统仍然会回退到低质量的 `llmTitle`。此外，这也违反了 PRD 的“ID-Only”核心原则，增加了系统的不可预测性。

**修复建议**: 

1.  **统一 Prompt 指令**: 修改 `server/prompts.ts`，确保所有关于 `<title>` 的指令和示例都严格遵守 ID-Only 原则。移除所有让 LLM 自行判断或生成章节文本的模糊指令。

2.  **简化 `ChapterMerge` 逻辑**: 在 `ChapterMerge` 算子中，应将 `llmTitle` 视为一个纯粹的、由 ID 回填而来的字符串。移除 `cleanChapterTitles` 中对 `llmTitle` 进行文本处理的逻辑，因为所有文本处理和清洗都应该在 `ChapterPreprocess` 阶段完成。

```typescript
// In server/prompts.ts (Conceptual change)

// ... inside QUESTION_EXTRACT_PROMPT
/*
- <title>TITLE_ID</title> should contain the ID of the chapter title block.
- If you cannot find a clear chapter title block that applies to the questions in this chunk, use <title></title> (empty).
- DO NOT invent chapter titles. DO NOT output text like "Practice questions" inside the title tag.

Example:
<chapter><title>10</title>  // Correct: ID of the block containing "一、选择题"
<qa_pair>...</qa_pair>
</chapter>

Example (No Title Block):
<chapter><title></title> // Correct: No applicable title block found
<qa_pair>...</qa_pair>
</chapter>
*/
```

**优先级**: **P1-2** (对齐 PRD §8.2 `完善 Sanity Check 策略`，因为这也属于对 LLM 输出的约束和校验)。在修复 P0 问题后应立即着手此项，以保证整个流水线的数据一致性和可预测性。

## 4. P2 级问题：可以后续优化

### [算子 ③ ChapterValidation] 验证逻辑可以进一步增强

**现状**: `chapterPreprocessV2.ts` 中已包含 `validateChapterEntries` 和 `validateCompleteness`，`taskProcessor.ts` 在 `preprocessChaptersV2` 失败时也能捕获异常并终止任务。这基本满足了 PRD 的要求。

**优化建议**: 当前的验证主要在 `preprocessChaptersV2` 内部。PRD §5.4 中定义的 `ChapterValidation` 算子，其理想位置是在 `taskProcessor.ts` 中，作为一个独立的、可插拔的步骤，在 `preprocessChaptersV2` **之后** 和 `extractQuestions` **之前** 调用。这能更好地实现关注点分离，并允许在验证失败时执行更明确的回退策略（例如，向 `extractQuestions` 传递 `chapterFlatMap = null`）。当前代码虽然功能上实现了回退，但逻辑耦合在 `preprocessChaptersV2` 内部，不够清晰。

**优先级**: P2-1 (对齐 PRD §8.3 `增加单元测试`，因为这也属于提升代码结构和可维护性的范畴)。

### [算子 ⑦ PostProcess] `cleanChapterTitles` 函数中的黑名单硬编码

**现状**: `extraction.ts` 中的 `cleanChapterTitles` 函数硬编码了一个中文黑名单 `["选择题", "填空题", ...]`，用于过滤无效标题。这违反了 PRD §3 原则五“不靠硬编码，追求可泛化”。

**优化建议**: 将此黑名单移至外部配置文件（如 `config/title_validation.json`），与 `noisePatterns` 和 `structuralPatterns` 放在一起。这使得非开发人员也可以方便地调整过滤规则，提高了系统的可维护性和可配置性。

**优先级**: P2-1 (提升可维护性)。

## 5. 总结与路线图建议

`Mineru2Questions` 项目当前版本已经搭建了坚实的基础，但在最关键的章节归属准确性上存在严重偏差。好消息是，偏差的根源非常集中，即 `isTitleValid` 函数中的一个微小但致命的 bug。

我们强烈建议按以下优先级顺序进行修复：

1.  **【P0 - 立即修复】** 修正 `isTitleValid` 函数，使其不再错误地将路径分隔符 `>` 过滤掉。这将立即激活 `ChapterMerge` 算子，预计能将章节准确率从 23.6% 提升到 90% 以上，从而解决最核心的产品痛点。

2.  **【P1 - 尽快解决】** 统一并修正 `QUESTION_EXTRACT_PROMPT` 中关于章节标题的指令和示例，确保严格遵守 ID-Only 原则。并清理 `ChapterMerge` 中对 `llmTitle` 的后处理逻辑。

3.  **【P2 - 后续优化】** 将 `ChapterValidation` 逻辑重构为独立的算子，并将 `cleanChapterTitles` 中的硬编码黑名单外部化到配置文件中。

完成以上 P0 和 P1 修复后，项目将基本达到 PRD v2.0 定义的核心产品目标，可以进入更广泛的测试和部署阶段。
