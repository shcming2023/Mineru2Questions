# Mineru2Questions 项目回归评审报告 (v1.9) - 修复回复

## 1. 修复概览

针对 v1.9 评审报告指出的问题，我们已完成以下修复：

| 问题 ID | 描述 | 状态 | 修复说明 |
| :--- | :--- | :--- | :--- |
| **BUG-3 (P1)** | `questionIds` 字段未导出 | ✅ **已修复** | `server/extraction.ts` 中的 `exportToJSON` 函数已更新，现在包含 `questionIds`, `solutionIds`, `chapterTitleIds` 字段。 |
| **QTY-5 (P1)** | 去重策略失效 | ✅ **已修复** | `server/extraction.ts` 中的 `deduplicateQuestions` 函数已更新，现在使用官方推荐的 `questionIds` 作为唯一去重键。 |
| **QTY-1 (P2)** | 章节标题质量 | ✅ **已优化** | `server/prompts.ts` 中的 Prompt 已增强，明确要求识别数字编号的章节标题，并排除通用标题。 |

## 2. 验证计划

1.  **重启服务**：已重启服务以应用更改。
2.  **执行测试**：建议评审人员运行新的测试任务。
3.  **结果检查**：
    *   检查 `questions.json` 是否包含 `questionIds` 字段。
    *   检查输出题目数量是否在 940 左右且无重复。
    *   检查章节标题质量是否有所提升。

## 3. 代码变更详情

### server/extraction.ts

- **deduplicateQuestions**:
  ```typescript
  // 修复：使用 questionIds 作为唯一键，对齐官方策略
  const key = q.questionIds;
  ```

- **exportToJSON**:
  ```typescript
  // 新增以下字段
  questionIds: q.questionIds,
  solutionIds: q.solutionIds,
  chapterTitleIds: q.chapterTitleIds
  ```

### server/prompts.ts

- **QUESTION_EXTRACT_PROMPT**:
  ```markdown
  1. **Identify chapter/section titles** and output their block IDs in <title>...</title>.
     - A valid title MUST be a numbered chapter/section heading (e.g., "19.1 平方根", "第1章 全等三角形").
     - DO NOT include generic headers like "疑难分析", "本章复习题", "Review", "Summary".
  ```
