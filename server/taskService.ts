import { 
  getExtractionTaskById, 
  createExtractionTask, 
  createPageProcessingLogs 
} from "./db";
import { startTaskProcessing } from "./taskProcessor";

export class TaskService {
  async retryTask(taskId: number, userId: number) {
    // 1. 获取原任务
    const originalTask = await getExtractionTaskById(taskId, userId);
    if (!originalTask) {
      throw new Error("原任务不存在");
    }

    // 2. 准备新任务数据
    const retryCount = (originalTask.retryCount || 0) + 1;
    const rootTaskId = originalTask.rootTaskId || originalTask.id;
    
    // 生成新名称
    let newName = originalTask.name;
    const retryMatch = newName.match(/ \(Retry \d+\)$/);
    if (retryMatch) {
      newName = newName.substring(0, retryMatch.index);
    }
    newName = `${newName} (Retry ${retryCount})`;

    const newTaskData = {
      userId: userId,
      name: newName,
      configId: originalTask.configId,
      chapterConfigId: originalTask.chapterConfigId,
      sourceFolder: originalTask.sourceFolder,
      markdownPath: originalTask.markdownPath,
      contentListPath: originalTask.contentListPath,
      imagesFolder: originalTask.imagesFolder,
      totalPages: originalTask.totalPages,
      status: "processing" as const,
      startedAt: new Date(),
      
      // 族系关联
      parentTaskId: originalTask.id,
      rootTaskId: rootTaskId,
      retryCount: retryCount,
    };

    // 3. 创建新任务
    const id = await createExtractionTask(newTaskData);

    // 4. 创建页面处理日志
    const pageLogs = [];
    for (let i = 0; i < originalTask.totalPages - 1; i++) {
      pageLogs.push({
        taskId: id,
        pageIndex: i,
        status: "pending" as const
      });
    }
    if (pageLogs.length > 0) {
      await createPageProcessingLogs(pageLogs);
    }

    // 5. 异步启动处理
    startTaskProcessing(id, userId);

    return { id };
  }
}

export const taskService = new TaskService();
