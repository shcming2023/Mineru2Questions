# 清理报告 (Cleanup Report)
**日期:** 2026-02-09

## 1. 概览
本次清理旨在优化项目结构，移除冗余文件和废弃代码，同时确保保留所有重要数据和测试用例。项目已通过构建和测试验证。

## 2. 已删除文件
以下文件已被永久删除：

| 类别 | 路径/文件名 | 原因 |
|---|---|---|
| **备份** | `_backup_20260208/` | 之前的备份目录，不再需要 |
| **日志** | `server/logs/*.txt` | 运行时产生的临时日志文件 |
| **文档** | `docs/archive/` | 归档的旧文档和TODO列表 |
| **文档** | `docs/CODE_AUDIT_REPORT_20260208.md` | 过期的审计报告 |
| **文档** | `docs/CLEANUP_MANIFEST.md` | 旧的清理清单 |
| **配置** | `package-lock.json` | 冗余文件 (项目使用 `pnpm`, 已保留 `pnpm-lock.yaml`) |

## 3. 代码清理与重构
### 3.1 提示词 (Prompts) 重构
- **文件:** `server/prompts.ts`, `server/extraction.ts`, `server/taskProcessor.ts`
- **操作:**
    - 移除了 `server/extraction.ts` 中重复定义的 `QA_EXTRACT_PROMPT` 和 `VQA_EXTRACT_PROMPT` 常量。
    - 统一将提示词集中管理在 `server/prompts.ts`。
    - 移除了 `server/prompts.ts` 中废弃的 `getQAExtractPrompt` 函数 (及相关的 v1 版本逻辑)。
    - 更新了 `server/taskProcessor.ts` 以从正确的位置导入提示词。

### 3.2 依赖清理
- 执行了 `pnpm prune` 清理 `node_modules` 中的未引用包。

## 4. 保留数据 (供手工审查)
以下目录包含测试数据或运行时数据，已予以**保留**：

- **`server/uploads/`**: 包含上传的任务文件和历史记录 (`tasks/`, `taskshistory/`).
- **`server/*.test.ts`**: 所有单元测试文件。
- **`patches/`**: 包含 `wouter@3.7.1.patch`，在 `package.json` 中有引用。

## 5. 验证结果
- **构建检查 (`pnpm run check`):** ✅ 通过
- **项目构建 (`pnpm run build`):** ✅ 通过
- **单元测试 (`pnpm run test`):** ✅ 通过 (5 test files, 38 tests passed)

## 6. 后续建议
- 建议定期检查 `server/uploads/` 并归档过旧的任务数据。
- `server/logs/` 目录可配置自动轮转或定期清理策略。
