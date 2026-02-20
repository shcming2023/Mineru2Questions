# Mineru2Questions `feature/adaptive-chapter-preprocess` 分支评审报告

**评审目标**: 严格依据 `Mineru2Questions_PRD_v2.0`（下称 “PRD”），对 `feature/adaptive-chapter-preprocess` 分支的代码实现、V2 章节预处理架构及测试任务输出进行全面对齐评审。

**核心结论**: `feature/adaptive-chapter-preprocess` 分支成功实现了一套先进的、基于 TOC、模式和 LLM 的自适应三轨道章节预处理架构 (`chapterPreprocessV2.ts`)，在设计上远超 v1 版本，并正确识别了测试任务中的 TOC 页面，触发了 TOC+Pattern 双轨道，实现了 98.9% 的高覆盖率。然而，在与 PRD v2.0 的核心原则和具体算子要求对齐时，发现 **2 个 P0 级严重偏差** 和 **3 个 P1/P2 级中度问题**，这些问题导致 V2 架构的优势被完全抵消，数据质量甚至劣于 v1。其中，**ChapterMerge 算子未能正确实现是问题的核心**。

## PRD v2.0 对齐度评估表

| 算子 | 名称 | 实现状态 | PRD 对齐度 | 核心发现 | PRD 章节 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| ① | **BlockFlattener** | 已实现 | ✅ **已对齐** | 实现良好，逻辑清晰，符合 PRD 要求。 | §5.2 |
| ② | **ChapterPreprocess** | 已实现 (V2) | ⚠️ **部分对齐** | V2 架构设计先进，但缺少关键的验证环节。 | §5.3 |
| ③ | **ChapterValidation** | **未实现** | ❌ **严重偏离 (P0)** | V2 流程中完全缺失此算子，违反“优雅降级”原则。 | §5.4, §8.1 |
| ④ | **QuestionExtract** | 已实现 | ✅ **已对齐** | Sanity Check + 重试机制实现良好。 | §5.5 |
| ⑤ | **Parser** | 已实现 | ✅ **已对齐** | 双模式解析（Strict/Lenient）符合 PRD 要求。 | §5.6 |
| ⑥ | **ChapterMerge** | **实现错误** | ❌ **严重偏离 (P0)** | 逻辑存在致命缺陷，导致预处理结果被完全忽略。 | §5.7, §8.1 |
| ⑦ | **PostProcess & Export** | 已实现 | ⚠️ **部分对齐** | 去重逻辑符合 PRD，但章节标题清洗存在优化空间。 | §5.8 |

## 详细评审发现与修复建议

### [P0-2] 算子 ⑥ ChapterMerge: 因校验逻辑缺陷，ChapterMerge 降级为 ChapterOverwrite

**PRD 要求**: PRD §5.7 明确规定，v2.0 的核心增强是将章节处理从“强制覆盖”修订为“融合”，即“同时保留两个来源（预处理、题目抽取）的章节信息，并根据可靠性进行融合决策”。PRD §8.1 将此项列为 P0-2 级任务。

**上游对齐检查**: 此问题为**本项目特有**。上游 `OpenDCAI/DataFlow` 的 `QA_Merger` 仅负责合并问答对，不涉及章节信息融合。`ChapterMerge` 是 PRD v2.0 的核心增强功能，不存在上游参考实现。

**根因分析**: `extraction.ts` 中的章节融合逻辑存在一个致命缺陷。`isTitleValid` 函数（L389）用于验证标题的合法性，其内部的数学符号校验正则表达式 `/[=<>$]|\\frac|\\sqrt|\\sum|\\int/` **错误地包含了 `>` 字符**。`chapterPreprocessV2` 成功生成了高质量的、带层级结构的路径式标题（例如 `1 Review of number concepts > 1.2 Multiples and factors`），但这些标题在融合阶段因为包含了路径分隔符 `>` 而被 `isTitleValid` 函数判定为无效。分析测试任务 `202602180755-1771372565636` 的中间产物发现，超过 99% 的 L2 和 L3 层级路径标题因此被错误拒绝。

**偏差影响**: 由于所有来自预处理的高质量路径标题（`preTitle`）都被判定为无效（`preIsValid = false`），融合逻辑（L274-L288）几乎总是回退到选择 LLM 在题目抽取阶段自行生成的、不含层级结构的、往往是噪声的标题（`llmTitle`）。测试结果显示，**3358 个本应拥有完整路径的章节标题被忽略**，最终输出的 `questions.json` 中充满了大量 “Practice questions”, “WORKED EXAMPLE” 等低质量标题，完全违背了 PRD 的设计初衷。这使得 `chapterPreprocessV2` 的全部努力付诸东流。

**修复建议**: 立即修正 `extraction.ts` L409 的正则表达式，移除对 `>` 字符的匹配。

```typescript
// server/extraction.ts:409

// 错误实现
if (/[=<>$]|\\frac|\\sqrt|\\sum|\\int/.test(t) && !isStructural) return false;

// 修复后
if (/[=<$]|\\frac|\\sqrt|\\sum|\\int/.test(t) && !isStructural) return false;
```

**优先级**: **P0-2** (引自 PRD §8.1)

---

### [P0-1] 算子 ③ ChapterValidation: V2 预处理流程缺失验证算子，无法优雅降级

**PRD 要求**: PRD §5.4 要求设立独立的 `ChapterValidation` 算子，对 `ChapterPreprocess` 的输出进行格式、ID 和逻辑合理性验证。如果验证失败，必须输出 `null`，触发下游的优雅降级（回退到使用题目抽取自带的章节信息）。PRD §8.1 将此项列为 P0-1 级任务。

**上游对齐检查**: 此问题为**本项目特有**。上游 `OpenDCAI/DataFlow` 没有章节预处理的概念，因此不存在此算子。

**根因分析**: 代码审查发现，新的 `chapterPreprocessV2.ts` 虽然实现了复杂的三轨道融合，但在主函数 `preprocessChaptersV2` (L1078) 的末尾，直接调用 `buildChapterTree` 生成 `flatMap` 并返回，**完全没有调用任何验证逻辑**。旧的 `validateChapterEntries` 函数存在于 `chapterPreprocess.ts` 中，但并未在 V2 流程中复用或被替代。

**偏差影响**: 如果 V2 预处理的任一轨道（特别是 TOC 解析）出现严重逻辑错误（例如，将一本非教材的普通 PDF 误判，生成数千个混乱的章节锚点），系统没有机制来捕捉这种异常。一个结构错误的 `flatMap` 会被直接传递给下游的 `ChapterMerge`，可能导致大范围的题目章节归属错误，甚至引发运行时崩溃。这直接违反了 PRD “拥抱失败，优雅降级”的核心原则。

**修复建议**: 在 `preprocessChaptersV2` 函数的 `buildChapterTree` 之后，**必须**增加一个验证步骤。建议新增一个 `validateChapterTree` 函数，并将其集成到主流程中。

```typescript
// server/chapterPreprocessV2.ts (新增函数)

function validateChapterTree(flatMap: ChapterFlatEntry[], totalBlocks: number): { ok: boolean; error?: string } {
  if (flatMap.length === 0) return { ok: true }; // 允许空结果

  const totalEntries = flatMap.length;
  const level1Count = flatMap.filter(e => e.level === 1).length;

  // 规则1: L1 章节占比不能过高 (例如 > 50%)，表明可能将普通文本误判为章节标题
  if (totalEntries > 20 && level1Count / totalEntries > 0.5) {
    return { ok: false, error: `Abnormally high percentage of level-1 entries (${level1Count}/${totalEntries})` };
  }

  // 规则2: 章节条目总数不能过多 (例如 > 总 block 数的 25%)，表明解析失控
  if (totalBlocks > 100 && totalEntries / totalBlocks > 0.25) {
    return { ok: false, error: `Too many chapter entries (${totalEntries}) relative to total blocks (${totalBlocks})` };
  }

  // 更多规则：ID 连续性、范围有效性等

  return { ok: true };
}

// server/chapterPreprocessV2.ts -> preprocessChaptersV2() (修改主函数)

// ... 在 buildChapterTree 之后
const flatMap = buildChapterTree(mergedAnchors, blocks);
console.log(`[ChapterV2] 目录树: ${flatMap.length} 个条目`);

// 新增验证步骤
const validation = validateChapterTree(flatMap, blocks.length);
if (!validation.ok) {
  console.error(`[ChapterValidationV2] Failed: ${validation.error}. Returning empty flatMap.`);
  // 返回空结果以触发优雅降级
  return {
    flatMap: [],
    blocks,
    coverageRate: 0,
    totalEntries: 0,
  };
}

// ... 继续后续流程
```

**优先级**: **P0-1** (引自 PRD §8.1)

---

### [P1-3] 算子 ⑥ ChapterMerge: 融合策略过于保守，应优先选择结构化路径

**PRD 要求**: PRD §5.7 暗示融合决策应基于“可靠性”。结构化的、带有层级路径的章节标题（来自预处理）通常比 LLM 在小窗口内生成的单点标题（来自题目抽取）更可靠。

**上游对齐检查**: 无关。

**根因分析**: `extraction.ts` 的融合逻辑（L278-L288）在 `preIsValid` 和 `llmIsValid` 均为 `true` 时，其决策顺序为：`preMatchesStructural` -> `llmMatchesStructural` -> `preHasPath` -> `else (llm)`。由于 `structuralPatterns` 默认未配置，前两步不会触发。决策落入 `preHasPath`，即“如果预处理标题包含路径，则选择预处理标题”。**这个逻辑本身是正确的**。但一旦 P0-2 的 bug 被修复，我们预计会出现新的问题：当 LLM 碰巧也生成了一个有效的、但层级较浅的标题时（例如 `1.2 Multiples and factors`），而预处理提供了更完整的路径（`1 Review of number concepts > 1.2 Multiples and factors`），当前逻辑会优先选择预处理结果，这是符合预期的。但如果两者都有效且 `preHasPath` 为 `false`，则会回退到选择 LLM。这在某些情况下可能不是最优选择。

**偏差影响**: 当前实现倾向于在两者都有效时选择 LLM 标题，除非预处理标题是路径格式。这可能导致丢失部分上下文信息。例如，如果预处理标题是 `Chapter 1 Review`，LLM 标题是 `Review`，两者都有效且不含路径，当前逻辑会选择 `Review`，丢失了 `Chapter 1` 的信息。

**修复建议**: 调整融合逻辑，在两者都有效时，**无条件优先选择预处理结果**，因为它基于全局视角生成，更可靠。只有在预处理结果无效时，才考虑使用 LLM 的结果。

```typescript
// server/extraction.ts:274

// 简化和优化后的逻辑
if (preIsValid) {
  q.chapter_title = preTitle as string;
} else if (llmIsValid) {
  q.chapter_title = llmTitle as string;
} else {
  q.chapter_title = "";
}
```

**优先级**: **P1-3** (新发现，建议优先级 P1)

---

### [P2-1] 算子 ⑦ PostProcess: 章节标题清洗逻辑（`cleanChapterTitles`）存在不足

**PRD 要求**: PRD §5.8 要求对最终结果进行后处理。PRD §15 的历史教训中提到，应避免“硬编码黑名单清洗章节标题”。

**上游对齐检查**: 上游 `refine_title` 函数使用了更激进的策略，直接提取数字编号作为标题，与本项目 PRD 要求不符。

**根因分析**: `extraction.ts` 中的 `cleanChapterTitles` 函数（L666）仍在大量使用硬编码的黑名单（`titleBlacklist`）来过滤噪声标题。虽然这是 v1 时代的遗留问题，但在 V2 架构下，当 `ChapterMerge` 修复后，这个问题会变得不那么突出，但依然存在。例如，LLM 偶尔生成的 “Simplify. Show the steps in your working.” 这类标题，目前依赖黑名单过滤，不够稳健。

**偏差影响**: 依赖硬编码黑名单，可维护性差，无法泛化到新的噪声模式。当 `ChapterMerge` 修复后，大部分噪声会被高质量的预处理标题覆盖，但对于预处理失败的边缘情况，此问题依然存在。

**修复建议**: 这是一个长期优化项。短期内可保留现有逻辑。长期看，应废弃 `cleanChapterTitles`，将所有清洗和验证逻辑统一到 `isTitleValid` 函数中，使其成为唯一决策点。例如，通过增强 `isTitleValid` 的启发式规则（如“以动词开头的短句是无效标题”）来替代黑名单。

**优先级**: **P2-1** (新发现，建议优先级 P2)

---

### [P2-4] 算子 ② ChapterPreprocess: V2 的 LLM 轨道未实现

**PRD 要求**: PRD §5.3 要求进行章节预处理。

**上游对齐检查**: 无关。

**根因分析**: `chapterPreprocessV2.ts` 的调度逻辑 `dispatch` (L836) 在检测到 TOC 或文档较短时，会将 `useLLM` 设置为 `false`。在本次测试任务中，由于成功检测到 TOC，`useLLM` 被设为 `false`，因此 LLM 轨道 `detectLLMAnchors` (L676) 并未执行。代码审查发现 `detectLLMAnchors` 的实现是存在的，但其核心是扫描 `TOC` 和 `Pattern` 轨道未覆盖的“间隙区域”。

**偏差影响**: 这并非一个 bug，而是设计使然。该设计是合理的，旨在节约成本和时间。当 TOC 和模式匹配足够好时，无需启动昂贵的 LLM 轨道。但需要明确，当前测试并未覆盖 LLM 轨道的功能。

**修复建议**: 无需修复。建议在后续测试中，使用一个没有目录、章节模式也不明显的文档来专门测试 LLM 轨道的有效性和鲁棒性。

**优先级**: **P2-4** (新发现，建议优先级 P2，归类于“支持批量任务”前的测试完善)

## 总结与后续步骤

`feature/adaptive-chapter-preprocess` 分支在章节预处理架构上取得了巨大进步，但因 `ChapterMerge` 算子的一个微小但致命的 bug，导致整个 V2 架构的优势未能体现。当前的首要任务是：

1.  **立即修复 P0-2 问题**：修改 `isTitleValid` 中的正则表达式，让正确的路径标题能够通过验证。
2.  **立即实现 P0-1 功能**：为 `preprocessChaptersV2` 增加独立的 `ChapterValidation` 步骤，确保流水线的鲁棒性。

完成以上两点后，建议重新运行测试任务，并再次检阅 `results/questions.json`，预期将看到绝大部分题目的 `chapter_title` 字段被替换为高质量的、带层级结构的路径标题。届时，该分支的核心价值才能真正体现，并达到 PRD v2.0 的发布标准。
