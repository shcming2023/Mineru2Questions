# Mineru2Questions 分支评审报告

**分支**: `feature/adaptive-chapter-preprocess`
**评审日期**: 2026-02-16
**评审范围**: 自适应三轨混合架构（`chapterPreprocessV2.ts`）+ 策略链模块（`strategies.ts`）+ 两轮端到端测试产物
**评审依据**: PRD v2.0 §5.2-§5.8, §7, §8, §15

---

## 一、执行摘要

本次评审覆盖了 `feature/adaptive-chapter-preprocess` 分支上的全部代码变更和两轮测试产物。**核心结论是：V2 架构在有目录页（TOC）的大型文档上表现出色，章节覆盖率从之前的 49.3% 跃升至 98.9%，是一次质的飞跃。但在无目录页的小型文档上，由于下游 ChapterMerge 算子的融合策略缺陷，V2 的优势未能传导到最终输出，47.5% 的题目仍然携带噪声标题。**

| 指标 | Cambridge IGCSE 0580 | Envision G8 |
| :--- | :--- | :--- |
| 文档规模 | 891 页 / 24,566 Blocks | 78 页 / 1,727 Blocks |
| 有无目录页 | ✅ 有（page 5-7） | ❌ 无 |
| V2 目录树条目数 | **361**（L1:40, L2:104, L3:217） | **17**（全部 L2） |
| V2 Block 覆盖率 | **98.9%** | **95.1%** |
| 最终题目数 | 3,517 | 373 |
| 路径格式标题占比 | **93.8%**（3,298/3,517） | **0%**（0/373） |
| 噪声标题占比 | ~0% | **47.5%**（177/373） |

---

## 二、按算子阶段逐段对齐

### [算子 ① BlockFlattener] 已对齐 ✅

**PRD 要求** (§5.2): 将嵌套的 `content_list.json` 展平为连续编号的 `FlatBlock[]`，ID 从 0 开始连续递增。

**实现状态**: `blockFlattener.ts` 未变更，继续正常工作。两轮测试中 Block ID 均从 0 开始连续递增（Cambridge: 0-24,565; Envision: 0-1,726）。

**结论**: 完全对齐，无需修改。

---

### [算子 ② ChapterPreprocess] 已对齐 ✅（V2 架构）

**PRD 要求** (§5.3): 识别全文章节结构，输出章节候选 JSON。

**V2 架构评审**:

`chapterPreprocessV2.ts`（1,187 行）实现了"自适应三轨混合架构"，是本次分支的核心变更。该架构由三个独立的轨道组成：

| 轨道 | 名称 | 触发条件 | Cambridge 效果 | Envision 效果 |
| :--- | :--- | :--- | :--- | :--- |
| 轨道一 | TOC 驱动 | 检测到目录页 | ✅ 140 条 TOC 条目 | ❌ 未触发（无 TOC） |
| 轨道二 | 模式匹配 | 始终启用 | ✅ 348 个锚点 | ✅ 17 个锚点 |
| 轨道三 | LLM 滑动窗口 | 大文档 + 间隙 | ❌ 未触发 | ❌ 未触发（无间隙） |

**亮点**:

1. **TOC 检测精准**: 正确识别了 Cambridge 的 page 5-7 为目录页，过滤了版权页（page 2）的误报。
2. **模式匹配覆盖全面**: 支持 Chapter/Unit/Section/Lesson/Exercise/Topic 等多种模式，且在 TOC 页面上自动排除。
3. **锚点融合逻辑合理**: TOC 锚点与 Pattern 锚点的去重和合并策略正确，"Chapter N" + "N Title" 的相邻重复被成功消除。
4. **完整的 debug 产物链**: `v2_toc_detection.json` → `v2_toc_entries.json` → `v2_toc_anchors.json` → `v2_pattern_anchors.json` → `v2_merged_anchors.json` → `chapter_flat_map.json`，完全可追溯。

**发现的问题**:

#### 问题 ②-1: TOC 条目中 "9Sequences,surds and sets" 缺少空格

**PRD 章节**: §5.3（章节标题质量）

**根因分析**: 这是 MinerU 的 OCR 解析问题，原始 Block 文本（Block 140）就是 `"9Sequences,surds and sets 253"`，缺少 "9" 和 "S" 之间的空格。V2 的 `extractTOCEntries` 函数忠实地提取了这个文本，没有进行空格修复。

**上游对齐检查**: 上游 `OpenDCAI/DataFlow` 的 `refine_title` 函数有一个 `re.sub(r'(\d)([A-Z])', r'\1 \2', title)` 的修复逻辑，专门处理这种"数字紧跟大写字母"的 OCR 错误。本项目的 `refineTitle`（extraction.ts）虽然也有类似逻辑，但它只在 `cleanChapterTitles` 中被调用，不在 V2 的 TOC 提取阶段。

**修复建议**: 在 `extractTOCEntries` 或 `mergeAnchors` 中添加一个简单的文本修复步骤：

```typescript
function fixOCRSpacing(text: string): string {
  // 数字紧跟大写字母时插入空格（如 "9Sequences" → "9 Sequences"）
  return text.replace(/(\d)([A-Z])/g, '$1 $2');
}
```

**优先级**: P2（不影响功能，仅影响标题美观度）

---

#### 问题 ②-2: LLM 轨道（轨道三）在两轮测试中均未被触发

**PRD 章节**: §5.3（章节预处理的完整性）

**根因分析**: LLM 轨道的触发条件是"存在显著间隙（>=5 页未被任何高置信度锚点覆盖）"。在 Cambridge 测试中，TOC + Pattern 双轨道已经覆盖了几乎所有页面，不存在间隙。在 Envision G8 测试中，17 个 Pattern 锚点覆盖了 76/78 页，仅有 4 个页面未覆盖（page 33, 59, 60, 61），不满足 >=5 页的阈值。

**影响评估**: 当前两个测试用例恰好不需要 LLM 轨道。但对于**没有目录页、且章节标题不符合任何正则模式**的文档（如中文教材使用"第一章"而非"Chapter 1"），LLM 轨道将是唯一的发现手段。**该轨道的实际效果尚未验证。**

**建议**: 在后续测试中，选择一个中文教材作为测试用例，专门验证 LLM 轨道的效果。

**优先级**: P1（功能已实现但未验证）

---

#### 问题 ②-3: Envision G8 缺少 Topic 级别（L1）锚点

**PRD 章节**: §5.3（章节层级完整性）

**根因分析**: Envision G8 是一个单元节选（仅包含 Topic 1），MinerU 解析结果中不存在 "Topic 1" 的文本 Block。Pattern 轨道只能检测到 "Lesson 1-X" 级别的锚点（L2），无法推断出更高层级的 Topic 结构。

**影响评估**: 所有 17 个 flat_map 条目都是 L2 且 `parent_id = null`，导致 `findChapterForBlock` 返回的路径只有一级（如 "Lesson 1-1"），没有 " > " 分隔符。这直接导致了下游 ChapterMerge 的融合失败（详见算子 ⑥ 的分析）。

**修复建议**: 当所有锚点都是同一 level 且无父节点时，考虑自动推断一个虚拟的 L1 根节点（如 "Topic 1"），使路径格式统一。但这需要谨慎设计，避免在多 Topic 文档中产生错误的推断。

**优先级**: P2（边缘场景，仅影响单元节选类文档）

---

### [算子 ③ ChapterValidation] 已对齐 ✅

**PRD 要求** (§5.4): 验证章节候选的 JSON 格式、ID 合法性和逻辑合理性，失败时输出 `null`。

**实现状态**: V2 架构通过完全不同的方式实现了 ChapterValidation 的目标。V2 不再依赖 LLM 输出 JSON 再做验证，而是通过纯代码的 TOC 检测和 Pattern 匹配来生成章节候选，从源头上消除了 JSON 格式错误和 ID 空间错误的可能性。

V1 中的 `validateChapterEntries` 函数仍然保留在 `chapterPreprocess.ts` 中，但在 V2 流水线中不再被调用。V2 的验证逻辑内嵌在各个轨道中：
- TOC 轨道：通过 `extractTOCEntries` 的噪声过滤和 `matchTOCToBody` 的正文匹配来验证
- Pattern 轨道：通过 `isNoisyTitle` 过滤和 `confidence` 评分来验证

**结论**: V2 通过架构设计消除了 V1 中 ChapterValidation 需要解决的问题。这是一个比"事后验证"更优的方案。

---

### [算子 ④ QuestionExtract] 未变更，保持对齐 ✅

**PRD 要求** (§5.5): 分块 + 并发 LLM 抽取题目，输出 XML（含 Block ID 引用）。

**实现状态**: `extraction.ts` 中的题目抽取逻辑未在本分支中变更。两轮测试的题目数量（Cambridge: 3,517; Envision: 373）与之前的测试结果一致，说明题目抽取阶段稳定。

**结论**: 无变更，保持对齐。

---

### [算子 ⑤ Parser] 未变更，保持对齐 ✅

**PRD 要求** (§5.6): 双模式解析 XML，ID 回填还原文本，生成 `ExtractedQuestion[]`。

**实现状态**: `parser.ts` 未变更。

**结论**: 无变更，保持对齐。

---

### [算子 ⑥ ChapterMerge] 部分对齐 ⚠️（存在 P0 级问题）

**PRD 要求** (§5.7): "v2.0 将其修订为 ChapterMerge（融合），即同时保留两个来源的章节信息，并根据可靠性进行融合决策。"

**当前实现**: `extraction.ts` 中的 ChapterMerge 逻辑为：

```typescript
if (llmIsValid && preIsValid) {
  q.chapter_title = (llmTitle as string).length >= (preTitle as string).length
    ? (llmTitle as string) : (preTitle as string);
}
```

**发现的问题**:

#### 问题 ⑥-1 (P0): "选更长"策略在单级目录树场景下导致噪声标题胜出

**PRD 要求**: §5.7 明确要求"根据可靠性进行融合决策"，而非"选更长"。

**根因分析**:

1. Envision G8 的 V2 flat_map 只有 L2 条目（17 个 Lesson），无 L1 父节点。
2. `findChapterForBlock` 返回的路径只有一级（如 `"Lesson 1-1"`，10 字符），不包含 `" > "` 分隔符。
3. LLM 在题目抽取阶段输出的 `chapter_title` 为 `"Practice & Problem Solving"`（28 字符）。
4. ChapterMerge 的 `isTitleValid` 函数使用 `title_validation.json` 配置，其 `noisePatterns` 只包含中文噪声词（"选择题"、"填空题"等），不包含英文噪声词。
5. 因此 `"Practice & Problem Solving"` 通过了 `isTitleValid` 检查。
6. "选更长"策略选择了 28 > 10，噪声标题胜出。

**偏差影响**: Envision G8 中 **47.5%（177/373）** 的题目携带噪声标题，包括：
- "Practice & Problem Solving"（107 道）
- "Focus on math practices"（17 道）
- "Estimate Very Large Quantities"（16 道）
- 其他噪声标题（37 道）

**修复建议**: ChapterMerge 的融合策略需要根本性改进。建议采用**"预处理优先"策略**：

```typescript
// 修复方案：当预处理标题存在且有效时，始终优先使用
if (preIsValid) {
  q.chapter_title = preTitle as string;
} else if (llmIsValid) {
  q.chapter_title = llmTitle as string;
} else {
  q.chapter_title = '';
}
```

**理由**: V2 的预处理标题来自纯代码的 TOC/Pattern 检测，其可靠性远高于 LLM 在题目抽取阶段"顺带"输出的章节标题。PRD §5.7 的"根据可靠性进行融合决策"应该体现为**信任预处理结果**。

**替代方案**: 如果不想完全放弃 LLM 标题，可以在 `title_validation.json` 中添加英文噪声模式，或者复用 V2 的 `isNoisyTitle` 函数来过滤 LLM 标题。

**优先级**: **P0**（直接导致 47.5% 的题目章节标题错误）

---

#### 问题 ⑥-2 (P1): `isTitleValid` 和 `isNoisyTitle` 使用不同的过滤规则

**PRD 要求**: §3 原则五（不靠硬编码，追求可泛化）。

**根因分析**: 系统中存在两套独立的标题质量过滤逻辑：

| 函数 | 所在模块 | 过滤范围 | 配置方式 |
| :--- | :--- | :--- | :--- |
| `isNoisyTitle` | `chapterPreprocessV2.ts` | 中英文噪声 | 硬编码正则 |
| `isTitleValid` | `extraction.ts` | 仅中文噪声 | `title_validation.json` |
| `DEFAULT_TITLE_FILTERS` | `strategies.ts` | 仅中文噪声 | 策略链 |

三套规则互不引用，且覆盖范围不一致。`isNoisyTitle` 能过滤 "Practice & Problem Solving"，但 `isTitleValid` 不能。

**修复建议**: 统一为一套可配置的标题质量过滤策略。建议以 `strategies.ts` 的 `StrategyChain` 为基础，将 `isNoisyTitle` 的规则迁移进来，然后在 `isTitleValid` 和 V2 中统一调用。

**优先级**: P1（技术债务，影响可维护性）

---

### [算子 ⑦ PostProcess & Export] 部分对齐 ⚠️

**PRD 要求** (§5.8): 基于 `questionIds` 去重、排序、导出 JSON + Markdown。

**实现状态**: 去重逻辑基于 `questionIds`（Block ID 序列），符合 PRD 要求。导出格式包含 JSON 和 Markdown，符合要求。

**发现的问题**:

#### 问题 ⑦-1 (P2): Cambridge 测试中 219 道题目仅匹配到 L1 章节

**根因分析**: 这 219 道题目的 Block 位置落在 L1 章节范围内，但不在任何 L2 或 L3 子章节范围内。这说明 V2 的目录树在某些区域存在"层级间隙"——L1 覆盖了，但 L2/L3 没有覆盖。这些题目的章节标题为 LLM 输出的单级标题（如 "2 Making sense of algebra"），而非预处理的路径格式标题。

**影响评估**: 219/3,517 = 6.2%，影响有限。这些题目仍然有章节归属，只是精度较低（Chapter 级别而非 Section 级别）。

**优先级**: P2

---

## 三、新增模块评审

### `strategies.ts` (138 行)

**评审结论**: 代码质量优秀，设计清晰，可扩展性强。`StrategyChain` 的泛型实现是通用的，`DEFAULT_TITLE_FILTERS` 和 `DEFAULT_ANSWER_DETECTION` 的实现与测试用例完全匹配。

**问题**: 该模块当前**未被任何核心模块引用**。它只被 `strategies.test.ts` 测试。这是一个"孤岛"模块，需要在后续集成到 `chapterPreprocessV2.ts` 和 `extraction.ts` 中。

**建议**: 在下一个迭代中，将 `isNoisyTitle`（V2）和 `isTitleValid`（extraction.ts）统一迁移到 `strategies.ts` 的策略链框架中。

---

### `testChapterV2.ts` (离线测试脚本)

**评审结论**: 该脚本是一个有价值的离线验证工具，可以在不启动完整流水线的情况下测试 V2 的 TOC 检测和 Pattern 匹配效果。建议保留并完善为正式的集成测试。

---

## 四、V1 遗留 Bug

### V1 Bug: `validateChapterEntries` 失败时不写入空 `chapter_flat_map.json`

**根因**: V1 的 `preprocessChapters` 函数在 `validateChapterEntries` 返回 `{ ok: false }` 时，直接 `return { flatMap: [], ... }`，但此时 `chapter_flat_map.json` 尚未被写入。如果磁盘上存在旧版本的文件，它会残留。

**V2 状态**: V2 不受此 bug 影响，因为 V2 总是在函数末尾写入 `chapter_flat_map.json`（即使为空数组）。

**建议**: 在 V1 的 `preprocessChapters` 中，在 `return` 之前添加一行写入空数组的逻辑。虽然 V2 已替代 V1，但 V1 代码仍然存在于代码库中，且 `taskProcessor.ts` 仍然 import 了 V1 的类型定义。

**优先级**: P2

---

## 五、PRD 对齐度评估表

| 算子 | 名称 | 实现状态 | 关键发现 |
| :--- | :--- | :--- | :--- |
| ① | **BlockFlattener** | ✅ 已对齐 | 无变更，稳定工作 |
| ② | **ChapterPreprocess** | ✅ **已对齐（V2）** | 三轨混合架构表现出色，Cambridge 覆盖率 98.9% |
| ③ | **ChapterValidation** | ✅ **已对齐（V2）** | V2 通过架构设计消除了 V1 的验证问题 |
| ④ | **QuestionExtract** | ✅ 已对齐 | 无变更，稳定工作 |
| ⑤ | **Parser** | ✅ 已对齐 | 无变更，稳定工作 |
| ⑥ | **ChapterMerge** | ❌ **偏离 (P0)** | "选更长"策略导致 47.5% 噪声标题；过滤规则不统一 |
| ⑦ | **PostProcess & Export** | ⚠️ **部分对齐** | 6.2% 题目仅匹配到 L1 级别 |

---

## 六、KPI 达成情况

| KPI | 目标值 | Cambridge 实际 | Envision 实际 | 达标 |
| :--- | :--- | :--- | :--- | :--- |
| 章节覆盖率 | > 99% | **98.9%** | **95.1%** | ⚠️ 接近 |
| 章节准确率 | > 95% | **~93.8%** (路径格式) | **~40.2%** (正确 Lesson) | ❌ Envision 不达标 |
| LLM 输出有效率 | > 98% | N/A (V2 不依赖 LLM) | N/A | ✅ 架构性解决 |
| 人工干预率 | < 1% | ~0% | ~47.5% (需人工修正噪声标题) | ❌ Envision 不达标 |

**说明**: Cambridge 的章节准确率以"路径格式标题占比"（93.8%）为近似指标。Envision 的章节准确率以"正确 Lesson 标题占比"（40.2%）为近似指标，因为 47.5% 的题目携带噪声标题，12.3% 的题目携带其他非标准标题。

---

## 七、修复优先级总结

| 优先级 | 编号 | 问题 | 修复建议 | 预期收益 |
| :--- | :--- | :--- | :--- | :--- |
| **P0** | ⑥-1 | ChapterMerge "选更长"策略导致噪声标题胜出 | 改为"预处理优先"策略 | Envision 准确率从 40.2% 提升至 ~95% |
| **P1** | ⑥-2 | 三套标题过滤规则不统一 | 统一到 `strategies.ts` 策略链 | 消除技术债务，提升可维护性 |
| **P1** | ②-2 | LLM 轨道未被验证 | 增加中文教材测试用例 | 确认 LLM 轨道的实际效果 |
| **P2** | ②-1 | "9Sequences" OCR 空格缺失 | 添加 `fixOCRSpacing` | 标题美观度提升 |
| **P2** | ②-3 | 单元节选文档缺少 L1 根节点 | 自动推断虚拟根节点 | 边缘场景覆盖 |
| **P2** | ⑦-1 | 6.2% 题目仅匹配到 L1 | 优化目录树的 L2/L3 覆盖 | 章节精度提升 |
| **P2** | V1 Bug | validation 失败不写入空文件 | 添加写入逻辑 | 消除残留文件风险 |

---

## 八、合并建议

**建议合并到主干，但需先修复 P0 问题。**

P0 问题（⑥-1）的修复非常简单（约 5 行代码变更），可以在合并前快速完成。修复后，Envision G8 的章节准确率预计从 40.2% 提升至 ~95%，两个测试用例的 KPI 将全部达标或接近达标。

**合并前必须完成**:
1. 修复 ChapterMerge 的融合策略（P0，~5 行代码）
2. 重新运行两轮测试，确认修复效果

**合并后可以后续完成**:
1. 统一标题过滤规则（P1）
2. 增加中文教材测试用例（P1）
3. 其他 P2 级优化

---

## 九、总体评价

V2 架构是一次成功的重构，它从根本上解决了 V1 中"依赖 LLM 输出 JSON 来识别章节结构"的脆弱性问题。通过"代码优先、LLM 兜底"的设计哲学，V2 在有目录页的场景下实现了接近完美的章节覆盖率，且完全不依赖 LLM，大幅提升了系统的鲁棒性和处理速度。

当前的主要瓶颈已从"章节预处理"转移到了"章节融合"（ChapterMerge）。V2 产出了高质量的目录树，但下游的融合策略未能充分利用这个优势。修复 P0 问题后，整个流水线的章节准确性将达到一个新的水平。

**PRD 原则对齐度**:

| 原则 | 对齐度 | 说明 |
| :--- | :--- | :--- |
| 原则一：准确性高于一切 | ⚠️ | V2 本身准确，但 ChapterMerge 的"选更长"策略违反了此原则 |
| 原则二：过程必须可观测 | ✅ | V2 的 debug 产物链完整，每个轨道的输出都可追溯 |
| 原则三：坚持 ID-Only | ✅ | V2 基于 Block ID 构建目录树，符合 ID-Only 原则 |
| 原则四：拥抱失败，优雅降级 | ✅ | TOC 失败回退 Pattern，Pattern 失败回退 LLM |
| 原则五：不靠硬编码，追求可泛化 | ⚠️ | `isNoisyTitle` 使用硬编码正则，`strategies.ts` 尚未集成 |
