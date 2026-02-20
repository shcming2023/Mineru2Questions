Mineru2Questions 回归测试与最终评审报告 (Commit: 041185b)
您好,已完成对最新 commit 041185b 的回归测试与最终评审。结论是: 本次修订成功修复了所有 P0 和 P1 级别的核心问题,代码实现质量高,与 DataFlow 官方算子的关键逻辑已对齐。
1. 验证范围与结果
代码审查: 已审查 server/parser.ts 和 server/extraction.ts 的变更。
单元测试: 已在本地环境成功运行 scripts/verify_revisions.ts 脚本。
修复项
状态
测试结果
P0: 图片嵌入与文本结构
✅ 已修复
verify_revisions.ts Test 1 通过。图片已正确嵌入为 Markdown 格式,文本块以换行符拼接,保留了段落结构。
P1: 章节标题规范化与连续性
✅ 已修复
verify_revisions.ts Test 2 通过。cleanChapterTitles 实现了题号连续性检测与噪声回退,refineTitle 实现了章节编号提取,逻辑正确。
P2: Sanity Check 优化
✅ 已优化
检查逻辑已从固定阈值改为比率检测,增强了鲁棒性。
2. 核心代码实现质量评估
a. parser.ts (ID 回填)
TypeScript
// server/parser.ts L336-L351

if (block.type === 'image' && block.img_path) {
  const imagePath = path.join(this.imagePrefix, block.img_path);
  images.push(imagePath);
  
  // [修复] 将图片以 Markdown 格式嵌入文本流
  const caption = block.image_caption || 'image';
  textParts.push(`![${caption}](${imagePath})`);
} else if (block.text) {
  textParts.push(block.text);
}

// ...

return {
  // [修复] 使用换行符分隔,保留段落结构
  text: textParts.join('\n').trim(),
  images
};
评价: 优秀。实现完全对齐官方算子逻辑,通过将图片作为 Markdown 嵌入,确保了 question 字段的自包含性和完整性。同时,改用换行符拼接保留了原始文本的段落结构,提升了可读性。
b. extraction.ts (章节处理)
TypeScript
// server/extraction.ts L584-L651

// Pass 1: 题号连续性检测
for (let i = 0; i < questions.length; i++) {
  // ...
  if (isConsecutive && lastValidTitle && q.chapter_title && q.chapter_title !== lastValidTitle) {
    if (isNoiseTitle) {
      q.chapter_title = lastValidTitle; // 回退到上一个有效标题
    }
  }
  // ...
}

// Pass 2: 标题规范化与黑名单过滤
return questions.map(q => {
  let title = q.chapter_title || "";
  title = refineTitle(title); // 对齐官方 refine_title
  // ...
});
评价: 优秀。采用两遍处理(Two-pass)的策略非常清晰且健壮。第一遍处理上下文相关的连续性,第二遍处理单点规范化,逻辑解耦,易于维护。refineTitle 的实现也准确复刻了官方算子的核心逻辑,确保了章节标题的标准化。
3. 最终结论
本次修订质量很高,不仅完全解决了上次评审中发现的核心问题,而且实现方式清晰、健壮,并附有单元测试脚本,展现了优秀的工程实践。
项目当前状态: 批准通过 (Approved)。核心抽取流水线已与 DataFlow 官方最佳实践保持高度一致,可以作为后续批量处理的稳定基线。
4. 后续建议
执行一次完整的端到端测试: 建议使用一份新的、未经处理的 PDF 文档,运行完整的提取流程,并人工抽查最终生成的 questions.json 文件,以确保所有环节集成后表现符合预期。
归档验证脚本: scripts/verify_revisions.ts 脚本价值很高,建议保留并在未来进行功能迭代时持续更新,作为回归测试的重要保障。
P2 优化项: 关于“按 Token 切块”和“Table 拆分逻辑”的 P2 级优化,可在当前稳定版本的基础上,作为未来的迭代方向进行规划。
感谢您的迅速修订。项目组的快速响应和高质量的修订工作。项目修订。本次评审结束。