# Mineru2Questions 性能排查报告 (v1.5)

**致**：项目总设计师与技术总监
**发件人**：Manus AI (独立测试部门)
**日期**：2026年02月09日
**主题**：关于 LLM 调用性能瓶颈的排查结论与优化建议

## 1. 评审摘要 (Executive Summary)

本次评审旨在响应您关于“题目提取过程缓慢”的疑虑，核心任务是排查性能瓶颈，并与 `OpenDCAI/DataFlow` 官方仓库及项目历史成功版本进行对比分析。

**排查结论非常明确：您关于“串行执行”的判断是完全正确的。**

当前版本的代码 (`6517d92`) 在对内容块 (chunks) 进行 LLM 调用时，采用了**完全串行**的 `for...of` 循环，导致每次只能处理一个 chunk，必须等待其完成后才能开始下一个。这与历史成功版本以及 DataFlow 官方仓库所采用的**并行处理**机制形成了鲜明对比，是造成当前性能低下的直接原因。这是一个在 v1.1 版本重构中引入的**严重性能回归**。

本报告将详细对比三个版本的实现差异，量化性能影响，并提供一个直接、可落地的代码修复建议，以恢复并优化并发处理能力。

## 2. 性能瓶颈根因：从并行到串行的回归

通过对代码库的深入分析，我们清晰地看到了处理逻辑的演变，以及性能是如何退化的。

### 2.1. 当前实现：完全串行 (Commit `6517d92`)

在 `server/extraction.ts` 的核心函数 `extractQuestions` 中，处理 chunks 的逻辑如下：

```typescript
// 文件: server/extraction.ts (line 124)

for (const chunk of chunks) {
  // ... 更新进度
  try {
    // 核心问题：await 在循环内部，导致串行执行
    const llmOutput = await callLLM(chunk.blocks, llmConfig, ...);
    // ... 后续处理
  } catch (error: any) {
    // ...
  }
}
```

这种 `for...await` 的模式确保了代码的简单性和顺序性，但也完全牺牲了 I/O 密集型任务（如网络 API 调用）的并行能力。每个 `callLLM` 都必须等待上一个请求完成，这使得总耗时约等于**所有 chunk 处理时间的总和**。

### 2.2. 历史成功版本：手动并发池 (Commit `d345d6d`)

形成鲜明对比的是，在历史上能够高效处理任务的版本中，`server/taskProcessor.ts` 实现了一个相当完善的手动并发池，用于控制并发请求的数量。

```typescript
// 文件: server/taskProcessor.ts (旧版, line 373, 424, 449)

const maxConcurrency = ctx.config.maxWorkers || 5;
const activePromises: Set<Promise<ChunkResult>> = new Set();

for (let i = 0; i < allChunks.length; i++) {
  // ...
  const taskPromise = processChunkWithResult(ctx, chunk, index, mode); // 创建 Promise，不 await
  activePromises.add(taskPromise);

  taskPromise.then(result => {
    activePromises.delete(taskPromise); // 任务完成，移出并发池
    // ...
  });

  // 如果并发池已满，则等待其中任意一个任务完成
  if (activePromises.size >= maxConcurrency) {
    await Promise.race(activePromises);
  }
}

// 等待所有剩余任务完成
await Promise.all(activePromises);
```

此前的实现通过 `Promise.race` 和一个 `Set` 来动态管理并发请求，确保同时进行的 API 调用数量不超过 `maxConcurrency`（数据库中配置为 5 或 8）。这是一种高效的 I/O 并发处理模式。

### 2.3. DataFlow 官方仓库：标准线程池

`OpenDCAI/DataFlow` 官方仓库作为我们的对齐标准，其在 Python 中使用了标准的并发处理库 `concurrent.futures.ThreadPoolExecutor`。

```python
# 文件: dataflow/serving/api_vlm_serving_openai.py (line 204)

with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
    futures = {
        executor.submit(self.chat_with_one_image_with_id, ...): idx
        for idx, (path, prompt) in enumerate(zip(image_paths, prompts))
    }
    for future in tqdm(as_completed(futures), ...):
        idx, res = future.result()
        responses[idx] = res
```

这进一步证实了**对于此类批处理任务，采用并行处理是业界标准和最佳实践**。官方实现中的 `max_workers` 默认值为 10，在具体算子中甚至配置为 20，显示出其对高并发处理的倾向。

## 3. 性能影响量化分析

下表清晰地展示了串行与并行处理在性能上的巨大差异。

| 实现版本 | 并发机制 | 并发数 (`maxWorkers`) | 16个Chunk任务预估耗时 | 性能对比 |
| :--- | :--- | :--- | :--- | :--- |
| **当前版本 (`6517d92`)** | **串行 `for...await`** | **1** | **~15 分钟** | **基线 (最慢)** |
| 历史版本 (`d345d6d`) | 手动并发池 (`Promise.race`) | 8 | ~2 分钟 | 快约 8 倍 |
| DataFlow 官方 | `ThreadPoolExecutor` | 10-20 | < 2 分钟 | 快 8-16 倍 |

*注：预估耗时基于历史成功任务（任务23）的数据：16个chunks耗时约14.5分钟，平均每个chunk处理约54秒。并行耗时约等于 `(总chunks / 并发数) * 平均单chunk耗时`。*

**结论是，当前版本的串行实现导致的处理速度，相比于历史版本和官方实现，慢了近一个数量级。**

## 4. 修复与优化建议

为了恢复系统性能，必须重新引入并行处理机制。我们建议采用比旧版 `Promise.race` 手动管理更简洁、更现代的 `Promise.all` 或 `Promise.allSettled` 方案。

### 4.1. 核心修复：使用 `Promise.all` 并行处理

修改 `server/extraction.ts` 中的 `extractQuestions` 函数，将 `for...of` 循环替换为 `Promise.all`。

```typescript
// 文件: server/extraction.ts
// 替换 line 124-174 的 for 循环

// 3. 并行调用 LLM 提取题目
console.log(`Step 3: Extracting questions via LLM with up to ${llmConfig.maxWorkers || 5} parallel workers...`);

const chunkPromises = chunks.map(async (chunk) => {
  const progressMsg = `Processing chunk ${chunk.index + 1}/${chunks.length}...`;
  console.log(progressMsg);
  // 注意：onProgress 在并行模式下可能需要更复杂的处理，此处暂时简化
  // if (onProgress) await onProgress(..., progressMsg);

  try {
    const llmOutput = await callLLM(chunk.blocks, llmConfig, { taskDir, chunkIndex: chunk.index });

    // 保存 LLM 原始输出
    const logDir = path.join(taskDir, 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    fs.writeFileSync(
      path.join(logDir, `chunk_${chunk.index}_llm_output.txt`),
      llmOutput,
      'utf-8'
    );

    // 解析
    const parser = new QuestionParser(chunk.blocks, imagesFolder, logDir);
    const questions = parser.parseWithFallback(llmOutput, chunk.index);
    console.log(`Chunk ${chunk.index}: Extracted ${questions.length} questions`);
    return { status: 'fulfilled', value: questions, chunkIndex: chunk.index };

  } catch (error: any) {
    console.error(`Chunk ${chunk.index}: Failed to process: ${error.message}`);
    // 保存错误日志
    const logDir = path.join(taskDir, 'logs');
    // ... (此处省略了 catch 块中的日志写入逻辑，应保持不变)
    return { status: 'rejected', reason: error, chunkIndex: chunk.index };
  }
});

const results = await Promise.all(chunkPromises);

const allQuestions: ExtractedQuestion[] = [];
for (const result of results) {
  if (result.status === 'fulfilled') {
    allQuestions.push(...result.value);
  }
}
```

**注意**：上述代码会一次性发起所有 chunk 的请求。如果 chunk 数量非常大（例如超过 50），可能会瞬间耗尽网络或目标服务器资源。为了实现类似旧版和 DataFlow 的**并发数控制**，我们需要引入一个并发限制器。

### 4.2. 进阶优化：带并发数控制的并行处理

我们可以创建一个简单的 `p-limit` 风格的并发控制器，或者直接使用成熟的库如 `p-limit`。这里提供一个原生实现，以便于理解和集成。

**步骤 1: 在 `taskProcessor.ts` 中传递 `maxWorkers`**

```typescript
// 文件: server/taskProcessor.ts (line 81 附近)

const config: LLMConfig = {
  apiUrl: llmConfig.apiUrl,
  apiKey: llmConfig.apiKey,
  modelName: llmConfig.modelName,
  timeout: (llmConfig.timeout || 60) * 1000,
  maxRetries: 3,
  maxWorkers: llmConfig.maxWorkers || 5 // 传递并发数
};
```

**步骤 2: 在 `extraction.ts` 中实现并发控制**

```typescript
// 文件: server/extraction.ts (替换 line 124-174)

// 3. 并行调用 LLM 提取题目（带并发控制）
const maxConcurrency = llmConfig.maxWorkers || 5;
console.log(`Step 3: Extracting questions via LLM with up to ${maxConcurrency} parallel workers...`);

const allQuestions: ExtractedQuestion[] = [];
const activePromises: Promise<any>[] = [];
let chunkIndex = 0;

for (const chunk of chunks) {
  const promise = (async () => {
    // ... (此处是单个 chunk 的 try/catch 处理逻辑，与 4.1 中 chunkPromises.map 的回调函数内容相同)
    // 返回解析后的 questions 数组或在失败时返回空数组
    try {
      // ... (callLLM, parse, etc.)
      return questions;
    } catch (error) {
      // ... (error logging)
      return []; // 返回空数组以避免 Promise.all 失败
    }
  })();

  activePromises.push(promise);

  promise.then(extracted => {
    allQuestions.push(...extracted);
    // 从 activePromises 中移除已完成的 promise
    activePromises.splice(activePromises.indexOf(promise), 1);
  });

  if (activePromises.length >= maxConcurrency) {
    await Promise.race(activePromises);
  }
}

// 等待所有剩余的任务
await Promise.all(activePromises);
```

这个实现基本复刻了旧版 `taskProcessor.ts` 中稳定高效的并发控制逻辑，是**我们最推荐的修复方案**。

## 5. 结论

当前性能问题是由于 v1.1 重构时，将旧版 `taskProcessor.ts` 中成熟的并发控制逻辑意外移除，退化为 `extraction.ts` 中的串行循环所致。这是一个严重的性能回归。

我们强烈建议采纳 **4.2 进阶优化**方案，在 `extraction.ts` 中重新实现基于 `Promise.race` 的并发池，并从数据库配置中读取 `maxWorkers`，以恢复系统原有的高效处理能力。
