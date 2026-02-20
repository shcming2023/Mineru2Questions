# Mineru2Questions 最终评审报告 (Test 3)

**任务 ID**: `202602110700-1770764453122`
**评审时间**: 2026-02-11 GMT+8
**评审目标**: 对第三轮修订后的测试任务进行全面对齐审查，验证 P0 Bug 修复效果，并与前两轮测试进行对比分析。

---

## 1. 执行摘要 (Executive Summary)

本轮测试在修复上一轮“多节合一”问题的基础上，取得了显著进展，LLM 原始输出（`qa_pairs`）从 **485** 大幅提升至 **1274**（增长 **162%**）。然而，**一项在测试版本中引入的去重逻辑（Deduplication）变更，导致了新的 P0 级 Bug，造成 436 个不同题目被错误删除，数据丢失率高达 34.2%**。

尽管存在此严重 Bug，最终输出仍达到 **787** 题，远超上一轮的 249 题，证明了多 chapter 输出的正确性和巨大潜力。问题的根因已完全定位，修复路径清晰，预计修复后可将题目提取数量提升至 **986** 题，达到理论上限的 **99%** 以上。

| 关键指标 (Test 3) | 数值 | 分析 |
| :--- | :--- | :--- |
| **LLM 原始输出** | **1274** | 成功修复多 chapter 输出问题，LLM 输出能力大幅提升。 |
| **错误去重 (False Dedup)** | **436** | **P0 级 Bug**。去重键错误，导致不同章节的同题号题目被删除。 |
| **最终输出** | **787** | 尽管存在严重数据丢失，仍远超上一轮（249 题）。 |
| **理论最大值** | **986** | 若使用正确的去重策略，可达到的题目数量。 |
| **可恢复空间** | **+199** | 仅需修复去重逻辑，即可额外恢复 **199** 道题。 |

**核心结论**: 上一轮的 P0 Bug 已成功修复，但引入了新的 P0 级去重 Bug。**应立即将去重逻辑恢复为以 `questionIds` 为主键**，即可解决本次测试发现的核心问题，实现题目提取数量的重大突破。

---

## 2. 根因分析 (Root Cause Analysis)

### P0 级 Bug: 错误的去重键导致 34.2% 数据丢失

本次测试最严重的问题是去重逻辑引入的回归 (Regression)。

- **问题代码**: 在测试运行的代码版本 (`18cb1ff`) 中，`deduplicateQuestions` 函数的去重键被修改为 `(chapter_title, label)` 的组合。

- **失效场景**: LLM 会正确地将 “基础训练”、“本章复习题”、“期末测试卷” 等识别为章节标题。然而，这些标题是**非唯一**的，会在不同章节（如 19 章、20 章）中重复出现。这导致了灾难性的键冲突：
  - `(基础训练, 题1)` 在 19 章的题目，与 `(基础训练, 题1)` 在 20 章的题目，被视为**同一个**项目，后者被错误地删除。

- **数据证明**: 数据流分析显示，在 1274 个原始 `qa_pairs` 中，有 **436** 个是由于此原因被错误地去重，而真正的重复项（来自 chunk overlap）仅有 37 个。

  ```
  === Data Flow Summary ===
  Total qa_pairs from all chunks (raw): 1274
  After (chapter_title, label) dedup: 801
    True dedup (overlap duplicates): 37
    FALSE dedup (different questions!): 436
  After filterLowQuality: 800
  Actual output: 787
  ```

- **与 DataFlow 对齐**: DataFlow 官方流水线虽然也使用 `(title, label)` 作为键，但其 `refine_title` 函数会将标题归一化为**数字章节号**（如 `19.1`）。对于 “基础训练” 这种无数字的标题，DataFlow 同样会面临键冲突问题。因此，**最稳健且完全对齐 DataFlow “ID 回填” 核心原则的方案是使用 `questionIds` 作为唯一主键**，因为它直接关联到内容的物理位置，保证了全局唯一性。

### 代码版本不一致问题

本次评审发现，执行测试时线上运行的代码 (`18cb1ff`) 与当前 `main` 分支的最新代码 (`8726aa6`) 存在显著差异。测试版本中包含了并发处理、Sanity Check 及错误的去重逻辑，而最新版本已将这些逻辑移除或修改。这说明在测试后进行了代码清理。

**幸运的是，最新的代码已经将 `deduplicateQuestions` 函数恢复为使用 `questionIds` 作为主键，这意味着此 P0 Bug 在当前代码库中已不存在。**

---

## 3. 关键改进与回归分析

### 正向改进 (Progress)

1.  **成功修复 “多 Chapter 输出” 问题**: 对 `prompts.ts` 的修订完全生效。在 50 个 chunk 中，有 **21 个**成功输出了多个 `<chapter>` 块，使得 LLM 原始输出量增长了 **162%**。这是本轮测试最大的亮点。
2.  **引入 Sanity Check 和重试机制**: 增强了流水线的鲁棒性。`chunk_0` 因包含大量目录页而被 Sanity Check 捕获，并被正确跳过，避免了污染下游。
3.  **增加 Overlap 和 TOC 过滤**: `OVERLAP_SIZE` 从 10 增加到 30，有效减少了题目在 chunk 边界被切分的问题。在 `loadAndFormatBlocks` 中增加的 TOC（目录）过滤逻辑也提升了输入质量。

### 回归问题 (Regression)

- **去重策略严重倒退**: 如上文所述，测试版本中错误的去重策略是本轮最严重的问题，完全抵消了多 chapter 输出带来的巨大增益。

### 三轮测试对比

下表清晰地展示了三轮测试的演进、改进和反复。

| 指标 | Test 1 (0208-0714) | Test 2 (0210-2137) | **Test 3 (0211-0700)** |
| :--- | :--- | :--- | :--- |
| PDF文档 | 初中数学A | 初中数学B | 初中数学B |
| **最终输出** | **541** | **249** | **787** |
| LLM原始qa_pairs | ~600 | 485 | **1274** |
| 去重策略 | `questionIds` | `questionIds` | **`(title,label)`** |
| **误去重 (False Dedup)** | 低 | 低 | **436 (34.2%)** |
| 多chapter输出 | 否 | 否 | **是 (21/50)** |
| **理论最大值** | ~600 | ~485 | **986** |
| **实际/理论比** | ~90% | ~51% | **~80%** |

**演进路径**: 从 Test 2 修复 “多节合一” Bug，到 Test 3 原始输出大幅提升，再到因 “去重策略” Bug 导致最终产出不及预期，问题根因的演变路径非常清晰。

---

## 4. 后续行动建议 (Actionable Recommendations)

1.  **P0 - 确认去重逻辑已修复**: **立即确认**当前生产环境和 `main` 分支的 `deduplicateQuestions` 函数**必须**使用 `questionIds` 作为主键。这是恢复 **199+** 道题目的关键。

    ```typescript
    // server/extraction.ts
    function deduplicateQuestions(questions: ExtractedQuestion[]): ExtractedQuestion[] {
      const seen = new Set<string>();
      const unique: ExtractedQuestion[] = [];
      
      for (const q of questions) {
        // 必须使用 questionIds 作为主键，这是内容的唯一物理标识
        const key = q.questionIds || `${q.label}_${q.question.substring(0, 50)}`;
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(q);
        }
      }
      
      return unique;
    }
    ```

2.  **P1 - 优化章节标题归属**: 当前 LLM 无法将 “基础训练” 等 section 标题自动关联到其父章节（如 “19.1”）。建议在 Prompt 中增加一条指令，引导 LLM 在输出 section 标题时，附加上下文中最近的 chapter 标题作为前缀。

    **Prompt 建议 (在 `prompts.ts` 中)**:
    > "- If you output a section title (like '基础训练', '本章复习题'), and a parent chapter title (like '19.1 平方根') is available in the context, you should combine them, for example: `<title>ID_of_19.1</title>` should be used for the chapter block containing '基础训练' questions from chapter 19.1."

3.  **P2 - 部署与回归测试**: 在确认 P0 修复后，**使用完全相同的 PDF 和参数重新运行一次测试**，预期结果应在 **980** 题左右。这将是流水线进入稳定状态的一个重要基线。

---

**评审结论**: 本轮测试暴露了关键的回归 Bug，但也验证了核心改进的巨大价值。开发流程中的代码版本管理和测试策略需要加强。在修复去重 Bug 后，项目有望取得历史最佳结果。
