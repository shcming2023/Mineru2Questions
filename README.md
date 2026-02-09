# Mineru2Questions

**版本**: v1.1  
**状态**: 生产就绪  
**定位**: 高质量题目提取引擎

---

## 项目简介

Mineru2Questions 是一个专注于从教育文本（教材、习题集、试卷）中提取高质量题目的工具。基于 [OpenDCAI/DataFlow](https://github.com/OpenDCAI/DataFlow) 官方流水线的最佳实践，采用 **ID-Only** 原则，确保提取的题目文本完整、准确、可追溯。

### 核心特性

- ✅ **高质量题目提取**: 聚焦题目提取，确保文本完整性和图片完整性
- ✅ **ID-Only 原则**: LLM 只输出 ID 序列，文本通过 ID 回填，避免幻觉和改写
- ✅ **容错回退机制**: 当 LLM 输出格式错误时，自动启动宽松解析模式
- ✅ **题目类型识别**: 自动识别例题 (example) 和练习题 (exercise)
- ✅ **近距离答案提取**: 对例题提取紧邻的解答（在 50 个 block 内）
- ✅ **中间日志记录**: 保存 LLM 原始输出和解析结果，便于调试和追溯
- ✅ **精简架构**: 单一流水线，代码简洁，易于维护

### 不支持的场景

- ❌ 远距离答案匹配（答案集中在章节末尾或书本末尾）
- ❌ 跨文档答案合并（题目和答案分别在两个文件中）
- ❌ 纯视觉题目提取（直接从图片识别题目）

---

## 技术栈

- **后端**: TypeScript + Node.js
- **数据库**: SQLite
- **LLM**: OpenAI API（或兼容的 API）
- **解析器**: MinerU（需预先运行）

---

## 项目结构

```
server/
├── _core/              # 框架核心（保持不变）
├── types.ts            # 类型定义
├── prompts.ts          # 提示词（强化图片ID连续性）
├── parser.ts           # 解析器（带容错回退）
├── extraction.ts       # 主流水线（简化版）
├── taskProcessor.ts    # 任务处理器
├── storage.ts          # 存储
├── db.ts               # 数据库
└── routers.ts          # 路由
```

---

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置环境变量

创建 `.env` 文件：

```env
OPENAI_API_KEY=your_api_key_here
OPENAI_API_URL=https://api.openai.com/v1/chat/completions
OPENAI_MODEL_NAME=gpt-4
```

### 3. 准备输入数据

确保你已经使用 MinerU 解析了 PDF 文件，并生成了以下文件：

```
uploads/tasks/<task_id>/
├── content_list.json   # MinerU 解析结果
└── images/             # 图片文件夹
    ├── page_1_img_0.jpg
    ├── page_1_img_1.jpg
    └── ...
```

### 4. 运行提取任务

```bash
pnpm dev
```

访问 `http://localhost:3000`，创建新任务并上传 `content_list.json`。

### 5. 查看结果

提取完成后，结果将保存在：

```
uploads/tasks/<task_id>/results/
├── questions.json      # JSON 格式
├── questions.md        # Markdown 格式
└── logs/               # 中间日志
    ├── chunk_0_llm_output.txt
    ├── chunk_0_parsed_questions.log
    └── ...
```

---

## 核心算子说明

### 1. 提示词（prompts.ts）

- **强化图片ID连续性**: 明确要求 LLM 包含所有连续的 block ID，尤其是图片 block
- **题目类型识别**: 要求 LLM 输出 `<type>example</type>` 或 `<type>exercise</type>`
- **ID-Only 原则**: 禁止 LLM 输出自由文本，只能输出 ID 序列

### 2. 解析器（parser.ts）

- **严格解析**: 强制执行 ID-Only 原则，任何违规输出都触发异常
- **宽松解析**: 当严格解析失败时，尝试从混乱输出中提取有用信息
- **日志记录**: 保存 LLM 原始输出和解析结果，便于调试

### 3. 主流水线（extraction.ts）

- **分块处理**: 将 content_list.json 分成多个 chunk，每个 chunk 最多 100 个 block
- **重叠窗口**: 相邻 chunk 之间有 10 个 block 的重叠，避免题目被切断
- **去重**: 基于 questionIds 去重，确保每个题目只出现一次
- **质量过滤**: 过滤空题目、过短题目、无题号题目

---

## 开发指南

### 运行测试

```bash
pnpm test
```

### 代码规范

- 使用 TypeScript 严格模式
- 添加详细的注释和类型定义
- 遵循 ID-Only 原则，不引入硬编码规则

### 调试技巧

1. 查看 `logs/` 目录下的中间日志
2. 检查 `chunk_X_llm_output.txt` 查看 LLM 原始输出
3. 检查 `chunk_X_parsed_questions.log` 查看解析结果
4. 如果解析失败，查看 `chunk_X_parse_error.log` 查看错误信息

---

## 路线图

### P0（必须立即修复）

- [x] 强化图片ID提取（已完成）
- [x] 实现容错回退策略（已完成）
- [x] 实现诊断日志（已完成）
- [ ] 优化章节标题提取（进行中）

### P1（应尽快修复）

- [ ] 题目类型识别优化
- [ ] 近距离答案提取优化

### P2（可后续迭代）

- [ ] 支持更多题型（填空题、判断题等）
- [ ] 支持多语言（英文、日文等）
- [ ] 支持自定义提示词

---

## 参考文档

- [PRD v1.1](docs/Mineru2Questions_PRD_v1.1.md)
- [评审报告](docs/Mineru2Questions_Review_Report.md)
- [重构指南](docs/REFACTORING_GUIDE.md)
- [DataFlow 官方仓库](https://github.com/OpenDCAI/DataFlow)

---

## 许可证

MIT License

---

## 联系方式

如有问题或建议，请提交 Issue 或 Pull Request。
