import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, Upload, FolderOpen, Loader2, CheckCircle, AlertCircle } from "lucide-react";
import { useLocation } from "wouter";
import { useState, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { PURPOSE_LABELS, type LLMPurpose } from "../../../shared/llm-presets";

interface FileInfo {
  name: string;
  path: string;
  type: string;
  size: number;
  content?: string;
}

interface FolderStructure {
  markdown?: FileInfo;
  contentList?: FileInfo;
  images: FileInfo[];
  pageImages: FileInfo[];
  totalPages: number;
}

const PURPOSE_BADGE_COLORS: Record<LLMPurpose, string> = {
  vision_extract: "text-blue-600",
  long_context: "text-purple-600",
  general: "text-gray-600",
};

export default function NewTask() {
  const [, setLocation] = useLocation();
  const [taskName, setTaskName] = useState("");
  const [selectedConfigId, setSelectedConfigId] = useState<string>("");
  const [selectedChapterConfigId, setSelectedChapterConfigId] = useState<string>("");
  const [folderStructure, setFolderStructure] = useState<FolderStructure | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  
  const { data: configs } = trpc.llmConfig.list.useQuery();
  const uploadFileMutation = trpc.upload.uploadFile.useMutation();
  const createTaskMutation = trpc.task.create.useMutation({
    onSuccess: (data) => {
      toast.success("任务创建成功");
      setLocation(`/tasks/${data.id}`);
    },
    onError: (error) => toast.error(error.message),
  });

  // 按用途分类配置
  const visionConfigs = useMemo(() => 
    configs?.filter((c: any) => !c.purpose || c.purpose === 'vision_extract' || c.purpose === 'general') || [],
    [configs]
  );
  
  const longContextConfigs = useMemo(() => 
    configs?.filter((c: any) => c.purpose === 'long_context' || c.purpose === 'general') || [],
    [configs]
  );

  // 处理文件夹选择
  const handleFolderSelect = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const structure: FolderStructure = {
      images: [],
      pageImages: [],
      totalPages: 0,
    };

    // 解析文件结构
    const fileList = Array.from(files);
    
    for (const file of fileList) {
      const relativePath = file.webkitRelativePath || file.name;
      const pathParts = relativePath.split("/");
      const fileName = pathParts[pathParts.length - 1];
      const parentFolder = pathParts.length > 1 ? pathParts[pathParts.length - 2] : "";

      const fileInfo: FileInfo = {
        name: fileName,
        path: relativePath,
        type: file.type,
        size: file.size,
      };

      // 识别文件类型
      if (fileName.endsWith(".md")) {
        structure.markdown = fileInfo;
        // 从文件名提取任务名
        if (!taskName) {
          setTaskName(fileName.replace(".md", "").replace(/_/g, " "));
        }
      } else if (fileName === "content_list.json" || fileName.endsWith("_content_list.json")) {
        structure.contentList = fileInfo;
      } else if (parentFolder === "images" && (fileName.endsWith(".jpg") || fileName.endsWith(".png") || fileName.endsWith(".jpeg"))) {
        structure.images.push(fileInfo);
      } else if (fileName.match(/^page_\d+\.(jpg|png|jpeg)$/i)) {
        structure.pageImages.push(fileInfo);
      }
    }

    // 计算总页数
    structure.totalPages = Math.max(structure.pageImages.length, 1);
    
    setFolderStructure(structure);
    
    // 验证文件结构
    if (!structure.contentList) {
      toast.warning("未找到content_list.json文件,请确保上传的是MinerU解析输出文件夹");
    }
  }, [taskName]);

  // 上传文件到S3
  const uploadFiles = async () => {
    if (!folderStructure || !taskName) {
      toast.error("请先选择文件夹并输入任务名称");
      return;
    }

    setIsUploading(true);
    setUploadProgress(0);

    try {
      const timestamp = Date.now();
      const baseKey = `tasks/${taskName}-${timestamp}`;
      const uploaded: { [key: string]: string } = {};
      
      // 获取所有需要上传的文件
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      const files = input?.files;
      if (!files) throw new Error("无法获取文件");

      const fileMap = new Map<string, File>();
      Array.from(files).forEach(f => {
        fileMap.set(f.webkitRelativePath || f.name, f);
      });

      const filesToUpload: { key: string; file: File; type: string }[] = [];

      // 准备上传列表
      if (folderStructure.contentList) {
        const file = fileMap.get(folderStructure.contentList.path);
        if (file) {
          filesToUpload.push({
            key: `${baseKey}/content_list.json`,
            file,
            type: "application/json",
          });
        }
      }

      if (folderStructure.markdown) {
        const file = fileMap.get(folderStructure.markdown.path);
        if (file) {
          filesToUpload.push({
            key: `${baseKey}/${folderStructure.markdown.name}`,
            file,
            type: "text/markdown",
          });
        }
      }

      // 上传图片
      for (const img of [...folderStructure.images, ...folderStructure.pageImages]) {
        const file = fileMap.get(img.path);
        if (file) {
          const imgKey = img.path.includes("images/") 
            ? `${baseKey}/images/${img.name}`
            : `${baseKey}/pages/${img.name}`;
          filesToUpload.push({
            key: imgKey,
            file,
            type: file.type || "image/jpeg",
          });
        }
      }

      // 批量上传
      let completed = 0;
      for (const { key, file, type } of filesToUpload) {
        const arrayBuffer = await file.arrayBuffer();
        const base64 = btoa(
          new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), "")
        );
        
        const result = await uploadFileMutation.mutateAsync({
          fileKey: key,
          content: base64,
          contentType: type,
        });
        
        uploaded[key] = result.url;
        completed++;
        setUploadProgress(Math.round((completed / filesToUpload.length) * 100));
      }

      toast.success("文件上传完成");
      
      // 创建任务
      const contentListKey = `${baseKey}/content_list.json`;
      const markdownKey = folderStructure.markdown ? `${baseKey}/${folderStructure.markdown.name}` : undefined;
      const imagesFolder = `${baseKey}/images`;
      
      await createTaskMutation.mutateAsync({
        name: taskName,
        configId: selectedConfigId ? parseInt(selectedConfigId) : undefined,
        chapterConfigId: selectedChapterConfigId ? parseInt(selectedChapterConfigId) : undefined,
        sourceFolder: baseKey,
        contentListPath: contentListKey,
        markdownPath: markdownKey,
        imagesFolder: imagesFolder,
        totalPages: folderStructure.totalPages,
      });

    } catch (error: any) {
      toast.error(`上传失败: ${error.message}`);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-3xl">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/tasks")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">新建提取任务</h1>
            <p className="text-muted-foreground">上传MinerU解析结果,开始提取题目</p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>选择MinerU输出文件夹</CardTitle>
            <CardDescription>
              请选择MinerU解析PDF后生成的输出文件夹,应包含markdown文件、content_list.json和images文件夹
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* 文件夹选择 */}
            <div className="space-y-2">
              <Label>选择文件夹</Label>
              <div className="flex items-center gap-4">
                <Input
                  type="file"
                  // @ts-ignore - webkitdirectory is not in the type definition
                  webkitdirectory=""
                  directory=""
                  multiple
                  onChange={handleFolderSelect}
                  className="hidden"
                  id="folder-input"
                />
                <Button
                  variant="outline"
                  onClick={() => document.getElementById("folder-input")?.click()}
                  className="w-full h-24 border-dashed"
                >
                  <div className="flex flex-col items-center gap-2">
                    <FolderOpen className="h-8 w-8 text-muted-foreground" />
                    <span>点击选择MinerU输出文件夹</span>
                  </div>
                </Button>
              </div>
            </div>

            {/* 文件结构预览 */}
            {folderStructure && (
              <div className="space-y-4 p-4 bg-muted/50 rounded-lg">
                <h3 className="font-medium">文件结构检测结果</h3>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center gap-2">
                    {folderStructure.contentList ? (
                      <CheckCircle className="h-4 w-4 text-green-500" />
                    ) : (
                      <AlertCircle className="h-4 w-4 text-yellow-500" />
                    )}
                    <span>content_list.json: {folderStructure.contentList ? "已找到" : "未找到"}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {folderStructure.markdown ? (
                      <CheckCircle className="h-4 w-4 text-green-500" />
                    ) : (
                      <AlertCircle className="h-4 w-4 text-yellow-500" />
                    )}
                    <span>Markdown文件: {folderStructure.markdown?.name || "未找到"}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-green-500" />
                    <span>图片文件: {folderStructure.images.length} 个</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-green-500" />
                    <span>页面图片: {folderStructure.pageImages.length} 个</span>
                  </div>
                  <div className="flex items-center gap-2 font-medium">
                    <span>预计处理页数: {folderStructure.totalPages} 页</span>
                  </div>
                </div>
              </div>
            )}

            {/* 任务名称 */}
            <div className="space-y-2">
              <Label htmlFor="task-name">任务名称</Label>
              <Input
                id="task-name"
                value={taskName}
                onChange={(e) => setTaskName(e.target.value)}
                placeholder="输入任务名称(如: 高中数学必修一)"
              />
            </div>

            {/* LLM配置选择 - 题目抽取 */}
            <div className="space-y-2">
              <Label>题目抽取 LLM 配置 <span className="text-blue-600 text-xs">(视觉模型)</span></Label>
              <Select value={selectedConfigId} onValueChange={setSelectedConfigId}>
                <SelectTrigger>
                  <SelectValue placeholder="选择题目抽取 LLM 配置(可选)" />
                </SelectTrigger>
                <SelectContent>
                  {visionConfigs.map((config: any) => (
                    <SelectItem key={config.id} value={config.id.toString()}>
                      <span>{config.name}</span>
                      <span className="text-muted-foreground ml-1">({config.modelName})</span>
                      {config.isDefault && <span className="text-primary ml-1">- 默认</span>}
                      <span className={`ml-1 text-xs ${PURPOSE_BADGE_COLORS[config.purpose as LLMPurpose] || ''}`}>
                        [{PURPOSE_LABELS[config.purpose as LLMPurpose] || '通用'}]
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                用于分块处理题目提取，推荐使用视觉语言模型（如 Qwen2.5-VL、GPT-4o）
              </p>
            </div>

            {/* LLM配置选择 - 章节预处理 */}
            <div className="space-y-2">
              <Label>章节预处理 LLM 配置 <span className="text-purple-600 text-xs">(长文本模型)</span></Label>
              <Select value={selectedChapterConfigId} onValueChange={setSelectedChapterConfigId}>
                <SelectTrigger>
                  <SelectValue placeholder="选择章节预处理 LLM 配置(可选)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">
                    <span className="text-muted-foreground">不使用章节预处理</span>
                  </SelectItem>
                  {longContextConfigs.map((config: any) => (
                    <SelectItem key={config.id} value={config.id.toString()}>
                      <span>{config.name}</span>
                      <span className="text-muted-foreground ml-1">({config.modelName})</span>
                      {config.contextWindow && <span className="text-xs text-muted-foreground ml-1">[{Math.round(config.contextWindow/1000)}k]</span>}
                      {config.isDefault && <span className="text-primary ml-1">- 默认</span>}
                      <span className={`ml-1 text-xs ${PURPOSE_BADGE_COLORS[config.purpose as LLMPurpose] || ''}`}>
                        [{PURPOSE_LABELS[config.purpose as LLMPurpose] || '通用'}]
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                用于全文推理构建章节目录树，推荐使用长上下文模型（如 Gemini 2.5 Flash 1M、DeepSeek-V3 128K）。
                如不选择，将由题目抽取 LLM 自行判断章节。
              </p>
            </div>

            {/* 上传进度 */}
            {isUploading && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>正在上传文件... {uploadProgress}%</span>
                </div>
                <div className="w-full bg-muted rounded-full h-2">
                  <div
                    className="bg-primary h-2 rounded-full transition-all"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>
            )}

            {/* 提交按钮 */}
            <div className="flex gap-4">
              <Button variant="outline" onClick={() => setLocation("/tasks")}>
                取消
              </Button>
              <Button
                onClick={uploadFiles}
                disabled={!folderStructure || !taskName || isUploading || createTaskMutation.isPending}
              >
                {isUploading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    上传中...
                  </>
                ) : createTaskMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    创建任务...
                  </>
                ) : (
                  <>
                    <Upload className="mr-2 h-4 w-4" />
                    上传并创建任务
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
