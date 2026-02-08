# Mineru2Questions 优化建议与代码示例

本文档提供可直接用于修复 `Mineru2Questions` 项目当前问题的代码级建议。所有建议都严格对齐 OpenDCAI/DataFlow 官方流水线实践。

## P0: 立即修复 (对齐官方核心逻辑)

### 1. 修订 `mergeQAPairs` 函数 (核心)

**问题**: 当前的 `mergeQAPairs` 函数使用复杂的、不可靠的 `questionChapterId` 机制来区分章节, 导致不同章节的相同题号被错误覆盖。

**解决方案**: 彻底移除 `questionChapterId` 逻辑, 严格对齐 DataFlow 官方的 `merge_qa_pair` 方法, 使用更简洁、更鲁棒的 `normalizedChapter:labelKey` 作为去重键。

**建议的 `mergeQAPairs` 函数实现**: 

```typescript
/**
 * 合并问题和答案列表 (修订版)
 * 严格对齐 DataFlow 的 merge_qa_pair 实现
 *
 * 关键变更:
 * 1. 彻底移除 questionChapterId, currentQuestionChapter, lastQuestionLabel 机制。
 * 2. 使用 Map<string, ExtractedQAPair> 来聚合数据, 键为 `${normalizedChapter}:${labelKey}`。
 * 3. 优先处理和存储所有 questions, 然后遍历 answers 进行合并或补充。
 * 4. 对于 interleaved (穿插) 的题目 (自身已包含 question 和 answer/solution), 直接输出。
 */
export function mergeQAPairs(
  questions: ExtractedQAPair[],
  answers: ExtractedQAPair[],
  strictTitleMatch: boolean = false
): MergedQAPair[] {
  const finalMerged: MergedQAPair[] = [];
  const qaMap = new Map<string, ExtractedQAPair>();

  // --- 步骤 1: 遍历所有 questions, 填充 qaMap ---
  for (const q of questions) {
    const labelNum = normalizeLabel(q.label);
    if (labelNum === null) continue; // 跳过无法解析题号的条目

    // 如果题目本身是完整的 (interleaved 模式), 直接加入最终结果
    if (q.question && (q.answer || q.solution)) {
      finalMerged.push({
        label: labelNum,
        question_chapter_title: normalizeTitle(q.chapter_title, strictTitleMatch),
        answer_chapter_title: normalizeTitle(q.chapter_title, strictTitleMatch),
        question: q.question,
        answer: q.answer,
        solution: q.solution,
        images: q.images || [],
      });
      continue; // 处理下一题
    }

    // 对于只有 question 的条目, 存入 qaMap 等待 answer
    const normalizedChapter = normalizeTitle(q.chapter_title, strictTitleMatch);
    const labelKey = getLabelKey(q.label);
    const key = `${normalizedChapter}:${labelKey}`;

    // 如果 Map 中尚不存在该题, 或新题目更完整, 则存入
    if (!qaMap.has(key) || (q.question.length > (qaMap.get(key)?.question.length || 0))) {
        qaMap.set(key, q);
    }
  }

  // --- 步骤 2: 遍历所有 answers, 与 qaMap 中的 questions 合并 ---
  for (const a of answers) {
    const labelNum = normalizeLabel(a.label);
    if (labelNum === null) continue;

    const normalizedChapter = normalizeTitle(a.chapter_title, strictTitleMatch);
    const labelKey = getLabelKey(a.label);
    const key = `${normalizedChapter}:${labelKey}`;

    // 如果在 qaMap 中找到了对应的 question
    if (qaMap.has(key)) {
      const q = qaMap.get(key)!;

      // 只有当 answer/solution 有效时才进行合并
      if (a.answer || a.solution) {
        finalMerged.push({
          label: labelNum,
          question_chapter_title: normalizeTitle(q.chapter_title, strictTitleMatch),
          answer_chapter_title: normalizedChapter,
          question: q.question,
          answer: a.answer,
          solution: a.solution,
          images: Array.from(new Set([...(q.images || []), ...(a.images || [])])),
        });
        // 合并后从 map 中移除, 防止重复处理
        qaMap.delete(key);
      }
    } else {
        // 如果 answer 自身是完整的 (例如答案册中也包含了题目), 直接加入
        if (a.question && (a.answer || a.solution)) {
            finalMerged.push({
                label: labelNum,
                question_chapter_title: normalizedChapter,
                answer_chapter_title: normalizedChapter,
                question: a.question,
                answer: a.answer,
                solution: a.solution,
                images: a.images || [],
            });
        }
    }
  }

  // --- 步骤 3: 处理 qaMap 中剩余的、没有匹配到答案的 questions ---
  // (根据业务需求决定是否要将这些只有问题没有答案的题目输出)
  // for (const q of qaMap.values()) {
  //   finalMerged.push({
  //     label: normalizeLabel(q.label)!,
  //     question_chapter_title: normalizeTitle(q.chapter_title, strictTitleMatch),
  //     answer_chapter_title: "", // No answer found
  //     question: q.question,
  //     answer: "",
  //     solution: "",
  //     images: q.images || [],
  //   });
  // }

  // 按章节和题号排序
  finalMerged.sort((a, b) => {
    const chapterCompare = a.question_chapter_title.localeCompare(b.question_chapter_title, undefined, { numeric: true });
    if (chapterCompare !== 0) return chapterCompare;
    return a.label - b.label;
  });

  return finalMerged;
}
```

### 2. 修订 `QA_EXTRACT_PROMPT` 提示词

**问题**: 强制转换圆圈数字的指令 `For circled numbers: use "1" for ①...` 导致 `例①` 被错误地提取为 `label: 1`。

**解决方案**: 恢复使用 DataFlow 官方更通用的 `Preserve each problem’s original label/number` 指令, 将具体的格式规范化工作留给后处理函数, 这样更可靠。

**建议的 `QA_EXTRACT_PROMPT` 修改**: 

在 `server/extraction.ts` 文件中, 找到 `QA_EXTRACT_PROMPT` 常量。

**替换**: 
```typescript
// ...
### CRITICAL: Question Numbering Recognition
- Circled numbers ①②③④⑤⑥⑦⑧⑨⑩ are INDEPENDENT questions, NOT sub-questions. Each ① or ② starts a NEW <qa_pair>.
// ...
### About Questions and Answers/Solutions:
- Preserve each problem's original label/number (e.g., "①", "②", "例1", "1", "11"). Do not include periods after numbers.
- For circled numbers: use "1" for ①, "2" for ②, "3" for ③, etc.
- Use Arabic numerals only. Convert "例一" to "例1", "IV" to "4".
// ...
```

**修改为**: 
```typescript
// ...
### CRITICAL: Question Numbering Recognition
- Circled numbers ①②③④⑤⑥⑦⑧⑨⑩ are INDEPENDENT questions, NOT sub-questions. Each ① or ② starts a NEW <qa_pair>.
// ...
### About Questions and Answers/Solutions:
- **Preserve each problem’s original label/number**, such as "例1", "Example 3", "习题1", "11", "①".
- Use Arabic numerals for numbered lists, but preserve original prefixes. For example, if the label is "例一", convert it to "例1". If the label is "IV", convert it to "4".
// ...
```

## P1: 重要优化 (提升鲁棒性)

### 1. 增加 `label` 后处理逻辑

**问题**: 完全依赖 LLM 正确输出 `label` 格式不够稳定。

**解决方案**: 在 `parseLLMOutput` 函数中, 对 LLM 提取出的 `label` 字符串进行一次强制的、确定性的规范化处理。

**建议的 `getLabelKey` 和 `normalizeLabel` 函数 (或在 `parseLLMOutput` 中直接处理)**:

```typescript
/**
 * 规范化题号 - 用于排序和去重 (修订版)
 * 提取数字部分, 同时保留 "例" 等重要前缀
 */
export function getLabelKey(label: string): string {
  let normalized = label.trim();
  // 将全角括号转为半角
  normalized = normalized.replace(/（/g, '(').replace(/）/g, ')');
  // 转换圆圈数字
  normalized = normalized.replace(/①/g, '1').replace(/②/g, '2').replace(/③/g, '3').replace(/④/g, '4').replace(/⑤/g, '5').replace(/⑥/g, '6').replace(/⑦/g, '7').replace(/⑧/g, '8').replace(/⑨/g, '9').replace(/⑩/g, '10');
  // 保留 "例" 并提取数字, 例如 "例1" -> "例1"
  const match = normalized.match(/(例|填空|选择|解答|变式|练习|习题|随堂练习)?\s*(\d+)/);
  if (match) {
    return (match[1] || '') + match[2];
  }
  // 如果没有匹配到, 返回原始清理后的 label
  return normalized.replace(/\s/g, '');
}

export function normalizeLabel(label: string): number | null {
  const key = getLabelKey(label);
  const match = key.match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}
```

将这个逻辑应用在 `parseLLMOutput` 和 `mergeQAPairs` 中, 可以确保即使 LLM 输出的 `label` 格式略有偏差, 系统也能正确地识别和匹配。
