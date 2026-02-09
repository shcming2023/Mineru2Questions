# Mineru2Questions 项目评审报告 (v1.2)

**日期**: 2026年2月9日
**版本**: v1.2
**评审目标**: 对齐 OpenDCAI/DataFlow 官方最佳实践，诊断当前实现中的问题，并提供可落地的优化建议。

---

## 1. 总体评价

首先，我们认可项目在 v1.1 版本中所做的努力，特别是在代码精简和流程简化方面。从 `REFACTORING_SUMMARY_v1.1.md` 中可以看出，团队明确了“高质量题目提取”的核心目标，并移除了远距离答案匹配等复杂模块，这是完全正确的方向。项目朝着更稳定、更可维护的架构迈出了重要一步。

然而，通过对最新测试任务 `202602091251-1770612687148` 的输出进行深入分析，并与 `OpenDCAI/DataFlow` 官方流水线进行逐阶段对齐后，我们发现当前实现仍存在若干与官方实践偏离的关键问题。这些问题直接导致了输出质量的下降，例如章节标题混乱、题目内容丢失、编号重复等。本报告将逐一剖析这些问题的根因，并提供具体的代码级修复建议。

**核心结论**: 当前问题主要源于 **输入格式化算子 (Input Formatter)** 的实现与官方逻辑存在较大偏差，导致送入 LLM 的数据质量不足。**我们应优先修复数据输入端，而不是调整提示词或解析逻辑。**

---

## 2. 根因分析与核心问题

经过分析，我们将问题定位在流水线的三个主要阶段：**输入格式化**、**ID 回填** 和 **配置缺陷**。

### 2.1. 输入格式化阶段 (Input Formatting Operator) - P0 级问题

此阶段对应 `extraction.ts` 中的 `loadAndFormatBlocks` 函数。其职责本应与 DataFlow 的 `MinerU2LLMInputOperator` 对齐，对 `content_list.json` 进行预处理，为 LLM 提供干净、结构化的输入。但当前实现存在多个严重缺陷，是导致后续一系列问题的根源。

| 问题点 | 当前实现 (Mineru2Questions) | 官方实现 (DataFlow) | 负面影响 |
| :--- | :--- | :--- | :--- |
| **1. `list` 类型处理** | 将所有 `list_items` 用空格拼接成一个长字符串。 | 将每个 `list_item` 展平为独立的 `text` 块，并重新分配连续 ID。 | 丢失了列表的结构化信息，LLM 难以区分独立的题目或步骤。 |
| **2. `equation` 类型处理** | 完全忽略 `equation` 块的 `text` 字段（包含 LaTeX）。 | 保留 `equation` 块及其 `text` 字段。 | 导致所有数学公式内容丢失，题目不完整。 |
| **3. 噪声块未过滤** | 保留了 `page_number` 和 `footer` 类型的块。 | 在预处理阶段通常会过滤掉这些与内容无关的噪声块。 | 向 LLM 提供了无关噪声，增加了其识别负担，可能导致幻觉或错误。 |
| **4. `table` 类型处理** | 将表格的每一行 `<tr>...</tr>` 提取为带 `[Table Row]` 前缀的文本。 | 官方实现中没有固定的表格拆分逻辑，但更倾向于将整个表格作为一个单元。 | 当前实现是合理的，但由于其他块处理不当，其优势未能体现。 |
| **5. ID 分配逻辑** | 在 `table` 拆分时 `currentId` 会增加，但后续非 `table` 块处理时，ID 分配逻辑 `block.id !== undefined ? block.id : currentId++` 未考虑到 `content_list.json` 原始数据不含 `id` 字段，导致 ID 不连续。 | 严格保证所有块在处理后都拥有连续、唯一的 ID。 | ID 不连续会严重误导 LLM 对上下文的判断，破坏了“ID 连续性”这一核心规则。 |

### 2.2. ID 回填阶段 (ID Refilling / Parser) - P1 级问题

此阶段对应 `parser.ts` 中的 `getTextAndImagesFromIds` 函数。即使 LLM 能够正确输出 ID，回填阶段的缺陷也会导致最终文本不完整。

- **问题**: 该函数在回填文本时，未处理 `type: 'equation'` 的情况。它只检查 `block.text` 是否存在，而 `equation` 块的文本在输入格式化阶段已被丢弃。即使修复了输入问题，这里的逻辑缺陷依然会导致公式无法回填。

### 2.3. 配置与路径问题 (Configuration & Path) - P1 级问题

- **问题**: `parser.ts` 中的 `getTextAndImagesFromIds` 函数将图片路径硬编码为 `/home/home_dev/...`。这是一个绝对路径，与当前运行环境无关，导致所有图片链接失效。
- **根因**: `imagePrefix` 参数在 `QuestionParser` 构造时传入，但在回填图片路径时未使用。代码 `images.push(`${this.imagePrefix}/${block.img_path}`);` 存在，但似乎未在所有场景生效，或 `imagePrefix` 本身设置错误。

### 2.4. 章节标题与题目编号问题 (Chapter & Labeling) - P2 级问题

- **问题 1 (章节标题混乱)**: 大量的题目指令（如“一. 选择题”、“二. 递等式计算”）被错误地识别为 `chapter_title`。
- **根因**: 这主要是 **输入格式化** 阶段的连锁反应。由于 `list` 和 `equation` 块被错误处理，LLM 看到的上下文是破碎的。为了寻找一个“标题”，它错误地抓取了最近的、看起来像指令的文本块。官方 DataFlow 的 `QAExtractPrompt` 对标题有更严格的约束（例如，标签不为 1 的标题被视为子标题并忽略），这在当前实现中未被严格执行。

- **问题 2 (题号重复)**: 大量题目的 `label` 都是 `1`。
- **根因**: 同上，破碎的上下文使 LLM 难以正确识别连续的题目序列。每个看起来像新题目的地方，它都重新从 `1` 开始编号。

---

## 3. 核心修复建议 (Actionable Recommendations)

我们必须严格遵循 DataFlow 的算子职责划分。**首要任务是重构 `loadAndFormatBlocks` 函数**，使其行为与 `MinerU2LLMInputOperator` 完全对齐。在输入端得到高质量、结构化的数据之前，任何对 `prompt` 或 `parser` 的修改都是治标不治本。

### 3.1. [P0] 重构 `loadAndFormatBlocks` 函数

**目标**: 创建一个与 DataFlow `MinerU2LLMInputOperator` 行为一致的 TypeScript 实现。

**伪代码/TypeScript 接口**: 

```typescript
function loadAndFormatBlocks(contentListPath: string): ConvertedBlock[] {
  const contentList: ContentBlock[] = JSON.parse(fs.readFileSync(contentListPath, 'utf-8'));
  const formattedBlocks: ConvertedBlock[] = [];
  let currentId = 0;

  for (const block of contentList) {
    const blockType = block.type;

    // 1. 过滤噪声块
    if (['page_number', 'footer', 'header'].includes(blockType)) {
      continue;
    }

    // 2. 展平 list 块
    if (blockType === 'list' && block.list_items) {
      for (const itemText of block.list_items) {
        formattedBlocks.push({
          id: currentId++,
          type: 'text', // 将 list_item 转换为 text 类型
          text: itemText.trim(),
          page_idx: block.page_idx,
        });
      }
      continue; // 继续下一个原始 block
    }

    // 3. 拆分 table 块 (当前逻辑可保留，但需确保 ID 连续)
    const tableContent = block.text || (block as any).table_body;
    if (blockType === 'table' && typeof tableContent === 'string' && tableContent.includes('<tr')) {
      const rows = tableContent.match(/<tr[\s\S]*?<\/tr>/gi) || [];
      for (const rowHtml of rows) {
        formattedBlocks.push({
          id: currentId++,
          type: 'text',
          text: `[Table Row] ${rowHtml}`,
          page_idx: block.page_idx,
        });
      }
      continue;
    }

    // 4. 处理其他类型 (text, equation, image)
    const newBlock: ConvertedBlock = {
      id: currentId,
      type: blockType,
      page_idx: block.page_idx,
    };

    if (block.text) {
      newBlock.text = block.text.trim(); // 保留 text, 无论 type 是 text 还是 equation
    }

    if (blockType === 'image' && block.img_path) {
      newBlock.img_path = block.img_path;
      if (block.image_caption && block.image_caption.length > 0) {
        newBlock.image_caption = block.image_caption.join(' ');
      }
    }

    formattedBlocks.push(newBlock);
    currentId++;
  }

  return formattedBlocks;
}
```

### 3.2. [P1] 修复 `parser.ts` 中的回填与路径问题

**目标**: 确保 `equation` 文本能被正确回填，并且图片路径正确。

**修订 `getTextAndImagesFromIds` 函数**: 

```typescript
// 在 server/parser.ts 中
private getTextAndImagesFromIds(ids: string): { text: string; images: string[] } {
  // ... (已有代码)
  for (const id of idList) {
    const block = this.blocks.find(b => b.id === id);
    if (!block) continue;

    if (block.type === 'image' && block.img_path) {
      // 修复：使用 this.imagePrefix 构造正确路径
      // 注意：确保调用 QuestionParser 时传入的 imagePrefix 是正确的相对或绝对路径
      images.push(path.join(this.imagePrefix, block.img_path)); 
    } else if (block.text) {
      // 核心修复：无论是 text 还是 equation，只要有 text 字段就回填
      textParts.push(block.text);
    }
  }
  // ... (已有代码)
}
```

### 3.3. [P2] 优化 `prompt` 与章节标题过滤

在完成 P0 和 P1 修复后，LLM 的输入质量将大幅提升。此时再对 `prompt` 进行微调将事半功倍。

**建议**: 
1.  **对齐 DataFlow Prompt**: 仔细比对 `prompts.ts` 和 DataFlow 的 `QAExtractPrompt`，特别是关于“子标题”（即题号不为1的标题）的处理规则，并将其明确添加到 `QUESTION_EXTRACT_PROMPT` 中。

    > **DataFlow 规则**: "Any title followed by a question/answer whose label/number is not 1, or title with a score such as "一、选择题（每题1分，共10分）", should NOT be extracted." 

2.  **增加后处理过滤**: 在 `extraction.ts` 的 `filterLowQuality` 或新增的函数中，增加一个基于规则的章节标题清洗步骤，过滤掉包含“选择题”、“填空题”、“应用题”等关键词的 `chapter_title`。

```typescript
// 在 server/extraction.ts 中新增或修改
function cleanChapterTitles(questions: ExtractedQuestion[]): ExtractedQuestion[] {
  const titleBlacklist = ["选择题", "填空题", "判断题", "应用题", "计算题", "递等式", "竖式"];
  let lastValidTitle = "";

  return questions.map(q => {
    const isNoiseTitle = titleBlacklist.some(keyword => q.chapter_title.includes(keyword));
    if (isNoiseTitle) {
      q.chapter_title = lastValidTitle; // 使用上一个有效的标题
    } else {
      lastValidTitle = q.chapter_title;
    }
    return q;
  });
}

// 在 extractQuestions 主函数中调用
// ...
const uniqueQuestions = deduplicateQuestions(allQuestions);
const typedQuestions = identifyQuestionTypes(uniqueQuestions); // 假设此函数存在
const cleanedQuestions = cleanChapterTitles(typedQuestions);
const filteredQuestions = filterLowQuality(cleanedQuestions);
// ...
```

---

## 4. 调试与可观测性建议

当前实现已经包含了保存 LLM 中间输出的逻辑，这是一个非常好的实践。但在本次评审的测试任务中，我们未能找到这些日志文件。

- **务必确保**: 每次任务运行时，`logs` 目录（包含 `chunk_..._llm_output.txt`, `chunk_..._parsed_questions.log` 等）都被完整保留下来。这是诊断 LLM 相关问题的唯一可靠依据。
- **建议**: 在 `taskProcessor.ts` 中，无论任务成功或失败，都应将 `logs` 目录打包归档，或在数据库中记录其路径，以便随时回溯。

---

## 5. 总结与后续步骤

Mineru2Questions 项目 v1.1 的重构方向正确，但核心的数据预处理环节存在严重偏差，导致了当前输出的质量问题。我们强烈建议开发团队**暂停对 `prompt` 的进一步调整**，集中精力按以下优先级顺序完成修复：

1.  **[P0] 重构 `loadAndFormatBlocks` 函数**，使其与 DataFlow 官方实现对齐，确保为 LLM 提供高质量的输入。
2.  **[P1] 修复 `parser.ts`** 中的 `equation` 回填逻辑和图片路径硬编码问题。
3.  **[P2] 验证修复效果**，在输入质量得到保证后，再评估是否需要微调 `prompt` 或增加章节标题后处理逻辑。
4.  **[P2] 强化可观测性**，确保每次运行的中间日志都得到妥善保存。

完成以上修复后，我们预期题目的提取完整性和准确性将得到根本性的改善，从而真正实现 v1.1 版本“高质量题目提取”的目标。
