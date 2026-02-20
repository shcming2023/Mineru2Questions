import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { Plus, FileText, CheckCircle, Clock, AlertCircle, ArrowRight, Settings } from "lucide-react";
import { useLocation } from "wouter";

export default function Home() {
  const [, setLocation] = useLocation();
  const { data: tasks } = trpc.task.list.useQuery();
  const { data: configs } = trpc.llmConfig.list.useQuery();
  
  // 统计数据
  const stats = {
    total: tasks?.length || 0,
    completed: tasks?.filter(t => t.status === "completed").length || 0,
    processing: tasks?.filter(t => t.status === "processing").length || 0,
    failed: tasks?.filter(t => t.status === "failed").length || 0,
    totalQuestions: tasks?.reduce((sum, t) => sum + t.extractedCount, 0) || 0,
  };
  
  // 最近任务
  const recentTasks = tasks?.slice(0, 5) || [];
  
  // 是否有配置
  const hasConfig = configs && configs.length > 0;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Mineru2Questions</h1>
          <p className="text-muted-foreground">
            从MinerU解析的教育文档中自动提取题目（支持数学、语文、理化等多学科）
          </p>
        </div>

        {/* 快速操作 */}
        {!hasConfig && (
          <Card className="border-yellow-200 bg-yellow-50">
            <CardContent className="flex items-center justify-between py-4">
              <div className="flex items-center gap-3">
                <AlertCircle className="h-5 w-5 text-yellow-600" />
                <div>
                  <p className="font-medium text-yellow-800">请先配置LLM API</p>
                  <p className="text-sm text-yellow-600">需要配置视觉语言模型API才能开始提取题目</p>
                </div>
              </div>
              <Button onClick={() => setLocation("/settings")}>
                <Settings className="mr-2 h-4 w-4" />
                去配置
              </Button>
            </CardContent>
          </Card>
        )}

        {/* 统计卡片 */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">总任务数</CardTitle>
              <FileText className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.total}</div>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">已完成</CardTitle>
              <CheckCircle className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">{stats.completed}</div>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">处理中</CardTitle>
              <Clock className="h-4 w-4 text-blue-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-blue-600">{stats.processing}</div>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">提取题目总数</CardTitle>
              <FileText className="h-4 w-4 text-primary" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-primary">{stats.totalQuestions}</div>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          {/* 快速开始 */}
          <Card>
            <CardHeader>
              <CardTitle>快速开始</CardTitle>
              <CardDescription>创建新的题目提取任务</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                上传MinerU解析的教材文件夹,系统将自动识别并提取其中的数学题目。
              </p>
              <div className="space-y-2 text-sm">
                <p className="font-medium">支持的文件结构:</p>
                <ul className="list-disc list-inside text-muted-foreground space-y-1">
                  <li>content_list.json - MinerU解析的内容列表</li>
                  <li>*.md - Markdown格式的文档内容</li>
                  <li>images/ - 提取的图片文件夹</li>
                </ul>
              </div>
              <Button 
                className="w-full" 
                onClick={() => setLocation("/tasks/new")}
                disabled={!hasConfig}
              >
                <Plus className="mr-2 h-4 w-4" />
                新建提取任务
              </Button>
            </CardContent>
          </Card>

          {/* 最近任务 */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>最近任务</CardTitle>
                  <CardDescription>查看最近的提取任务</CardDescription>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setLocation("/tasks")}>
                  查看全部
                  <ArrowRight className="ml-1 h-4 w-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {recentTasks.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">暂无任务</p>
              ) : (
                <div className="space-y-3">
                  {recentTasks.map((task) => (
                    <div
                      key={task.id}
                      className="flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted cursor-pointer transition-colors"
                      onClick={() => setLocation(`/tasks/${task.id}`)}
                    >
                      <div className="space-y-1">
                        <p className="font-medium text-sm">{task.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {task.extractedCount} 道题目 · {task.processedPages}/{task.totalPages} 页
                        </p>
                      </div>
                      <div className={`text-xs px-2 py-1 rounded ${
                        task.status === "completed" ? "bg-green-100 text-green-700" :
                        task.status === "processing" ? "bg-blue-100 text-blue-700" :
                        task.status === "failed" ? "bg-red-100 text-red-700" :
                        task.status === "paused" ? "bg-yellow-100 text-yellow-700" :
                        "bg-gray-100 text-gray-700"
                      }`}>
                        {task.status === "completed" ? "已完成" :
                         task.status === "processing" ? "处理中" :
                         task.status === "failed" ? "失败" :
                         task.status === "paused" ? "已暂停" : "等待中"}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* 使用说明 */}
        <Card>
          <CardHeader>
            <CardTitle>使用说明</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-6 md:grid-cols-3">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold">1</div>
                  <h3 className="font-medium">配置API</h3>
                </div>
                <p className="text-sm text-muted-foreground pl-10">
                  在设置页面配置支持视觉理解的LLM API(如GPT-4o、Claude等)
                </p>
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold">2</div>
                  <h3 className="font-medium">上传文件</h3>
                </div>
                <p className="text-sm text-muted-foreground pl-10">
                  上传MinerU解析后的教材文件夹,包含markdown和图片
                </p>
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold">3</div>
                  <h3 className="font-medium">获取结果</h3>
                </div>
                <p className="text-sm text-muted-foreground pl-10">
                  系统自动提取题目,支持JSON和Markdown格式下载
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
