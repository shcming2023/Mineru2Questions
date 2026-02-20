import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { Eye, Download, Loader2, RotateCcw } from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const statusConfig = {
  pending: { label: "等待中", variant: "secondary" as const },
  processing: { label: "处理中", variant: "default" as const },
  completed: { label: "已完成", variant: "default" as const },
  failed: { label: "失败", variant: "destructive" as const },
  paused: { label: "已暂停", variant: "outline" as const },
};

export default function History() {
  const [, setLocation] = useLocation();
  const utils = trpc.useContext();
  const { data: tasks, isLoading } = trpc.task.list.useQuery();
  
  const retryMutation = trpc.task.retry.useMutation({
    onSuccess: () => {
      toast.success("任务重试已启动", {
        description: "已创建新的重试任务并开始执行",
      });
      utils.task.list.invalidate();
      // 可以在这里选择是否跳转到新任务详情
      // setLocation(\`/tasks/\${data.id}\`);
    },
    onError: (error) => {
      toast.error("重试失败", {
        description: error.message,
      });
    }
  });

  const handleRetry = (taskId: number) => {
    retryMutation.mutate({ id: taskId });
  };
  
  // 显示所有任务（包括处理中的，以便查看重试任务）
  // 按照需求：提供任务族系视图，清晰展示同一输入物的所有执行历史
  // 这里暂时还是列出列表，但我们应该允许用户看到所有状态的任务，或者至少是重试相关的
  const historyTasks = tasks || [];

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
                        
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="outline" size="sm">
                              <RotateCcw className="mr-1 h-4 w-4" />
                              重试
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>确认重试任务？</AlertDialogTitle>
                              <AlertDialogDescription>
                                这将创建一个新的任务记录，使用原任务的参数和最新的处理逻辑重新执行。
                                原任务记录将保留用于对比。
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>取消</AlertDialogCancel>
                              <AlertDialogAction onClick={() => handleRetry(task.id)}>
                                确认重试
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>

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
