# Mineru2Questions 技术对齐审查报告

**发件人**: Manus AI 技术开发助手  
**收件人**: Mineru2Questions 开发团队  
**日期**: 2026年02月08日  
**主题**: 对齐 OpenDCAI/DataFlow 官方流水线的技术审查与优化建议

---

## 执行摘要

本报告对 `Mineru2Questions` 项目的后端 QA 抽取逻辑进行了全面的技术审查, 以 `OpenDCAI/DataFlow` [1] 官方仓库中的 `PDF_VQA_extract_optimized_pipeline` [2] 作为唯一事实标准 (Source of Truth)。审查基于项目的[最新测试输出](https://github.com/shcming2023/Mineru2Questions/tree/main/server/uploads/tasks/202602080714-1770506098605) [3], 采用逐个算子阶段对齐的方法, 识别出了导致当前抽取结果中题号重复、章节混淆、标签错误等问题的根本原因。

核心发现如下: `Mineru2Questions` 项目已成功搭建了基于 ID 的逻辑组装框架, 整体架构与官方流水线高度一致。然而, 在 **LLM 提示词 (Prompt) 设计** 和 **问答对合并 (QA Merging) 逻辑** 两个关键阶段存在显著偏差, 这是导致当前问题的直接原因。本报告提供了详细的根因分析、可落地的代码级修复建议, 以及长期改进方向, 旨在帮助项目快速对齐官方最佳实践, 提升抽取的完整性、稳定性和可维护性。

---

## 1. 背景与目标

`Mineru2Questions` 项目的核心任务是基于 MinerU 已有的解析结果 (`content_list.json` 与图片) 进行题目与问答对的抽取, 而不是重新执行 OCR 或替换 MinerU 的解析链路。项目必须坚持 "基于 ID 的逻辑组装方案": LLM 只能输出 ID / ID 区间 / ID 列表 / 结构化引用, 而不是自由改写的题干或答案文本; 最终文本必须来自 `content_list.json` 的 ID 回填。

本次审查的目标是确保 `Mineru2Questions` 的实现在不偏离官方流水线职责划分的前提下, 提升覆盖率、稳定性、可解释性, 并能兼容多种教育文本 (不同学科、不同排版、不同题型、不同来源)。

---

## 2. 核心问题诊断

通过对测试任务输出 `questions.json` (共225题, 覆盖章节 19.1, 20.1, 20.2, 21.1-21.5, 22.1-22.3) 的深度分析, 我们识别出以下三个核心问题:

### 问题 P1: 题号重复与章节混淆 (高优先级)

**现象**: 不同章节的题号被错误地合并或覆盖。例如, `label: 1` 在结果中出现了21次, `label: 2` 出现了23次, 但它们分属于不同章节 (如 19.1, 21.1, 22.1 等), 实际上并非重复题目。这表明系统未能正确区分不同章节的题目, 导致大量题目在合并阶段被丢弃。

**影响**: 严重降低了题目的覆盖率, 用户无法获得完整的题目集。

### 问题 P2: 题目标签提取不准确 (高优先级)

**现象**: 大量题目的 `label` 被错误地提取为 `1`, 尤其是对于使用 "例①" 格式的题目。例如:

```json
{
  "label": 1,
  "chapter_title": "19.1",
  "question": "例① 实数 $\\sqrt{16}$ 的算术平方根是",
  ...
}
```

在这个例子中, 原始题目标记为 "例①", 但最终的 `label` 只保留了数字 `1`, 丢失了重要的 "例" 前缀。这使得不同类型的题目 (如 "例1", "习题1", "填空1") 无法区分。

**影响**: 破坏了题目的语义完整性, 降低了系统的可用性。

### 问题 P3: 题目内容切分不完整 (中优先级)

**现象**: 部分题目 (Question) 与其解答 (Solution) 被拆分到不同的问答对中, 破坏了题目的完整性。这在题目与解答交错 (Interleaved) 的场景下尤为明显, 例如 "例① ...题干... 解: ...解答..." 这种结构可能被拆分为两个独立的 QA 对。

**影响**: 降低了抽取结果的质量, 用户需要手动重新关联题目和解答。

---

## 3. 按算子阶段逐段对齐分析

官方 `PDF_VQA_extract_optimized_pipeline` [2] 流水线定义了清晰的算子职责。我们将以此为框架, 对比 `Mineru2Questions` 的当前实现, 识别偏差并定位问题根源。

### 阶段一: 输入格式化与标准化 (Input Formatting)

**DataFlow 算子**: `MinerU2LLMInputOperator` [4]  
**Mineru2Questions 实现**: `convertContentList` 函数

此阶段负责将 MinerU 解析产物 `content_list.json` 转换为扁平化的、带有连续ID的、适合LLM处理的格式。审查发现, `Mineru2Questions` 在此阶段的实现与官方逻辑高度一致, 均正确处理了列表展开 (将 `type: 'list'` 的 `list_items` 展开为多个独立的 `type: 'text'` 块)、ID分配 (遍历过程中动态分配连续ID) 和无关字段移除 (移除 `bbox`, `page_idx` 等LLM无关字段)。

**结论**: 该阶段与官方实现基本对齐, **不是当前问题的原因**。

### 阶段二: 基于上下文的 LLM 抽取 (LLM Extraction)

**DataFlow 算子**: `ChunkedPromptedGenerator` + `QAExtractPrompt` [5]  
**Mineru2Questions 实现**: `extractQAPairsWithLLM` + `QA_EXTRACT_PROMPT`

此阶段将格式化后的内容块和精心设计的提示词 (Prompt) 发送给 LLM, 要求 LLM 仅输出包含内容块 ID 的结构化 XML。这是问题的**核心所在**。`Mineru2Questions` 的提示词与官方版本存在关键偏差, 直接导致了 **P2 (题目标签提取不准确)** 的问题。

| 对比项 | DataFlow `QAExtractPrompt` | Mineru2Questions `QA_EXTRACT_PROMPT` | 结论 |
| :--- | :--- | :--- | :--- |
| **Label提取** | `Preserve each problem's original label/number` (保留原始标签) | `For circled numbers: use "1" for ①, "2" for ②` (强制转换) | ❌ **严重偏差** |
| **Label规范化** | `Use Arabic numerals only. For example, if the label is "例一", convert it to "例1"` | `Use Arabic numerals only. Convert "例一" to "例1"` | ✅ **对齐** |
| **ID连续性** | 隐式要求 | `CRITICAL: Consecutive ID Handling` (显式强调) | ⬆️ **优化增强** |

**根因分析 (P2)**: `Mineru2Questions` 的提示词中存在一条指令: `For circled numbers: use "1" for ①, "2" for ②`。这条规则本身没有错, 但结合测试数据中的 `例①`, LLM 很可能将其错误地理解为"所有带圆圈数字的都输出为对应的阿拉伯数字", 从而将 `例①` `例②` 等全部提取为 `label: 1` `label: 2`, 丢失了"例"这个关键前缀。相比之下, 官方 `Preserve each problem's original label/number` 的指令更具鲁棒性, 它明确要求 LLM 保留原始标签, 而不是进行任何转换。

### 阶段三: ID 回填原文 (ID Back-filling)

**DataFlow 算子**: `LLMOutputParser` [6]  
**Mineru2Questions 实现**: `parseLLMOutput` 函数

此阶段负责解析 LLM 返回的 XML 字符串, 提取出 `question`, `answer`, `solution` 等部分包含的 ID 列表, 并根据 ID 从 `content_list` 中回填真实的文本和图片路径。审查发现, `Mineru2Questions` 在此阶段的实现与官方逻辑基本对齐, 均使用正则表达式提取 XML 标签, 实现了 `idsToText` (对应官方的 `_id_to_text`) 函数进行 ID 回填, 并正确过滤了无效的 QA 对 (官方: `if not ((q_match and label_match) or ...): continue`, 当前实现: `if (!hasContent) { continue; }`)。此外, `Mineru2Questions` 还增加了一些有益的后处理步骤, 如过滤目录条目和拆分合并题。

**结论**: 该阶段与官方实现基本对齐, **不是当前问题的主要原因**。

### 阶段四: 问答对合并与去重 (QA Merging & Deduplication)

**DataFlow 算子**: `QA_Merger` [7]  
**Mineru2Questions 实现**: `mergeQAPairs` 函数

此阶段负责将从不同文件或不同 Chunk 中提取出的 `questions` 列表和 `answers` 列表进行合并, 形成最终完整的 QA 对。这是 **P1 (题号重复与章节混淆)** 问题的**直接原因**。

| 对比项 | DataFlow `QA_Merger` / `merge_qa_pair` | Mineru2Questions `mergeQAPairs` | 结论 |
| :--- | :--- | :--- | :--- |
| **合并逻辑** | 遍历 `questions` 和 `answers` 列表, 使用字典按 `chapter_title` 和 `label` 进行匹配 | 遍历 `questions` 和 `answers` 列表, 使用 `Map` 按 `key` 进行匹配 | ✅ **逻辑相似** |
| **去重键 (Key)** | `f"{refine_title(chapter_title)}:{label}"` (章节标题+题号) | `${questionChapterId}:${normalizedChapter}:${labelKey}` (章节ID+章节标题+题号) | ❌ **严重偏差** |
| **章节边界** | 依赖 `answers` 列表中的题号重置来判断章节边界 | 依赖 `questions` 列表中的题号重置来判断章节边界, 并自增 `questionChapterId` | ⚠️ **逻辑不同** |

**根因分析 (P1)**: `Mineru2Questions` 引入了一个复杂的 `questionChapterId` 机制来区分不同章节。该机制试图通过检测题号 `labelNum` 是否小于上一题的题号 `lastQuestionLabel` 来判断是否进入了新章节。然而, 这种启发式规则在真实场景中非常脆弱, 很容易因为以下情况而失效:

1.  **非顺序排列的题目**: 例如, 一个章节中先出现填空题 (1-10), 再出现选择题 (1-5), 系统会错误地认为选择题1是一个新章节的开始。
2.  **题号跳跃**: 例如, 一个章节中只有题目 1, 3, 5, 系统可能会错误地增加 `questionChapterId`。
3.  **章节标题缺失或不一致**: 如果某些题目的 `chapter_title` 为空或不一致, 系统的章节边界判断会完全失效。

这些问题导致去重键 `key` 计算错误, 最终使得不同章节的题目被错误地覆盖和丢弃。相比之下, DataFlow 的官方实现 `merge_qa_pair` (在 `dataflow/utils/pdf2vqa/format_utils.py` 中) 使用了更简洁、更鲁棒的逻辑: 直接使用规范化后的章节标题和题号作为匹配键 (`f"{refine_title(chapter_title)}:{label}"`), 不引入任何额外的启发式规则。它假定答案册的结构和题目册的结构是一致的, 这种假设在大多数情况下是成立的。

---

## 4. 优化建议与代码示例

基于上述对齐分析, 我们提供以下可直接落地的优化建议, 按优先级排序。

### P0: 立即修复 (对齐官方核心逻辑)

#### 建议 1: 修订 `mergeQAPairs` 函数 (核心)

**目标**: 彻底移除 `questionChapterId` 逻辑, 严格对齐 DataFlow 官方的 `merge_qa_pair` 方法, 使用更简洁、更鲁棒的 `normalizedChapter:labelKey` 作为去重键。

**建议的 `mergeQAPairs` 函数实现**: 

```typescript
/**
 * 合并问题和答案列表 (修订版)
 * 严格对齐 DataFlow 的 merge_qa_pair 实现
 */
export function mergeQAPairs(
  questions: ExtractedQAPair[],
  answers: ExtractedQAPair[],
  strictTitleMatch: boolean = false
): MergedQAPair[] {
  const finalMerged: MergedQAPair[] = [];
  const qaMap = new Map<string, ExtractedQAPair>();

  // 步骤 1: 遍历所有 questions, 填充 qaMap
  for (const q of questions) {
    const labelNum = normalizeLabel(q.label);
    if (labelNum === null) continue;

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
      continue;
    }

    // 对于只有 question 的条目, 存入 qaMap 等待 answer
    const normalizedChapter = normalizeTitle(q.chapter_title, strictTitleMatch);
    const labelKey = getLabelKey(q.label);
    const key = `${normalizedChapter}:${labelKey}`;

    if (!qaMap.has(key) || (q.question.length > (qaMap.get(key)?.question.length || 0))) {
        qaMap.set(key, q);
    }
  }

  // 步骤 2: 遍历所有 answers, 与 qaMap 中的 questions 合并
  for (const a of answers) {
    const labelNum = normalizeLabel(a.label);
    if (labelNum === null) continue;

    const normalizedChapter = normalizeTitle(a.chapter_title, strictTitleMatch);
    const labelKey = getLabelKey(a.label);
    const key = `${normalizedChapter}:${labelKey}`;

    if (qaMap.has(key)) {
      const q = qaMap.get(key)!;
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
        qaMap.delete(key);
      }
    } else {
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

  // 按章节和题号排序
  finalMerged.sort((a, b) => {
    const chapterCompare = a.question_chapter_title.localeCompare(b.question_chapter_title, undefined, { numeric: true });
    if (chapterCompare !== 0) return chapterCompare;
    return a.label - b.label;
  });

  return finalMerged;
}
```

**关键变更说明**:

1.  **彻底移除 `questionChapterId` 机制**: 删除 `questionChapterId`, `currentQuestionChapter`, `lastQuestionLabel` 等所有相关变量和逻辑。
2.  **简化去重键**: 使用 `const key = `${normalizedChapter}:${labelKey}`;` 作为唯一的去重和匹配键, 严格对齐官方实现。
3.  **优先处理 Interleaved 题目**: 对于自身已包含 question 和 answer/solution 的题目, 直接加入最终结果, 不参与后续的匹配逻辑。
4.  **择优保留策略**: 当同一个 `key` 对应多个 question 时, 保留内容更完整 (文本更长) 的那个。

#### 建议 2: 修订 `QA_EXTRACT_PROMPT` 提示词

**目标**: 恢复使用 DataFlow 官方更通用的 `Preserve each problem's original label/number` 指令, 将具体的格式规范化工作留给后处理函数, 这样更可靠。

**修改位置**: 在 `server/extraction.ts` 文件中, 找到 `QA_EXTRACT_PROMPT` 常量。

**替换**: 
```typescript
### About Questions and Answers/Solutions:
- Preserve each problem's original label/number (e.g., "①", "②", "例1", "1", "11"). Do not include periods after numbers.
- For circled numbers: use "1" for ①, "2" for ②, "3" for ③, etc.
- Use Arabic numerals only. Convert "例一" to "例1", "IV" to "4".
```

**修改为**: 
```typescript
### About Questions and Answers/Solutions:
- **Preserve each problem's original label/number**, such as "例1", "Example 3", "习题1", "11", "①".
- Use Arabic numerals for numbered lists, but preserve original prefixes. For example, if the label is "例一", convert it to "例1". If the label is "IV", convert it to "4".
```

**关键变更说明**:

1.  **移除强制转换指令**: 删除 `For circled numbers: use "1" for ①...` 这条容易引起歧义的指令。
2.  **强调保留原始标签**: 使用 `Preserve each problem's original label/number` 作为核心指令, 与官方提示词保持一致。
3.  **保留规范化指导**: 保留对中文数字和罗马数字的规范化要求, 但明确要求保留前缀 (如 "例", "习题")。

### P1: 重要优化 (提升鲁棒性)

#### 建议 3: 增加 `label` 后处理逻辑

**目标**: 完全依赖 LLM 正确输出 `label` 格式不够稳定。在 `parseLLMOutput` 或 `getLabelKey` 函数中, 对 LLM 提取出的 `label` 字符串进行一次强制的、确定性的规范化处理。

**建议的 `getLabelKey` 和 `normalizeLabel` 函数修订**:

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
  normalized = normalized.replace(/①/g, '1').replace(/②/g, '2').replace(/③/g, '3')
                         .replace(/④/g, '4').replace(/⑤/g, '5').replace(/⑥/g, '6')
                         .replace(/⑦/g, '7').replace(/⑧/g, '8').replace(/⑨/g, '9')
                         .replace(/⑩/g, '10');
  // 保留 "例" 等前缀并提取数字, 例如 "例1" -> "例1"
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

**关键变更说明**:

1.  **强制转换圆圈数字**: 在后处理阶段强制将 ①②③ 等转换为 1, 2, 3, 确保即使 LLM 输出格式不一致, 系统也能正确识别。
2.  **保留关键前缀**: 使用正则表达式提取并保留 "例", "习题" 等前缀, 确保 `getLabelKey` 返回的键能够区分不同类型的题目。
3.  **全角转半角**: 处理全角括号等特殊字符, 提升兼容性。

#### 建议 4: 改进 Interleaved 内容处理

**目标**: 当前 `splitMergedQuestion` 的逻辑可能过于激进, 导致一些本应保持完整的 Interleaved 题目被错误拆分。

**建议**: 审查 `splitMergedQuestion` 函数的逻辑, 确保只有在明确检测到多个独立题号 (如 `①...②...`) 时才进行拆分。对于 `例① ... 解: ...` 这种紧密跟随的结构, 应优先视为一个完整的 QA 对, 而不是拆分。

**建议的检查点**:

1.  在 `splitMergedQuestion` 中, 增加对 "解:", "分析:", "答案:" 等关键词的检测, 如果这些关键词紧跟在题号后面, 则不应拆分。
2.  使用更严格的题号识别正则表达式, 避免将段落中的数字误识别为题号。

### P2: 长期改进 (增强可维护性)

#### 建议 5: 增加可观测性

**目标**: 强烈建议在每个主要算子 (`convertContentList`, `extractQAPairsWithLLM`, `parseLLMOutput`, `mergeQAPairs`) 的入口和出口记录详细日志, 包括输入项数量、输出项数量、以及一个处理样本。这将极大地帮助未来定位问题。

**建议的日志格式**:

```typescript
console.log(`[mergeQAPairs] Input: ${questions.length} questions, ${answers.length} answers`);
console.log(`[mergeQAPairs] Sample question: ${JSON.stringify(questions[0])}`);
// ... 处理逻辑 ...
console.log(`[mergeQAPairs] Output: ${finalMerged.length} merged QA pairs`);
console.log(`[mergeQAPairs] Sample output: ${JSON.stringify(finalMerged[0])}`);
```

#### 建议 6: 引入单元测试

**目标**: 为 `normalizeTitle`, `normalizeLabel`, `getLabelKey`, `mergeQAPairs` 等关键纯函数编写单元测试, 覆盖各种边界情况, 确保其行为符合预期。

**建议的测试用例** (以 `getLabelKey` 为例):

```typescript
describe('getLabelKey', () => {
  it('should handle circled numbers', () => {
    expect(getLabelKey('例①')).toBe('例1');
    expect(getLabelKey('例②')).toBe('例2');
  });

  it('should preserve prefixes', () => {
    expect(getLabelKey('习题1')).toBe('习题1');
    expect(getLabelKey('填空3')).toBe('填空3');
  });

  it('should handle plain numbers', () => {
    expect(getLabelKey('1')).toBe('1');
    expect(getLabelKey('10')).toBe('10');
  });

  it('should handle Chinese numbers', () => {
    expect(getLabelKey('例一')).toBe('例1'); // 需要额外的中文数字转换逻辑
  });
});
```

---

## 5. 实施路线图

我们建议按以下优先级和时间线实施上述优化:

| 阶段 | 优先级 | 任务 | 预期完成时间 | 预期效果 |
| :--- | :--- | :--- | :--- | :--- |
| **阶段 1** | **P0** | 修订 `mergeQAPairs` 函数, 移除 `questionChapterId` 机制 | **1-2天** | **根本解决 P1 (题号重复与章节混淆) 问题** |
| **阶段 1** | **P0** | 修订 `QA_EXTRACT_PROMPT` 提示词, 对齐官方 `Preserve` 指令 | **1天** | **根本解决 P2 (题目标签提取不准确) 问题** |
| **阶段 2** | **P1** | 增加 `label` 后处理逻辑, 强化 `getLabelKey` 函数 | **1天** | **提升 label 识别的鲁棒性, 处理 LLM 输出不一致的情况** |
| **阶段 2** | **P1** | 改进 `splitMergedQuestion` 逻辑, 优化 Interleaved 处理 | **1-2天** | **减少 P3 (题目内容切分不完整) 问题的发生频率** |
| **阶段 3** | **P2** | 增加日志记录, 提升可观测性 | **1天** | **便于未来问题定位和调试** |
| **阶段 3** | **P2** | 编写单元测试, 覆盖核心函数 | **2-3天** | **确保代码质量, 防止回归** |

**总预计时间**: 7-10天

---

## 6. 结论

`Mineru2Questions` 项目的整体架构与 DataFlow 官方流水线高度一致, 已成功搭建了基于 ID 的逻辑组装框架。然而, 在提示词和合并逻辑两个关键点的偏差导致了当前的主要问题。我们相信, 在完成 P0 级别的修复后, 当前的题号重复和标签错误问题将得到根本解决。P1 和 P2 的优化将进一步提升系统的稳定性和可维护性, 使其能够兼容更多种类的教育文本, 并为未来的功能扩展奠定坚实的基础。

我们期待看到 `Mineru2Questions` 项目在对齐官方最佳实践后, 能够更稳定、更完整地抽取题目与问答对, 为用户提供更高质量的服务。

---

**参考文献**

[1] OpenDCAI. (2024). *DataFlow Official Repository*. GitHub. [https://github.com/OpenDCAI/DataFlow](https://github.com/OpenDCAI/DataFlow)

[2] OpenDCAI. (2024). *pdf_vqa_extract_pipeline.py*. GitHub. [https://github.com/OpenDCAI/DataFlow/blob/main/dataflow/statics/pipelines/api_pipelines/pdf_vqa_extract_pipeline.py](https://github.com/OpenDCAI/DataFlow/blob/main/dataflow/statics/pipelines/api_pipelines/pdf_vqa_extract_pipeline.py)

[3] shcming2023. (2026). *Mineru2Questions Test Output*. GitHub. [https://github.com/shcming2023/Mineru2Questions/tree/main/server/uploads/tasks/202602080714-1770506098605](https://github.com/shcming2023/Mineru2Questions/tree/main/server/uploads/tasks/202602080714-1770506098605)

[4] OpenDCAI. (2024). *mineru_to_llm_input_operator.py*. GitHub. [https://github.com/OpenDCAI/DataFlow/blob/main/dataflow/operators/pdf2vqa/generate/mineru_to_llm_input_operator.py](https://github.com/OpenDCAI/DataFlow/blob/main/dataflow/operators/pdf2vqa/generate/mineru_to_llm_input_operator.py)

[5] OpenDCAI. (2024). *pdf2vqa.py (Prompts)*. GitHub. [https://github.com/OpenDCAI/DataFlow/blob/main/dataflow/prompts/pdf2vqa.py](https://github.com/OpenDCAI/DataFlow/blob/main/dataflow/prompts/pdf2vqa.py)

[6] OpenDCAI. (2024). *llm_output_parser.py*. GitHub. [https://github.com/OpenDCAI/DataFlow/blob/main/dataflow/operators/pdf2vqa/generate/llm_output_parser.py](https://github.com/OpenDCAI/DataFlow/blob/main/dataflow/operators/pdf2vqa/generate/llm_output_parser.py)

[7] OpenDCAI. (2024). *qa_merger.py*. GitHub. [https://github.com/OpenDCAI/DataFlow/blob/main/dataflow/operators/pdf2vqa/generate/qa_merger.py](https://github.com/OpenDCAI/DataFlow/blob/main/dataflow/operators/pdf2vqa/generate/qa_merger.py)
