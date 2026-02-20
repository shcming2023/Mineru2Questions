# Mineru2Questions 项目回归评审报告 (v1.8)

**日期**: 2026-02-10
**评审人**: Manus AI
**评审对象**: Commit `a207cbe`

---

## 1. 核心结论

**评审失败。最新提交 (`a207cbe`) 未包含任何代码层面的修复。**

分析显示，本次提交仅对测试任务目录进行了重命名和清理，**所有核心代码文件（`extraction.ts`, `parser.ts` 等）与上一版本完全相同**。因此，v1.7 报告中指出的 **P0 级“去重过度”缺陷依然存在**，导致测试产出与上次完全一致，仍为 **509** 题，相比原始产出丢失了 **40%** 的数据。

**必须强调，在应用 v1.7 报告中建议的代码修复之前，任何新的测试都无法解决此问题。**

| 问题 ID (v1.7) | 描述 | 状态 | 备注 |
| :--- | :--- | :--- | :--- |
| **P0: QTY-2** | **去重过度** | ❌ **未修复** | **核心缺陷，阻塞项。** `deduplicateQuestions` 函数未修改。 |
| **BUG-1** | `extractedCount` 未更新 | ❌ **未修复** | 数据库文件 (`sqlite.db`) 仍被 `.gitignore` 排除。 |
| **QTY-1** | 章节标题清洗不彻底 | ❌ **未修复** | 依赖于 P0 缺陷的解决。 |

---

## 2. 数据分析回顾

对当前测试任务 (`202602100704`) 的数据分析结果与 v1.7 完全一致，再次确认了问题的严重性：

- **LLM 原始产出**: 843 道题目
- **最终产出**: 509 道题目
- **总丢失率**: **39.6%** (334 题)

**丢失路径分析:**

1.  **去重阶段**: 由于错误的去重键 `(chapter_title, label)`，导致 **~206** 道不同页面的有效题目被错误地当作重复项去除。
2.  **质量过滤/解析阶段**: 剩余的 **~128** 道题目因各种原因（如空题目、过短、或解析错误）被过滤。

**章节标题质量问题依然显著**：

- **20.2%** 的题目（103 题）被错误地归类到 `“疑难分析”`、`“本章复习题”` 等噪声标题下，这是导致去重过度的直接原因。

---

## 3. 修复方案重申

为解决此 P0 级缺陷，必须实施 v1.7 报告中提出的短期修复方案。

**首要行动：修改 `deduplicateQuestions` 函数。**

请将去重键从二元组 `(chapter_title, label)` 改为三元组 `(chapter_title, label, page_idx)`。这能立即阻止不同页面上的同名题号被错误删除。

```typescript
// 路径: server/extraction.ts

function deduplicateQuestions(questions: ExtractedQuestion[]): ExtractedQuestion[] {
  const seen = new Set<string>();
  const unique: ExtractedQuestion[] = [];
  
  for (const q of questions) {
    // 紧急修复：必须加入 page_idx 来区分不同页面上的同名题号
    const key = `${q.chapter_title?.trim()}_${q.label?.trim()}_${q.page_idx}`;

    if (!seen.has(key)) {
      seen.add(key);
      unique.push(q);
    }
  }
  
  return unique;
}
```

---

## 4. 后续步骤

1.  **实施代码修复**: **请务必将上述代码修改应用到 `server/extraction.ts` 文件中。**
2.  **重新运行测试**: 在代码修复后，重新运行一次完整的提取任务。
3.  **提交评审**: 将包含**已修复代码**和**新测试产出**的 commit 推送至远程仓库，然后再次发起评审。

在确认“去重过度”问题得到解决后，我们将继续跟进 `extractedCount` 更新、章节标题长期优化等其他质量问题。
