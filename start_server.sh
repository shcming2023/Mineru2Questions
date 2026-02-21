#!/bin/bash
cd /home/home_dev/workspace/9.Mineru2Questions

# 清理旧进程
pkill -9 -f "tsx.*server/_core"

# 等待端口释放
sleep 2

# 启动服务
NODE_ENV=development \
NODE_OPTIONS='--max-old-space-size=4096' \
nohup ./node_modules/.bin/tsx server/_core/index.ts > /tmp/server_manual.log 2>&1 &

echo "服务启动中..."
sleep 5

# 检查服务状态
if lsof -i :3000 > /dev/null 2>&1; then
  echo "✅ 服务已成功启动在端口 3000"
  echo "📊 访问地址: http://localhost:3000"
  tail -20 /tmp/server_manual.log
else
  echo "❌ 服务启动失败，查看日志:"
  tail -30 /tmp/server_manual.log
fi
