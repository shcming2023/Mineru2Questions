# Mineru2Questions 项目评审报告 (v1.3)

**致**：项目总设计师与技术总监
**发件人**：Manus AI (独立测试部门)
**日期**：2026年02月09日
**主题**：关于 Commit `87e5b49` 的全面代码评审、根因分析与对齐审查

## 1. 评审摘要 (Executive Summary)

本次评审旨在评估 `Mineru2Questions` 项目在最新提交 (`87e5b49`) 中的代码修复、功能正确性，并与 `OpenDCAI/DataFlow` 官方流水线进行对齐分析。评审发现，尽管前端提交了修复，但最新的测试任务 (`202602091702-1770627742964`) 仍然失败，**核心产出为 0 道题目**。

根本原因已定位为两处**关键代码缺陷 (Critical Bugs)**：

1.  **API 端点调用错误**：在 `extraction.ts` 中，向 LLM 发起请求的 `axios.post` 调用直接使用了基础 `apiUrl`，**遗漏了必要的 `/chat/completions` 路径**。这是一个近期代码重构中引入的**严重回归 (Severe Regression)**，导致所有对大模型的 API 调用均返回 404 或类似错误，并被异常捕获逻辑静默吞噬，造成了任务在 3 秒内“成功”结束却无任何产出的假象。
2.  **任务目录路径解析错误**：在 `taskProcessor.ts` 中，用于确定日志和结果输出位置的 `taskDir` 变量，因错误的 `path.dirname` 调用层级，指向了父级 `tasks/` 目录，而非具体的任务ID子目录 (`tasks/<task-id>/`)。这导致所有中间产物（如 `debug` 文件）被写入了错误的共享位置，且关键的 `logs` 目录（用于保存 LLM 原始输出）未能成功创建，极大地增加了问题排查的难度。

此外，项目在流水线设计上与 `DataFlow` 官方实践存在显著差异，尤其是在**问答对合并策略、提示词工程、以及错误处理和容错机制**方面。当前实现虽然在某些方面（如输入格式化、ID-Only 严格校验）做得不错，但整体架构的鲁棒性和可维护性与官方实现尚有差距。

本报告将详细阐述根因分析过程，提供与官方流水线的详细对齐比较，并给出包含**P0级修复建议**在内的具体优化路径。

## 2. 根因分析：为何最新测试输出为 0 题？

对测试任务 `202602091702-1770627742964` 的深入分析揭示了问题并非出在 `splitIntoChunks` 的死循环（该问题已修复），而是出在更底层的 API 调用环节。

### 2.1. 现象：3秒“完成”的任务

通过分析 `sqlite.db` 中的任务日志，我们发现了决定性的线索：

> - **任务 25 (最新测试)**: 处理 16 个数据块 (chunks)，耗时 **3 秒**，产出 0 题。
> - **任务 23 (历史成功任务)**: 处理相似数据，耗时 **14.5 分钟**，产出 575 题。

悬殊的时间差异明确指向 `extractQuestions` 循环中的 `callLLM` 函数调用并未实际发生或在极短时间内失败。日志显示所有 16 个 chunk 的 `Processing chunk...` 消息被瞬间打印，随后直接进入 `Deduplicating and filtering...` 阶段，这证实了 LLM 调用被 `try...catch` 块完全绕过。

### 2.2. 缺陷一：API 端点回归 (P0级)

通过 `git show` 对比历史版本，我们定位了问题的根源。在 `d345d6d` 等早期成功版本中，`extraction.ts` 内的 API 调用逻辑如下：

```typescript
// 历史正确实现 (e.g., commit d345d6d)
const baseUrl = config.apiUrl.replace(/\/chat\/completions\/?$/, "").replace(/\/+$/, "");
const response = await axios.post(
  `${baseUrl}/chat/completions`, // 正确拼接了 /chat/completions
  // ... payload
);
```

然而，在最新的代码 (`4496d4d` 及之后) 中，`callLLM` 函数的实现被简化为：

```typescript
// 当前错误实现 (commit 4496d4d, 87e5b49)
const response = await axios.post(
  config.apiUrl, // 直接使用 apiUrl，未拼接 /chat/completions
  // ... payload
);
```

数据库中的 `llm_configs` 表显示，`apiUrl` 字段存储的是基础 URL (`https://dashscope.aliyuncs.com/compatible-mode/v1`)。因此，当前代码实际上在向一个不存在的端点 (`.../v1`) 发起 POST 请求，这必然导致 API 服务商返回 HTTP 404 或相关错误。该错误被 `extractQuestions` 函数中的 `catch (error: any)` 块捕获并仅在控制台打印一条错误信息，随后循环继续，导致所有 chunk 全部静默失败。

### 2.3. 缺陷二：任务目录解析错误 (P1级)

在 `taskProcessor.ts` 的第 88 行，`taskDir` 的计算方式为：

```typescript
// 当前错误实现
const taskDir = path.dirname(path.dirname(contentListPath)); // 上两级目录
```

由于 `contentListPath` 的完整路径是 `.../server/uploads/tasks/<task-id>/content_list.json`，连续调用两次 `path.dirname` 会将 `taskDir` 解析为 `.../server/uploads/tasks`，而不是预期的 `.../server/uploads/tasks/<task-id>`。这直接导致了：

- **日志丢失**：`extraction.ts` 中创建 `logs` 目录的逻辑 (`path.join(taskDir, 'logs')`) 试图在错误的路径下操作，且由于权限或逻辑问题未能成功创建，导致所有 `llm_output.txt` 和 `parse_error.log` 文件无法写入，问题排查极为困难。
- **中间产物混乱**：`debug` 和 `results` 目录被错误地创建和共享在 `tasks/` 级别，导致不同任务的输出相互覆盖或混淆。

## 3. 与 DataFlow 官方流水线对齐分析

在修复上述关键缺陷的基础上，我们必须重新审视项目实现与 `OpenDCAI/DataFlow` 官方 `PDF_VQA_extract_optimized_pipeline` 的差距，以提升长期稳定性和可维护性。下表总结了核心算子层面的差异：

| 流水线阶段 | DataFlow 官方实现 (Python) | Mineru2Questions 当前实现 (TypeScript) | 对齐建议与风险说明 |
| :--- | :--- | :--- | :--- |
| **1. 输入格式化** | `MinerU2LLMInputOperator`：展平列表、移除 `bbox` 和 `page_idx`、**重新生成连续ID**。 | `loadAndFormatBlocks`：展平列表、**保留 `page_idx`**、重新生成连续ID。 | **保留 `page_idx` 是合理的优化**，有助于后续追溯。当前实现基本对齐。 |
| **2. LLM 提示词** | `QAExtractPrompt`：要求 LLM **同时输出 ID-based 的 `<question>` 和 text-based 的 `<answer>`**（短答案），不含 `<type>` 标签。 | `QUESTION_EXTRACT_PROMPT`：要求 LLM **只输出 ID**，包含 `<type>` 标签（例题/练习题），不要求提取短答案。 | **建议对齐官方，让 LLM 提取短答案**。这能有效解耦答案和解析，避免了当前实现中将“答案”和“解析”混在 `<solution>` 里的问题。可以先作为 P2 优化项。 |
| **3. 输出解析** | `LLMOutputParser`：使用 `re.findall` 提取 XML 块，通过 `_id_to_text` 回填文本。容错较为简单。 | `QuestionParser`：**引入“严格解析”和“宽松解析”双模式**，对 ID 格式有严格校验。 | **当前“严格解析”可能过严**，容易因 LLM 输出微小瑕疵而拒绝整个 chunk。建议简化，或将严格校验作为一种质量评估信号，而不是硬性拒绝规则。 |
| **4. 问答对合并** | **核心差异**：官方为**双流水线设计**。分别运行 `question` 和 `answer` 提取流程，产出两个 `jsonl` 文件，最后由 `QA_Merger` 算子基于 `(chapter_title, label)` 进行匹配合并。 | **单流水线设计**：一次 LLM 调用同时提取题目和（部分）答案，后续仅做去重 (`deduplicateQuestions`)。 | **官方的双流水线设计更具鲁棒性**。它将复杂任务分解，降低了对单次 LLM 调用的prompt复杂度和输出稳定性的要求。当前项目短期内可维持单流水线，但长期来看，**向官方的双流水线+合并模式演进是提升稳定性的必由之路**。 |
| **5. 章节标题处理** | `refine_title`：通过正则表达式提取数字编号（如 `22.1`），逻辑更通用。 | `cleanChapterTitles`：基于一个**硬编码的黑名单**（如“选择题”、“填空题”）进行过滤。 | **应采用官方的规则化提取方案**。黑名单机制脆弱且不可扩展，无法适应新的题型或表达方式。 |

## 4. 修订与优化建议

为使项目回归正轨并向更健壮的架构演进，现提出以下分级建议：

### P0：必须立即执行的修复

1.  **修复 API 端点**：在 `server/extraction.ts` 的 `callLLM` 函数中，必须在 `axios.post` 调用时，将 `config.apiUrl` 与 `/chat/completions` 正确拼接。

    ```typescript
    // 修正建议
    const endpoint = config.apiUrl.endsWith("/") ? `${config.apiUrl}chat/completions` : `${config.apiUrl}/chat/completions`;
    const response = await axios.post(endpoint, /* ... */);
    ```

2.  **修复任务目录路径**：在 `server/taskProcessor.ts` 中，修正 `taskDir` 的计算逻辑。

    ```typescript
    // 修正建议 (line 88)
    const imagesFolder = path.dirname(contentListPath);
    const taskDir = imagesFolder; // 直接使用 imagesFolder 的路径作为任务根目录
    ```

3.  **增强错误日志**：在 `extractQuestions` 的主 `catch` 块中，除了 `console.error`，必须将详细的错误对象（包括 `error.stack`）写入到 `logs` 目录下的错误日志文件中。确保即使 API 调用失败，也能留下可追溯的记录。

### P1：强烈建议的短期优化

1.  **对齐章节标题处理**：废弃 `cleanChapterTitles` 中的黑名单逻辑，参考 `DataFlow` 的 `refine_title` 函数，实现一个基于正则表达式提取章节数字编号的函数。
2.  **简化解析器**：暂时移除 `QuestionParser` 中的“严格解析”模式，或将其降级为告警，避免因 LLM 输出的微小格式问题导致整个 chunk 被丢弃。优先保证数据能被“宽松解析”模式最大程度地捞回。

### P2：长期架构演进方向

1.  **规划双流水线架构**：启动重构规划，将当前的单次提取模式，逐步对齐 `DataFlow` 的“问题提取”+“答案提取”双流水线，并引入 `QA_Merger` 算子进行最终合并。这将是根治当前抽取不全、答案边界不清等问题的长远方案。
2.  **引入短答案提取**：配合双流水线架构，修改提示词，让 LLM 在答案提取流水线中，明确区分并输出 text-based 的 `<answer>`（如 “A”, “-5”, “x=2”）和 ID-based 的 `<solution>`（详细解析过程）。

## 5. 结论

本次修订暴露出的**严重回归缺陷**和**路径解析错误**是导致当前测试失败的直接原因，必须作为最高优先级（P0）进行修复。修复后，项目应能恢复基本的题目提取能力。

然而，与 `DataFlow` 官方流水线的深入对比揭示了当前项目在**架构设计上的脆弱性**。为了实现项目“更稳、更全、更可维护”的长期目标，强烈建议在完成 P0 修复后，立即着手 P1 优化，并积极规划向 P2 架构演进的路径。独立测试部门将持续跟进，并在下一轮交付中对上述修复和优化点的落地情况进行重点验证。

---
**引用**

[1] OpenDCAI. (2026). *DataFlow GitHub Repository*. Retrieved from https://github.com/OpenDCAI/DataFlow
[2] shcming2023. (2026). *Mineru2Questions GitHub Repository*. Retrieved from https://github.com/shcming2023/Mineru2Questions
