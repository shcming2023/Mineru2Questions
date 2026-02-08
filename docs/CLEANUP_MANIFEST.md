# 项目清理清单

**执行日期:** 2026-02-08  
**备份位置:** `/home/ubuntu/backup_20260208/`  

---

## 白名单（受保护文件）

以下文件在任何情况下都不得删除：

| 类别 | 文件 | 说明 |
|------|------|------|
| 技术文档 | `REFACTORING_GUIDE.md` | 重构指南 |
| 技术文档 | `CLEANUP_MANIFEST.md` | 清理清单（本文件） |
| 配置文件 | `package.json` | 项目依赖配置 |
| 配置文件 | `package-lock.json` | 依赖锁定文件 |
| 配置文件 | `pnpm-lock.yaml` | pnpm 依赖锁定 |
| 配置文件 | `tsconfig.json` | TypeScript 配置 |
| 配置文件 | `vite.config.ts` | Vite 构建配置 |
| 配置文件 | `vitest.config.ts` | 测试框架配置 |
| 配置文件 | `drizzle.config.ts` | 数据库迁移配置 |
| 配置文件 | `.gitignore` | Git 忽略规则 |
| 配置文件 | `.prettierrc` | 代码格式化配置 |
| 数据库 | `sqlite.db` | 运行时数据库 |
| 数据库 | `drizzle/` | 数据库迁移文件（全部保留） |
| 补丁 | `patches/wouter@3.7.1.patch` | 第三方库补丁 |
| 核心代码 | `server/extraction.ts` | 核心抽取逻辑 |
| 核心代码 | `server/taskProcessor.ts` | 任务处理器 |
| 核心代码 | `server/db.ts` | 数据库操作 |
| 核心代码 | `server/routers.ts` | API 路由 |
| 核心代码 | `server/storage.ts` | 存储模块 |
| 核心代码 | `server/strategies.ts` | 策略模式 |
| 核心代码 | `server/answerDetection.ts` | 答案检测 |
| 新模块 | `server/types.ts` | 共享类型定义 |
| 新模块 | `server/llm-output-parser.ts` | LLM 输出解析器 |
| 新模块 | `server/qa-merger.ts` | QA 合并算子 |
| 新模块 | `server/quality-gate.ts` | 质量门 |
| 新模块 | `server/pipeline.ts` | 流水线模块 |
| 新模块 | `server/prompts.ts` | 提示词模板 |
| 框架代码 | `server/_core/` | 框架核心（全部保留） |
| 客户端 | `client/` | 前端代码（除明确标记外全部保留） |
| 共享代码 | `shared/` | 共享模块（全部保留） |
| 测试任务 | `server/uploads/tasks/202602081356-*` | 最新测试数据 |

---

## 删除清单

### 1. 历史审计报告（已备份）
- `AuditReport/` — 整个目录（380K），含历史审计的 Python 参考代码和旧版 extraction.ts 副本

### 2. 旧测试样本数据（已备份）
- `Samples/` — 整个目录（6.5M），含 TestTask_20260205 的 532 张图片和 content_list.json

### 3. 根目录临时/测试文件（已备份）
- `test_convert.mjs` — 临时测试脚本
- `test_fallback.mjs` — 临时测试脚本
- `test_llm_call.mjs` — 临时测试脚本
- `test_refactoring.mjs` — 临时测试脚本
- `check_db.js` — 临时工具脚本
- `check_ports.js` — 临时工具脚本
- `seed_user.js` — 临时工具脚本

### 4. 空/无用文件
- `data.db` — 空文件（0 字节），实际数据库是 sqlite.db

### 5. 未使用的客户端文件
- `client/src/pages/ComponentShowcase.tsx` — 未在路由中注册的展示页面
- `client/src/components/ManusDialog.tsx` — 未被任何组件引用

### 6. 陈旧文档
- `todo.md` — 根目录待办事项（内容已过时，将归档到 docs/）

---

## 结构重组清单

### 移动操作
- `scripts/` → 保留（维护脚本）
- `server/uploads/tasks/` → 保留（测试数据）
- `todo.md` → `docs/archive/todo.md`（归档）

### 新建目录
- `docs/` — 项目文档
- `docs/archive/` — 归档文档

---

## 代码优化清单

### extraction.ts 重复代码标记
以下内容在 extraction.ts 中与新模块重复，标记为"待迁移"（不在本次清理中删除，保持向后兼容）：

| 重复内容 | extraction.ts 行号 | 新模块位置 |
|----------|-------------------|-----------|
| 类型定义 | L25-95 | `types.ts` |
| 提示词 | L106-260 | `prompts.ts` |
| parseLLMOutput | L539-650 | `llm-output-parser.ts` |
| mergeQAPairs | L794-930 | `qa-merger.ts` |
| normalizeTitle/Label | L660-790 | `qa-merger.ts` |

### 未使用的导出函数（标记为 @deprecated）
- `idsToText` — 仅在 extraction.ts 内部使用
- `extractImagesFromIds` — 仅在 extraction.ts 内部使用
- `cleanChapterTitle` — 仅在 extraction.ts 内部使用
- `splitMergedQuestion` — 仅在 extraction.ts 内部使用
- `getLabelKey` — 仅在 extraction.ts 内部使用
- `callVLMForImageExtraction` — 未被任何代码调用
- `isNoiseEntry` — 仅在 extraction.ts 内部使用
- `isTaskCancelled` — 未被外部代码调用
