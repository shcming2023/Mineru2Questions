# Mineru2Questions 技术对齐审查报告 (草稿)

**目标**: 指导 Mineru2Questions 项目对齐 OpenDCAI/DataFlow 官方流水线最佳实践, 解决当前 QA 抽取中的问题。

**核心原则**: 严格遵循“基于ID的逻辑组装”方案, 以官方 `PDF_VQA_extract_optimized_pipeline` 为唯一事实标准 (Source of Truth)。

## 1. 问题诊断回顾

通过对[最新测试输出](https://github.com/shcming2023/Mineru2Questions/tree/main/server/uploads/tasks/202602080714-1770506098605)的审查, 我们确认了以下核心问题:

- **P1: 题号重复与章节混淆 (高优先级)**: 不同章节的题号 (如 `label: 1`) 被错误地合并或覆盖, 导致大量题目丢失。例如, `label: 1` 在结果中出现了21次, 但它们分属于不同章节, 实际上并非重复题目。
- **P2: 题目标签提取不准确 (高优先级)**: 大量题目的 `label` 被错误地提取为 `1`, 尤其是对于使用 "例①" 这种格式的题目, 原始的 "例" 标识和正确的序号都丢失了。
- **P3: 题目内容切分不完整 (中优先级)**: 部分题目 (Question) 与其解答 (Solution) 被拆分到不同的问答对中, 破坏了题目的完整性, 尤其是在题目与解答交错 (Interleaved) 的场景下。

这些问题的根源在于当前实现与 DataFlow 官方流水线在几个关键算子阶段存在偏差。下面将按算子阶段进行逐段对齐分析。

## 2. 按算子阶段逐段对齐分析

官方 `PDF_VQA_extract_optimized_pipeline` 流水线定义了清晰的算子职责。我们将以此为框架, 对比 `Mineru2Questions` 的当前实现。

### **阶段一: 输入格式化与标准化 (Input Formatting)**

- **DataFlow 算子**: `MinerU2LLMInputOperator`
- **Mineru2Questions 实现**: `convertContentList` 函数

**功能**: 此阶段负责将 MinerU 解析产物 `content_list.json` 转换为扁平化的、带有连续ID的、适合LLM处理的格式。

**对齐分析**: 

| 对比项 | DataFlow `MinerU2LLMInputOperator` | Mineru2Questions `convertContentList` | 结论 |
| :--- | :--- | :--- | :--- |
| **核心职责** | 展平列表项, 重新编号 | 展平列表项, 重新编号 | ✅ **基本对齐** |
| **列表处理** | 将 `type: 'list'` 的 `list_items` 展开为多个独立的 `type: 'text'` 块 | 将 `type: 'list'` 的 `list_items` 展开为多个独立的 `type: 'text'` 块 | ✅ **对齐** |
| **ID 分配** | 遍历过程中动态分配连续ID | 遍历过程中动态分配连续ID | ✅ **对齐** |
| **字段移除** | 移除 `bbox`, `page_idx` 等LLM无关字段 | 移除 `bbox`, `page_idx` 等LLM无关字段 | ✅ **对齐** |

**诊断结论**: 输入格式化阶段与官方实现基本保持一致, 功能满足要求, **不是当前问题的主要原因**。

### **阶段二: 基于上下文的 LLM 抽取 (LLM Extraction)**

- **DataFlow 算子**: `ChunkedPromptedGenerator` + `QAExtractPrompt`
- **Mineru2Questions 实现**: `extractQAPairsWithLLM` + `QA_EXTRACT_PROMPT`

**功能**: 此阶段将格式化后的内容块和精心设计的提示词 (Prompt) 发送给 LLM, 要求 LLM 仅输出包含内容块 ID 的结构化 XML。

**对齐分析**: 

这是问题的**核心所在**。`Mineru2Questions` 的提示词与官方版本存在关键偏差, 直接导致了 **P2 (题目标签提取不准确)** 的问题。

| 对比项 | DataFlow `QAExtractPrompt` | Mineru2Questions `QA_EXTRACT_PROMPT` | 结论 |
| :--- | :--- | :--- | :--- |
| **Label提取** | `Preserve each problem’s original label/number` (保留原始标签) | `For circled numbers: use "1" for ①, "2" for ②` (强制转换) | ❌ **严重偏差** |
| **Label规范化** | `Use Arabic numerals only. For example, if the label is "例一", convert it to "例1"` (规范化中文数字) | `Use Arabic numerals only. Convert "例一" to "例1"` | ✅ **对齐** |
| **ID连续性** | 隐式要求 | `CRITICAL: Consecutive ID Handling` (显式强调) | ⬆️ **优化增强** |
| **题目定义** | 区分题目与定义 | `DISTINGUISH DEFINITIONS FROM PROBLEMS` (显式强调) | ⬆️ **优化增强** |

**根因分析 (P2)**:

`Mineru2Questions` 的提示词中存在一条指令: `For circled numbers: use "1" for ①, "2" for ②`。这条规则本身没有错, 但结合测试数据中的 `例①`, LLM 很可能将其错误地理解为“所有带圆圈数字的都输出为对应的阿拉伯数字”, 从而将 `例①` `例②` 等全部提取为 `label: 1` `label: 2`, 丢失了“例”这个关键前缀。而官方 `Preserve each problem’s original label/number` 的指令则更具鲁棒性。

### **阶段三: ID 回填原文 (ID Back-filling)**

- **DataFlow 算子**: `LLMOutputParser`
- **Mineru2Questions 实现**: `parseLLMOutput` 函数

**功能**: 此阶段负责解析 LLM 返回的 XML 字符串, 提取出 `question`, `answer`, `solution` 等部分包含的 ID 列表, 并根据 ID 从 `content_list` 中回填真实的文本和图片路径。

**对齐分析**: 

| 对比项 | DataFlow `LLMOutputParser` | Mineru2Questions `parseLLMOutput` | 结论 |
| :--- | :--- | :--- | :--- |
| **XML解析** | 使用正则表达式提取 `<qa_pair>` 等 | 使用正则表达式提取 `<qa_pair>` 等 | ✅ **对齐** |
| **ID回填** | `_id_to_text` 函数实现 | `idsToText` 函数实现 | ✅ **对齐** |
| **有效性过滤** | `if not ((q_match and label_match) or ...): continue` | `if (!hasContent) { continue; }` | ✅ **对齐** |
| **额外处理** | 无 | 增加对目录条目、合并题目的二次过滤和拆分 | ⬆️ **优化增强** |

**诊断结论**: ID 回填阶段与官方实现基本对齐, 并且增加了一些有益的后处理步骤, **不是当前问题的主要原因**。

### **阶段四: 问答对合并与去重 (QA Merging & Deduplication)**

- **DataFlow 算子**: `QA_Merger`
- **Mineru2Questions 实现**: `mergeQAPairs` 函数

**功能**: 此阶段负责将从不同文件或不同 Chunk 中提取出的 `questions` 列表和 `answers` 列表进行合并, 形成最终完整的 QA 对。

**对齐分析**: 

此阶段是 **P1 (题号重复与章节混淆)** 问题的**直接原因**。

| 对比项 | DataFlow `QA_Merger` / `merge_qa_pair` | Mineru2Questions `mergeQAPairs` | 结论 |
| :--- | :--- | :--- | :--- |
| **合并逻辑** | 遍历 `questions` 和 `answers` 列表, 使用字典按 `chapter_title` 和 `label` 进行匹配 | 遍历 `questions` 和 `answers` 列表, 使用 `Map` 按 `key` 进行匹配 | ✅ **逻辑相似** |
| **去重键 (Key)** | `f"{refine_title(chapter_title)}:{label}"` (章节标题+题号) | `${questionChapterId}:${normalizedChapter}:${labelKey}` (章节ID+章节标题+题号) | ❌ **严重偏差** |
| **章节边界** | 依赖 `answers` 列表中的题号重置来判断章节边界 | 依赖 `questions` 列表中的题号重置来判断章节边界, 并自增 `questionChapterId` | ⚠️ **逻辑不同** |

**根因分析 (P1)**:

`Mineru2Questions` 引入了一个复杂的 `questionChapterId` 机制来区分不同章节。该机制试图通过检测题号 `labelNum` 是否小于上一题的题号 `lastQuestionLabel` 来判断是否进入了新章节。然而, 这种启发式规则在真实场景中非常脆弱, 很容易因为一道选填题或非顺序排列的题目而错误地增加 `questionChapterId`, 导致去重键 `key` 计算错误, 最终使得不同章节的题目被错误地覆盖和丢弃。

相比之下, DataFlow 的官方实现 `merge_qa_pair` (在 `dataflow/utils/pdf2vqa/format_utils.py` 中) 使用了更简洁、更鲁棒的逻辑: 直接使用规范化后的章节标题和题号作为匹配键。它假定答案册的结构和题目册的结构是一致的, 这种假设在大多数情况下是成立的。

**诊断结论**: `mergeQAPairs` 函数中**过于复杂的、不可靠的 `questionChapterId` 机制**是导致 P1 问题的直接原因。该原因。该原因。
