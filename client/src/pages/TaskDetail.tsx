import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, Play, Pause, RotateCcw, Download, Loader2, FileJson, FileText, RefreshCw } from "lucide-react";
import { useLocation, useParams } from "wouter";
import { toast } from "sonner";
import { useState } from "react";
import { Streamdown } from "streamdown";

const statusConfig = {
  pending: { label: "等待中", variant: "secondary" as const },
  processing: { label: "处理中", variant: "default" as const },
  completed: { label: "已完成", variant: "default" as const },
  failed: { label: "失败", variant: "destructive" as const },
  paused: { label: "已暂停", variant: "outline" as const },
};

export default function TaskDetail() {
  const [, setLocation] = useLocation();
  const params = useParams<{ id: string }>();
  const taskId = parseInt(params.id || "0");
  const utils = trpc.useUtils();
  
  const [previewFormat, setPreviewFormat] = useState<"json" | "markdown">("json");
  
  const { data: task, isLoading, refetch } = trpc.task.get.useQuery(
    { id: taskId },
    { 
      enabled: taskId > 0,
      refetchInterval: (query) => {
        return query.state.data?.status === "processing" ? 3000 : false;
      }
    }
  );
  
  const { data: pageLogs } = trpc.task.getPageLogs.useQuery(
    { taskId },
    { enabled: taskId > 0 }
  );
  
  const { data: downloadLinks } = trpc.result.getDownloadLinks.useQuery(
    { taskId },
    { enabled: task?.status === "completed" }
  );
  
  const { data: resultContent, isLoading: isLoadingContent } = trpc.result.getContent.useQuery(
    { taskId, format: previewFormat },
    { enabled: task?.status === "completed" }
  );
  
  const startMutation = trpc.task.start.useMutation({
    onSuccess: () => {
      toast.success("任务已开始");
      utils.task.get.invalidate({ id: taskId });
    },
    onError: (error) => toast.error(error.message),
  });
  
  const pauseMutation = trpc.task.pause.useMutation({
    onSuccess: () => {
      toast.success("任务已暂停");
      utils.task.get.invalidate({ id: taskId });
    },
    onError: (error) => toast.error(error.message),
  });
  
  const retryMutation = trpc.task.retry.useMutation({
    onSuccess: () => {
      toast.success("任务已重置");
      utils.task.get.invalidate({ id: taskId });
    },
    onError: (error) => toast.error(error.message),
  });

  const formatTime = (seconds: number | null | undefined) => {
    if (!seconds) return "--";
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}分${secs}秒`;
  };

  const formatDate = (date: Date | string | null | undefined) => {
    if (!date) return "--";
    return new Date(date).toLocaleString();
  };

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    );
  }

  if (!task) {
    return (
      <DashboardLayout>
        <div className="flex flex-col items-center justify-center py-12">
          <p className="text-muted-foreground mb-4">任务不存在</p>
          <Button onClick={() => setLocation("/tasks")}>返回任务列表</Button>
        </div>
      </DashboardLayout>
    );
  }

  const status = statusConfig[task.status];
  const progress = task.totalPages > 0 ? (task.processedPages / task.totalPages) * 100 : 0;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* 头部 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => setLocation("/tasks")}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold tracking-tight">{task.name}</h1>
                <Badge variant={status.variant}>{status.label}</Badge>
              </div>
              <p className="text-muted-foreground">创建于 {formatDate(task.createdAt)}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="mr-1 h-4 w-4" />
              刷新
            </Button>
            {(task.status === "pending" || task.status === "paused") && (
              <Button size="sm" onClick={() => startMutation.mutate({ id: taskId })}>
                <Play className="mr-1 h-4 w-4" />
                开始
              </Button>
            )}
            {task.status === "processing" && (
              <Button variant="outline" size="sm" onClick={() => pauseMutation.mutate({ id: taskId })}>
                <Pause className="mr-1 h-4 w-4" />
                暂停
              </Button>
            )}
            {task.status === "failed" && (
              <Button variant="outline" size="sm" onClick={() => retryMutation.mutate({ id: taskId })}>
                <RotateCcw className="mr-1 h-4 w-4" />
                重试
              </Button>
            )}
          </div>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          {/* 进度卡片 */}
          <Card>
            <CardHeader>
              <CardTitle>处理进度</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>已处理: {task.processedPages}/{task.totalPages} 页</span>
                  <span>{progress.toFixed(1)}%</span>
                </div>
                <Progress value={progress} className="h-3" />
              </div>
              
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground">当前页面</p>
                  <p className="font-medium">{task.currentPage || "--"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">预计剩余时间</p>
                  <p className="font-medium">{formatTime(task.estimatedTimeRemaining)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">开始时间</p>
                  <p className="font-medium">{formatDate(task.startedAt)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">完成时间</p>
                  <p className="font-medium">{formatDate(task.completedAt)}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* 统计卡片 */}
          <Card>
            <CardHeader>
              <CardTitle>提取统计</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 bg-muted/50 rounded-lg text-center">
                  <p className="text-3xl font-bold text-primary">{task.extractedCount}</p>
                  <p className="text-sm text-muted-foreground">提取题目数</p>
                </div>
                <div className="p-4 bg-muted/50 rounded-lg text-center">
                  <p className="text-3xl font-bold">{task.retryCount}</p>
                  <p className="text-sm text-muted-foreground">重试次数</p>
                </div>
              </div>
              
              {task.errorMessage && (
                <div className="p-3 bg-destructive/10 text-destructive rounded-lg text-sm">
                  <p className="font-medium">错误信息:</p>
                  <p>{task.errorMessage}</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* 结果预览和下载 */}
        {task.status === "completed" && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>提取结果</CardTitle>
                  <CardDescription>预览和下载提取的题目</CardDescription>
                </div>
                {downloadLinks && (
                  <div className="flex gap-2">
                    {downloadLinks.links.map((link) => (
                      <Button
                        key={link.type}
                        variant="outline"
                        size="sm"
                        asChild
                      >
                        <a href={link.url} download={link.name}>
                          <Download className="mr-1 h-4 w-4" />
                          {link.type === "json" ? "JSON" : "Markdown"}
                        </a>
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <Tabs value={previewFormat} onValueChange={(v) => setPreviewFormat(v as "json" | "markdown")}>
                <TabsList>
                  <TabsTrigger value="json">
                    <FileJson className="mr-1 h-4 w-4" />
                    JSON格式
                  </TabsTrigger>
                  <TabsTrigger value="markdown">
                    <FileText className="mr-1 h-4 w-4" />
                    Markdown格式
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="json" className="mt-4">
                  <ScrollArea className="h-96 w-full rounded-md border p-4">
                    {isLoadingContent ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 className="h-6 w-6 animate-spin" />
                      </div>
                    ) : (
                      <pre className="text-sm whitespace-pre-wrap">{resultContent?.content || "暂无内容"}</pre>
                    )}
                  </ScrollArea>
                </TabsContent>
                <TabsContent value="markdown" className="mt-4">
                  <ScrollArea className="h-96 w-full rounded-md border p-4">
                    {isLoadingContent ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 className="h-6 w-6 animate-spin" />
                      </div>
                    ) : (
                      <div className="prose prose-sm max-w-none dark:prose-invert">
                        <Streamdown>{resultContent?.content || "暂无内容"}</Streamdown>
                      </div>
                    )}
                  </ScrollArea>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        )}

        {/* 页面处理日志 */}
        <Card>
          <CardHeader>
            <CardTitle>处理日志</CardTitle>
            <CardDescription>每个页面的处理状态</CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-64">
              {pageLogs && pageLogs.length > 0 ? (
                <div className="space-y-2">
                  {pageLogs.map((log) => (
                    <div
                      key={log.id}
                      className="flex items-center justify-between p-2 rounded-lg bg-muted/30"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-medium">第 {log.pageIndex + 1} 页</span>
                        <Badge
                          variant={
                            log.status === "completed"
                              ? "default"
                              : log.status === "failed"
                              ? "destructive"
                              : log.status === "processing"
                              ? "default"
                              : "secondary"
                          }
                          className="text-xs"
                        >
                          {log.status === "completed"
                            ? "已完成"
                            : log.status === "failed"
                            ? "失败"
                            : log.status === "processing"
                            ? "处理中"
                            : "等待中"}
                        </Badge>
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {log.processingTime ? `${(log.processingTime / 1000).toFixed(1)}秒` : "--"}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-center text-muted-foreground py-8">暂无处理日志</p>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
