# Mineru2Questions

**版本**: v1.5 (里程碑)
**状态**: 生产就绪
**定位**: 高质量题目提取引擎

---

## 项目简介

Mineru2Questions 是一个专注于从教育文本（教材、习题集、试卷）中提取高质量题目的工具。基于 [OpenDCAI/DataFlow](https://github.com/OpenDCAI/DataFlow) 官方流水线的最佳实践,采用 **ID-Only** 原则,确保提取的题目文本完整、准确、可追溯。

### 核心特性 (v1.5)

- ✅ **DataFlow 算子对齐**: 核心逻辑 (ID 回填、章节处理) 与官方算子完全对齐。
- ✅ **Markdown 图片嵌入**: 图片在文本流中以 Markdown 格式 (`![caption](path)`) 嵌入,保证了题目信息的自包含性。
- ✅ **章节标题连续性检测**: 自动检测并修正因排版噪声导致的章节归属错误问题。
- ✅ **ID-Only 原则**: LLM 只输出 ID 序列,文本通过 ID 回填,避免幻觉和改写。
- ✅ **双重容错解析**: 当 LLM 输出格式错误时,自动从严格解析切换到宽松解析模式。
- ✅ **LLM 注意力衰减检测**: 启发式检测并重试可能因上下文过长导致的提取遗漏。
- ✅ **全面的可观测性**: 保存每个处理阶段的中间日志,便于调试和追溯。

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
├── parser.ts           # ID 回填与 Markdown 格式化算子
├── extraction.ts       # 主流水线与章节处理算子
├── prompts.ts          # LLM 提示词
├── taskProcessor.ts    # 任务处理器
├── ...                 # 其他核心模块
```

---

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

创建 `.env` 文件：

```env
OPENAI_API_KEY=your_api_key_here
OPENAI_API_URL=https://api.openai.com/v1/chat/completions
OPENAI_MODEL_NAME=gpt-4
```

### 3. 准备输入数据

确保你已经使用 MinerU 解析了 PDF 文件,并生成了以下文件：

```
uploads/tasks/<task_id>/
├── content_list.json   # MinerU 解析结果
└── images/             # 图片文件夹
```

### 4. 运行提取任务

```bash
npm run dev
```

访问 `http://localhost:3000`,创建新任务并上传 `content_list.json`。

### 5. 查看结果

提取完成后,结果将保存在：

```
uploads/tasks/<task_id>/results/
├── questions.json      # JSON 格式
├── questions.md        # Markdown 格式 (图片已嵌入)
└── logs/               # 中间日志
```

---

## 路线图

### v1.5 (当前版本)

- [x] **P0: 核心算子对齐**
  - [x] 图片嵌入与文本结构对齐
  - [x] 章节标题规范化与连续性检测
- [x] **P1: 鲁棒性增强**
  - [x] 双重容错解析 (Strict/Lenient)
  - [x] LLM 注意力衰减检测
- [x] **P2: 工程优化**
  - [x] 引入单元测试脚本 (`verify_revisions.ts`)
  - [x] 依赖锁定 (`package-lock.json`)

### 后续迭代 (v1.6+)

- [ ] **按 Token 切块**: 将分块逻辑从按 `block` 数量改为按 `token` 数量,以更精确地适配不同 LLM 的上下文窗口。
- [ ] **Table 拆分逻辑优化**: 探索更精细的表格内容处理方式。
- [ ] **支持更多题型**: 扩展对填空题、判断题等的结构化提取能力。

---

## 参考文档

- [算子对齐实施记录](docs/ALIGNMENT_IMPLEMENTATION_LOG.md)
- [DataFlow 官方仓库](https://github.com/OpenDCAI/DataFlow)

---

## 许可证

MIT License
