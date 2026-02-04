import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { Eye, Download, Loader2 } from "lucide-react";
import { useLocation } from "wouter";

const statusConfig = {
  pending: { label: "等待中", variant: "secondary" as const },
  processing: { label: "处理中", variant: "default" as const },
  completed: { label: "已完成", variant: "default" as const },
  failed: { label: "失败", variant: "destructive" as const },
  paused: { label: "已暂停", variant: "outline" as const },
};

export default function History() {
  const [, setLocation] = useLocation();
  const { data: tasks, isLoading } = trpc.task.list.useQuery();
  
  // 只显示已完成和失败的任务
  const historyTasks = tasks?.filter(t => t.status === "completed" || t.status === "failed") || [];

  const formatDate = (date: Date | string) => {
    return new Date(date).toLocaleString();
  };

  const formatDuration = (start: Date | string | null, end: Date | string | null) => {
    if (!start || !end) return "--";
    const duration = new Date(end).getTime() - new Date(start).getTime();
    const minutes = Math.floor(duration / 60000);
    const seconds = Math.floor((duration % 60000) / 1000);
    return `${minutes}分${seconds}秒`;
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">历史记录</h1>
          <p className="text-muted-foreground">查看已完成的提取任务</p>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : historyTasks.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <p className="text-muted-foreground">暂无历史记录</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {historyTasks.map((task) => {
              const status = statusConfig[task.status];
              
              return (
                <Card key={task.id}>
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between">
                      <div>
                        <CardTitle className="text-lg">{task.name}</CardTitle>
                        <CardDescription>
                          完成于 {task.completedAt ? formatDate(task.completedAt) : "--"}
                        </CardDescription>
                      </div>
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-4">
                      <div className="grid grid-cols-4 gap-4 text-sm">
                        <div>
                          <p className="text-muted-foreground">处理页数</p>
                          <p className="font-medium">{task.processedPages}/{task.totalPages}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">提取题目</p>
                          <p className="font-medium">{task.extractedCount} 道</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">处理时长</p>
                          <p className="font-medium">
                            {formatDuration(task.startedAt, task.completedAt)}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">重试次数</p>
                          <p className="font-medium">{task.retryCount}</p>
                        </div>
                      </div>
                      
                      {task.errorMessage && (
                        <p className="text-sm text-destructive bg-destructive/10 p-2 rounded">
                          {task.errorMessage}
                        </p>
                      )}
                      
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setLocation(`/tasks/${task.id}`)}
                        >
                          <Eye className="mr-1 h-4 w-4" />
                          查看详情
                        </Button>
                        {task.status === "completed" && (
                          <Button variant="outline" size="sm">
                            <Download className="mr-1 h-4 w-4" />
                            下载结果
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
