# 清理报告

## 1. 清理清单
| 类别 | 路径/文件名 | 操作 |
| --- | --- | --- |
| 构建产物 | dist/ | 已删除 |
| 日志 | .manus-logs/, *.log | 已删除 |
| 测试数据 | server/uploads/tasks/ | 已删除 |
| 测试脚本 | server/tests/ | 已删除 |
| 临时脚本 | scripts/ | 已删除 |
| 调试脚本 | server/scripts/ | 已删除 |
| 依赖锁文件 | package-lock.json | 已删除 |
| 迁移归档 | archive/migrations/ | 已归档 |

## 2. 删除理由
- 构建产物、日志与测试数据不进入生产仓库
- 临时脚本与历史测试不被业务代码或 CI/CD 引用
- 历史迁移脚本已完成生产部署，仅保留当前版本

## 3. 保留清单
| 类别 | 路径/文件名 | 保留理由 |
| --- | --- | --- |
| 需求文档 | Mineru2Questions_PRD_v2.0_final.md | 项目需求基准 |
| 核心配置 | package.json、pnpm-lock.yaml、drizzle.config.ts | 构建与运行依赖 |
| 数据结构 | drizzle/schema.ts | 数据库结构基准 |

## 4. 目录变更 diff
- docs/ 历史文档已按 年-月-业务域 归档并统一命名，子目录已补充 README
- drizzle/ 历史迁移与快照已迁移至 archive/migrations/

## 5. 静态分析清理
- 清理未使用导入与参数，覆盖 History/NewTask/Settings/TaskCompare/TaskDetail 等页面
- 清理未使用常量与类型，覆盖 cookies/blockFlattener/chapterPreprocess/chapterPreprocessV2/extraction/db/taskProcessor/routers

## 6. 验证结果截图
- 类型检查: pnpm run check 通过
- 单元测试: pnpm run test 通过 (4 files, 20 tests)
- 构建: pnpm run build 通过
- 静态分析: pnpm exec tsc --noEmit --noUnusedLocals --noUnusedParameters 通过
- Lint 检查: 未配置
- 镜像构建与容器启动: 未配置 (无 Dockerfile/docker-compose)

## 7. 风险点说明
- 历史迁移脚本归档后无法直接回放旧版本迁移
- 删除测试脚本将减少人工回归入口
