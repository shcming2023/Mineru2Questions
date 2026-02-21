#!/bin/bash
# API测试脚本 - 验证P0-002修复（章节预处理失败不降级）

echo "========================================="
echo "  P0-002 修复验证 - API测试方案"
echo "========================================="
echo ""

BASE_URL="http://localhost:3000"

echo "🔍 步骤1: 检查服务状态..."
curl -s -I $BASE_URL | grep "HTTP" || {
  echo "❌ 服务未运行！请先运行: ./start_server.sh"
  exit 1
}
echo "✅ 服务正常"
echo ""

echo "🔍 步骤2: 获取现有LLM配置..."
CONFIGS=$(curl -s "${BASE_URL}/api/trpc/llmConfig.list" | head -100)
echo "现有配置数量: $(echo $CONFIGS | grep -o '"id"' | wc -l)"
echo ""

echo "📝 步骤3: 创建测试用错误LLM配置..."
echo "   （故意使用无效的API地址）"
CREATE_RESULT=$(curl -s -X POST "${BASE_URL}/api/trpc/llmConfig.create" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "API测试-故意失败LLM",
    "apiUrl": "https://api.invalid-domain-for-testing.com/v1",
    "apiKey": "invalid-test-key-12345",
    "modelName": "test-model",
    "usage": "long_context",
    "contextWindow": 100000,
    "timeout": 60
  }')

echo "创建结果: $CREATE_RESULT"
echo ""

echo "========================================="
echo "⚠️  手动测试步骤:"
echo "========================================="
echo ""
echo "1. 在浏览器中访问: http://localhost:3000"
echo "2. 进入'新建任务'页面"
echo "3. 选择刚创建的 'API测试-故意失败LLM' 作为章节预处理模型"
echo "4. 上传任何PDF文件并开始处理"
echo ""
echo "✅ 预期结果（修复有效）:"
echo "   - 任务状态: 失败（failed）"
echo "   - 日志包含: '章节预处理失败，任务终止'"
echo "   - 日志不包含: '降级' 字样"
echo ""
echo "❌ 错误结果（修复无效）:"
echo "   - 任务状态: 已完成（completed）"
echo "   - 日志包含: '降级使用题目抽取阶段的章节信息'"
echo ""
echo "========================================="
echo "📋 查看任务列表:"
echo "   curl http://localhost:3000/api/trpc/task.list"
echo ""
echo "📋 查看实时日志:"
echo "   tail -f /tmp/server_manual.log | grep 'chapter'"
echo "========================================="
