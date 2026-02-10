# Mineru2Questions 项目回归评审报告 (v1.9)

**评审结论：测试成功，P0 级“去重过度”缺陷已修复，核心产出恢复。**

本次修订 (`a19b277`) 成功解决了 v1.7 报告中指出的“去重过度”问题，使产出题目数从 **509** 题大幅回升至 **998** 题，恢复了系统的基本抽取能力。同时，v1.8 报告中指出的 `extractedCount` 不更新、图片路径、日志不全等缺陷也已全部修复。

在产出大幅提升的同时，本次评审也暴露了之前被掩盖的**数据质量问题**，主要包括**去重策略失效**和**章节标题质量不高**。这些是当前提升产出质量的主要瓶颈。

---

## 1. 缺陷修复验证

| ID | 类型 | 缺陷描述 | 状态 | 验证结果 |
| :--- | :--- | :--- | :--- | :--- |
| **P0** | `Bug` | **去重过度**：因去重键 `(title, label)` 不可靠，导致 40% 的题目被错误删除。 | ✅ **已修复** | 产出题目数从 509 恢复至 998，符合预期。 |
| **BUG-1** | `Bug` | **DB 字段未更新**：`extractedCount` 始终为 0。 | ✅ **已修复** | 数据库中任务 29 的 `extractedCount` 正确记录为 998。 |
| **SYS-1** | `System` | **图片路径不可移植**：使用绝对路径。 | ✅ **已修复** | `questions.md` 和 `questions.json` 中的图片路径已全部转换为相对路径。 |
| **QTY-1** | `Quality` | **章节标题质量**：LLM 提取的标题包含大量噪声。 | ⚠️ **部分修复** | `cleanChapterTitles` 函数已移除，但 LLM 输出的标题本身质量问题依然存在。 |
| **QTY-2** | `Quality` | **跨 chunk 重复**：`deduplicateQuestions` 逻辑无法处理重叠区的重复。 | ⚠️ **部分修复** | 去重键改为 `(title, label, page_idx)`，但因 `title` 不稳定，导致去重失效。 |

---

## 2. 最新测试产出分析 (任务 `202602100753`)

| 指标 | v1.9 (本次) | v1.7 (上次) | 变化 |
| :--- | :--- | :--- | :--- |
| **总题目数** | **998** | 509 | ▲ 96% |
| LLM 原始产出 | 998 | 843 | ▲ 18% |
| 去重/过滤丢失 | 0 (0%) | 334 (39.6%) | ✅ |
| **真正重复数** | **54** | ~20 | ⚠️ |
| 有效独立题目 | ~944 | ~489 | ▲ 93% |
| 答案覆盖率 | 9.3% | 10.2% | ▽ |
| 覆盖页面数 | 180 / 209 (86%) | 174 / 209 (83%) | ▲ |
| 噪声标题占比 | 32.6% | 34.2% | ▽ |
| 执行耗时 | 154 秒 | 146 秒 | - |

**核心发现**：
1.  **去重策略失效**：将去重键改为 `(title, label, page_idx)` 后，由于 LLM 对重叠区域的同一题目输出了不同的 `chapter_title`，导致去重逻辑完全失效，输出了 **54** 组真正的重复题目。
2.  **章节标题质量问题依然严峻**：仍有 **32.6%**（325 题）的题目被分配了错误的章节标题（如 “疑难分析”、“13. 解下列不等式或方程组：”），严重影响数据可用性。
3.  **页面覆盖率有待提升**：仍有 **14** 个包含实际题目的页面未被提取，原因可能是 LLM 在处理 chunk 边界时遗漏了这些页面的少量文本块。
4.  **`questionIds` 字段缺失**：`parser.ts` 正确解析了 LLM 输出的 ID 序列，但 `exportToJSON` 函数**并未将 `questionIds` 字段写入最终的 `questions.json`**。这是导致无法对齐官方去重策略的直接原因。

---

## 3. 新发现的缺陷与优化建议

### BUG-3 (P1, Bug): `questionIds` 字段未导出

-   **现象**: `questions.json` 中缺少 `questionIds`, `solutionIds`, `chapterTitleIds` 字段。
-   **根因**: `exportToJSON` 函数在映射对象时遗漏了这几个关键的 ID 序列字段。
-   **修复建议**: 在 `server/extraction.ts` 的 `exportToJSON` 函数中，补充这些字段的映射。

```typescript
// server/extraction.ts: exportToJSON
// ...
questions: questions.map(q => ({
  label: q.label,
  type: q.type,
  // ... (其他字段)
  page_idx: q.page_idx,
  has_answer: q.has_answer,

  // ==> 新增以下字段
  questionIds: q.questionIds,
  solutionIds: q.solutionIds,
  chapterTitleIds: q.chapterTitleIds
}))
// ...
```

### QTY-5 (P1, Quality): 去重策略失效

-   **现象**: 最终产出包含 54 组来自 chunk 重叠区的重复题目。
-   **根因**: 当前去重键 `(title, label, page_idx)` 不可靠。`title` 由 LLM 生成，不稳定。
-   **修复建议 (对齐官方)**: **在修复 BUG-3 后**，修改 `deduplicateQuestions` 函数，**使用 `questionIds` 作为唯一去重键**。这是最可靠、且与 DataFlow 官方一致的策略。

```typescript
// server/extraction.ts: deduplicateQuestions
function deduplicateQuestions(questions: ExtractedQuestion[]): ExtractedQuestion[] {
  const seen = new Set<string>();
  const unique: ExtractedQuestion[] = [];
  
  for (const q of questions) {
    // 修复：使用 questionIds 作为唯一键，对齐官方策略
    const key = q.questionIds;

    // 必须有 questionIds 才能参与去重
    if (key && key.trim().length > 0) {
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(q);
      }
    } else {
      // 对于没有 questionIds 的（理论上不应发生），直接放入
      unique.push(q);
    }
  }
  
  return unique;
}
```

### QTY-1 (P2, Quality): 章节标题质量

-   **现象**: 32.6% 的题目章节标题是噪声。
-   **根因**: LLM 未能准确识别并引用真正的章节标题 block ID。
-   **修复建议**: 
    1.  **优化 Prompt**: 在 `prompts.ts` 中，加强对 `MAIN_TITLE_ID` 的约束，明确指示它必须是“章节的数字编号和名称，如 ‘19.1 平方根’”，而不是普通文本块。
    2.  **后处理清洗**: 增加一个 `refineChapterTitle` 函数，在 ID 回填后，如果 `chapter_title` 不符合 `\d+\.\d+` 或 `第.章` 格式，则向上查找最近的一个符合该格式的标题作为回退。

### QTY-6 (P3, Quality): 页面覆盖率

-   **现象**: 14 个含题页面被遗漏。
-   **根因**: LLM 在处理 chunk 边界时，可能忽略了这些页面的少量文本块。
-   **修复建议**: 这是一个复杂的 LLM 行为问题，优先级较低。可以在后续版本中通过调整 `OVERLAP_SIZE` 或优化 prompt 中对跨页题目的处理引导来尝试解决。

---

## 4. 总结与后续步骤

项目已取得决定性进展，所有阻塞性 Bug 均已修复。当前的首要任务是**提升数据质量**。

**强烈建议您按以下顺序进行修复和下一次评审：**

1.  **立即修复 `BUG-3`**，确保 `questionIds` 被正确导出。
2.  **立即修复 `QTY-5`**，将去重逻辑对齐官方，使用 `questionIds` 作为键。
3.  （可选）尝试优化 Prompt 或增加后处理逻辑，改善 `QTY-1` 章节标题质量问题。

完成以上修复后，再次运行测试，我们期望看到一个**题目总数在 940 题左右、且没有重复题目**的干净产出。
