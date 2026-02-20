# Mineru2Questions 集成修复报告

## 任务概览
本任务旨在解决 "Mineru2Questions 集成评审报告 (Commit_7501388)" 中指出的关键问题，重点增强系统的鲁棒性、可配置性和用户体验。

## 修复内容

### 1. 模型能力筛选 (Model Capability Filtering)
**问题**: 用户可能选择上下文窗口过小的模型进行长文本章节预处理，导致任务静默失败或截断。
**解决方案**:
- **全栈 Context Window 支持**:
  - `shared/llm-presets.ts`: 为预设模型添加 `contextWindow` 属性。
  - `drizzle/schema.ts`: 数据库 `llm_configs` 表新增 `contextWindow` 字段。
  - `server/routers.ts`: API 输入验证增加 `contextWindow` 字段支持。
  - `client/src/pages/Settings.tsx`: 设置页面新增上下文窗口配置项，并支持从预设自动填充。
- **预检逻辑**:
  - `server/chapterPreprocess.ts`: 在调用 LLM 前估算文档 token 数，若超过配置的 `contextWindow` (80% 阈值) 则立即抛出错误。
- **前端过滤**:
  - `client/src/pages/NewTask.tsx`: 在创建任务页面，"章节预处理" 选项仅展示 `long_context` 或 `general` 用途的模型，并显示上下文窗口大小提示。

### 2. 失败终止 (Failure Termination)
**问题**: 章节预处理失败后，系统仅记录警告并降级执行，导致后续步骤质量受损且难以排查。
**解决方案**:
- `server/taskProcessor.ts`: 修改错误处理逻辑。当章节预处理抛出异常（如上下文超限、API 错误）时，不再吞没错误，而是记录 Error 级日志并将任务状态置为 `failed`，立即终止流水线。

### 3. 日志展示 (Log Display)
**问题**: 缺乏详细的执行日志。
**解决方案**:
- 利用现有的 `logTaskProgress` 机制，配合 `taskProcessor.ts` 的 `failed` 状态更新，确保前端能清晰看到错误原因（如 "文档内容过长...超出模型上下文限制"）。

## 验证与测试
- **代码审查**: 确认所有修改均遵循 TypeScript 类型安全，且与现有架构保持一致。
- **逻辑验证**:
  - 新建配置时，`contextWindow` 会被正确保存。
  - 创建任务时，非长文本模型已被过滤。
  - 任务执行时，若文档过长，`chapterPreprocess` 会抛出异常，`taskProcessor` 会捕获并终止任务。

## 部署说明 (重要)

由于本次修改涉及数据库 Schema 变更（新增 `contextWindow` 字段），请务必执行以下数据库迁移命令：

```bash
npm run db:push
# 或者
npx drizzle-kit generate
npx drizzle-kit migrate
```

## 后续建议
- 建议用户在 "设置" 页面重新保存一下现有的 LLM 配置，以确保 `contextWindow` 字段被正确初始化（旧数据默认值为 128000）。
