# Mineru2Questions 算子对齐实施记录

**日期**: 2026-02-12
**参考文档**: `docs/Mineru2Questions 项目算子阶段对齐诊断报告.md`
**状态**: ✅ 已同步核心逻辑

---

## 1. 已修复的核心差异 (P0/P1)

### 1.1 图片嵌入与文本结构 (P0 #1, P1 #4)
- **文件**: `server/parser.ts`
- **原有问题**: 图片单独存储在 `images` 数组，未嵌入文本；文本用空格连接，丢失段落结构。
- **对齐方案**:
  - 实现了 Markdown 图片嵌入：`![caption](path)`
  - 文本连接符改为 `\n`，保留段落结构。
- **验证**: `scripts/verify_revisions.ts` Test 1 通过。

### 1.2 章节标题清洗与连续性检测 (P0 #2, P1 #3)
- **文件**: `server/extraction.ts`
- **原有问题**: 章节标题未规范化；缺乏题号连续性检测，导致子标题（如“基础训练”）误覆盖主章节。
- **对齐方案**:
  - 实现了 `refineTitle` 函数（对齐官方 `refine_title`），提取标准章节编号。
  - 增强了 `cleanChapterTitles`，引入**噪声回退机制**：当题号连续但标题变为噪声（如“基础训练”）时，自动回退到上一个有效章节标题。
- **验证**: `scripts/verify_revisions.ts` Test 2 通过。

### 1.3 Sanity Check 逻辑优化 (P1 #5)
- **文件**: `server/extraction.ts`
- **原有问题**: 固定阈值导致短 Chunk 误报。
- **对齐方案**: 改为比率检测 (`questions/blocks < 0.02`)，仅在 Block 数量 > 40 时触发。

## 2. 遗留/未采纳项 (P2)

- **按 Token 切块**: 目前仍按 Block 数量切块（P2 #5）。鉴于当前 Block 大小通常可控，且引入 Token 计数器会增加依赖，暂缓实施。
- **Table 拆分**: 保持按行拆分（P2 #6）。

## 3. 结论

代码库核心逻辑已与官方算子（DataFlow）对齐，解决了导致数据质量下降的主要路径问题。
