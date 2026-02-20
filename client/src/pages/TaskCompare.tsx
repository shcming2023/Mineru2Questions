import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, Loader2, FileText, Cpu, Clock, Split, GitCompare } from "lucide-react";
import { useLocation } from "wouter";
import { Streamdown } from "streamdown";
import { useState, useMemo } from "react";
import * as Diff from "diff";

export default function TaskCompare() {
  const [, setLocation] = useLocation();
  const searchParams = new URLSearchParams(window.location.search);
  const ids = searchParams.get("ids")?.split(",").map(Number).filter(id => !isNaN(id)) || [];
  const [viewMode, setViewMode] = useState<"split" | "diff">("split");

  if (ids.length < 2) {
     return (
        <DashboardLayout>
           <div className="flex flex-col items-center justify-center py-12">
              <p className="text-muted-foreground mb-4">需要至少两个任务进行对比</p>
              <Button onClick={() => setLocation("/tasks")}>返回任务列表</Button>
           </div>
        </DashboardLayout>
     );
  }

  const id1 = ids[0];
  const id2 = ids[1];

  // Fetch data for both tasks
  const { data: task1, isLoading: isLoading1 } = trpc.task.get.useQuery({ id: id1 });
  const { data: task2, isLoading: isLoading2 } = trpc.task.get.useQuery({ id: id2 });
  
  const { data: content1, isLoading: isLoadingContent1 } = trpc.result.getContent.useQuery(
    { taskId: id1, format: "markdown" },
    { enabled: !!task1 && task1.status === "completed" }
  );

  const { data: content2, isLoading: isLoadingContent2 } = trpc.result.getContent.useQuery(
    { taskId: id2, format: "markdown" },
    { enabled: !!task2 && task2.status === "completed" }
  );

  const isLoading = isLoading1 || isLoading2 || isLoadingContent1 || isLoadingContent2;

  // Calculate diff
  const diff = useMemo(() => {
    if (!content1?.content || !content2?.content) return null;
    return Diff.diffLines(content1.content, content2.content);
  }, [content1, content2]);

  return (
    <DashboardLayout>
       <div className="space-y-6 h-[calc(100vh-4rem)] flex flex-col">
          <div className="flex items-center justify-between flex-none">
             <div className="flex items-center gap-4">
                <Button variant="ghost" size="icon" onClick={() => window.history.back()}>
                   <ArrowLeft className="h-4 w-4" />
                </Button>
                <div>
                   <h1 className="text-2xl font-bold tracking-tight">任务结果对比</h1>
                   <p className="text-sm text-muted-foreground">
                      {task1 ? `${task1.name} (ID: ${task1.id})` : `ID: ${id1}`} 
                      {" vs "} 
                      {task2 ? `${task2.name} (ID: ${task2.id})` : `ID: ${id2}`}
                   </p>
                </div>
             </div>
             
             <div className="flex items-center gap-2">
                <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as "split" | "diff")}>
                   <TabsList>
                      <TabsTrigger value="split" className="flex items-center gap-2">
                         <Split className="h-4 w-4" />
                         分屏对比
                      </TabsTrigger>
                      <TabsTrigger value="diff" className="flex items-center gap-2">
                         <GitCompare className="h-4 w-4" />
                         差异高亮
                      </TabsTrigger>
                   </TabsList>
                </Tabs>
             </div>
          </div>
          
          {isLoading ? (
             <div className="flex-1 flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
             </div>
          ) : (
             <div className="flex-1 min-h-0 overflow-hidden">
                {viewMode === "split" ? (
                   <div className="grid grid-cols-2 gap-4 h-full">
                      <TaskResultColumn task={task1} content={content1?.content} />
                      <TaskResultColumn task={task2} content={content2?.content} />
                   </div>
                ) : (
                   <Card className="h-full flex flex-col overflow-hidden">
                      <CardHeader className="py-3 bg-muted/30">
                         <div className="flex items-center gap-4 text-sm">
                            <div className="flex items-center gap-2">
                               <div className="w-3 h-3 bg-red-100 border border-red-200 rounded"></div>
                               <span>删除 (Task {id1})</span>
                            </div>
                            <div className="flex items-center gap-2">
                               <div className="w-3 h-3 bg-green-100 border border-green-200 rounded"></div>
                               <span>新增 (Task {id2})</span>
                            </div>
                         </div>
                      </CardHeader>
                      <CardContent className="flex-1 overflow-hidden p-0">
                         <ScrollArea className="h-full">
                            <div className="p-4 font-mono text-sm whitespace-pre-wrap">
                               {diff?.map((part, index) => {
                                  const color = part.added ? 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300' :
                                                part.removed ? 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300' : 
                                                'text-muted-foreground';
                                  return (
                                     <span key={index} className={`${color} block px-1`}>
                                        {part.value}
                                     </span>
                                  );
                               })}
                               {!diff && <div className="text-center py-8 text-muted-foreground">无法生成差异对比</div>}
                            </div>
                         </ScrollArea>
                      </CardContent>
                   </Card>
                )}
             </div>
          )}
       </div>
    </DashboardLayout>
  );
}

function TaskResultColumn({ task, content }: { task: any, content?: string }) {
  if (!task) return null;

  const statusConfig = {
    pending: { label: "等待中", variant: "secondary" as const },
    processing: { label: "处理中", variant: "default" as const },
    completed: { label: "已完成", variant: "default" as const },
    failed: { label: "失败", variant: "destructive" as const },
    paused: { label: "已暂停", variant: "outline" as const },
  };

  const status = statusConfig[task.status as keyof typeof statusConfig] || statusConfig.pending;

  return (
     <Card className="h-full flex flex-col overflow-hidden">
        <CardHeader className="pb-3 bg-muted/30 flex-none">
           <div className="flex items-start justify-between">
             <div className="space-y-1">
               <CardTitle className="text-lg">{task.name}</CardTitle>
               <CardDescription>ID: {task.id}</CardDescription>
             </div>
             <Badge variant={status.variant}>{status.label}</Badge>
           </div>
           
           <div className="grid grid-cols-2 gap-2 mt-4 text-xs">
             <div className="flex items-center gap-1 text-muted-foreground">
               <FileText className="h-3 w-3" />
               <span>提取: {task.extractedCount} 题</span>
             </div>
             <div className="flex items-center gap-1 text-muted-foreground">
               <Cpu className="h-3 w-3" />
               <span>页数: {task.processedPages}/{task.totalPages}</span>
             </div>
             <div className="flex items-center gap-1 text-muted-foreground">
               <Clock className="h-3 w-3" />
               <span>重试: {task.retryCount} 次</span>
             </div>
             <div className="flex items-center gap-1 text-muted-foreground">
               <span>创建: {new Date(task.createdAt).toLocaleDateString()}</span>
             </div>
           </div>
        </CardHeader>
        <CardContent className="flex-1 overflow-hidden p-0">
           {task.status === "completed" ? (
             <ScrollArea className="h-full p-4">
                <div className="prose prose-sm max-w-none dark:prose-invert">
                    <Streamdown>{content || "*暂无内容*"}</Streamdown>
                </div>
             </ScrollArea>
           ) : (
             <div className="h-full flex items-center justify-center text-muted-foreground">
               <p>任务未完成，无法查看结果</p>
             </div>
           )}
        </CardContent>
     </Card>
  )
}
