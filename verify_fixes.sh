#!/bin/bash
# 快速验证脚本 - PRD v4.0 代码对齐修复

echo "=========================================="
echo "PRD v4.0 代码对齐修复 - 快速验证脚本"
echo "执行时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "=========================================="
echo ""

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 验证1: 检查废弃文件是否已移动
echo "【验证1】检查 chapterPreprocessV2.ts 是否已移入 archive/..."
if [ -f "archive/chapterPreprocessV2.ts" ]; then
    echo -e "${GREEN}✅ PASS${NC}: chapterPreprocessV2.ts 已在 archive/ 目录"
else
    echo -e "${RED}❌ FAIL${NC}: chapterPreprocessV2.ts 未找到"
fi

if [ -f "server/chapterPreprocessV2.ts" ]; then
    echo -e "${RED}❌ FAIL${NC}: chapterPreprocessV2.ts 仍在 server/ 目录（应已删除）"
else
    echo -e "${GREEN}✅ PASS${NC}: chapterPreprocessV2.ts 已从 server/ 删除"
fi
echo ""

# 验证2: 检查 taskProcessor.ts 是否替换导入
echo "【验证2】检查 taskProcessor.ts 的导入语句..."
if grep -q "import.*preprocessChaptersV2.*from.*chapterPreprocessV2" server/taskProcessor.ts; then
    echo -e "${RED}❌ FAIL${NC}: 仍在导入 preprocessChaptersV2"
else
    echo -e "${GREEN}✅ PASS${NC}: 未导入 preprocessChaptersV2"
fi

if grep -q "import.*preprocessChapters.*from.*chapterPreprocess" server/taskProcessor.ts; then
    echo -e "${GREEN}✅ PASS${NC}: 已导入 preprocessChapters"
else
    echo -e "${RED}❌ FAIL${NC}: 未找到 preprocessChapters 导入"
fi
echo ""

# 验证3: 检查调用是否替换
echo "【验证3】检查 taskProcessor.ts 的函数调用..."
if grep -q "preprocessChaptersV2" server/taskProcessor.ts; then
    echo -e "${RED}❌ FAIL${NC}: 仍在调用 preprocessChaptersV2"
else
    echo -e "${GREEN}✅ PASS${NC}: 未调用 preprocessChaptersV2"
fi

if grep -q "await preprocessChapters" server/taskProcessor.ts; then
    echo -e "${GREEN}✅ PASS${NC}: 已调用 preprocessChapters"
else
    echo -e "${RED}❌ FAIL${NC}: 未找到 preprocessChapters 调用"
fi
echo ""

# 验证4: 检查失败语义是否修复
echo "【验证4】检查失败语义修复..."
if grep -q "chapterResult = null" server/taskProcessor.ts; then
    echo -e "${RED}❌ FAIL${NC}: 仍然存在降级逻辑（chapterResult = null）"
else
    echo -e "${GREEN}✅ PASS${NC}: 已移除降级逻辑"
fi

if grep -q "throw new Error.*章节预处理失败" server/taskProcessor.ts; then
    echo -e "${GREEN}✅ PASS${NC}: 已改为抛出异常"
else
    echo -e "${RED}❌ FAIL${NC}: 未找到异常抛出逻辑"
fi
echo ""

# 验证5: 检查 validateChapterEntries 是否导出
echo "【验证5】检查 validateChapterEntries 是否导出..."
if grep -q "export function validateChapterEntries" server/chapterPreprocess.ts; then
    echo -e "${GREEN}✅ PASS${NC}: validateChapterEntries 已导出"
else
    echo -e "${RED}❌ FAIL${NC}: validateChapterEntries 未导出"
fi
echo ""

# 验证6: 检查 ChapterMerge fallback 策略
echo "【验证6】检查 ChapterMerge fallback 策略..."
if grep -q "PRD v4.0: 预处理结果优先" server/extraction.ts; then
    echo -e "${GREEN}✅ PASS${NC}: 已添加 PRD v4.0 注释"
else
    echo -e "${YELLOW}⚠️  WARN${NC}: 未找到 PRD v4.0 注释"
fi

# 检查 fallback 逻辑附近的代码
FALLBACK_CONTEXT=$(grep -A 2 "else if (preHasPath)" server/extraction.ts | grep -A 1 "} else {")
if echo "$FALLBACK_CONTEXT" | grep -q "preTitle"; then
    echo -e "${GREEN}✅ PASS${NC}: fallback 使用 preTitle"
else
    echo -e "${RED}❌ FAIL${NC}: fallback 未使用 preTitle"
fi
echo ""

# 验证7: 检查 chapterPreprocess.ts 的失败处理
echo "【验证7】检查 chapterPreprocess.ts 失败处理..."
if grep -q "throw new Error.*第一轮章节抽取失败" server/chapterPreprocess.ts; then
    echo -e "${GREEN}✅ PASS${NC}: 第一轮抽取失败抛出异常"
else
    echo -e "${RED}❌ FAIL${NC}: 第一轮抽取失败未抛出异常"
fi

if grep -q "throw new Error.*章节验证失败" server/chapterPreprocess.ts; then
    echo -e "${GREEN}✅ PASS${NC}: 验证失败抛出异常"
else
    echo -e "${RED}❌ FAIL${NC}: 验证失败未抛出异常"
fi
echo ""

# 验证8: TypeScript 类型检查
echo "【验证8】运行 TypeScript 类型检查..."
if npx tsc --noEmit 2>&1 | grep -q "error TS"; then
    echo -e "${RED}❌ FAIL${NC}: TypeScript 类型检查有错误"
    echo "错误详情："
    npx tsc --noEmit 2>&1 | grep "error TS" | head -5
else
    echo -e "${GREEN}✅ PASS${NC}: TypeScript 类型检查通过"
fi
echo ""

# 验证9: 服务状态检查
echo "【验证9】检查服务状态..."
if netstat -tuln 2>/dev/null | grep -q ":3000" || ss -tuln 2>/dev/null | grep -q ":3000"; then
    echo -e "${GREEN}✅ PASS${NC}: 服务已在 3000 端口运行"
else
    echo -e "${YELLOW}⚠️  WARN${NC}: 服务未在 3000 端口监听"
fi
echo ""

# 总结
echo "=========================================="
echo "验证完成！"
echo "=========================================="
echo ""
echo "下一步操作："
echo "1. 访问 http://localhost:3000 检查前端页面"
echo "2. 执行测试2：正常章节预处理流程验证"
echo "3. 执行测试3：章节预处理失败场景验证"
echo ""
echo "详细测试计划请查看: docs/验证测试计划_2026-02-21.md"
