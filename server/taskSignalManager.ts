/**
 * 任务状态管理器
 * 
 * 实现暂停/取消功能的核心机制
 * 根据PRD v4.1要求，支持任务的状态控制和信号传递
 */

export interface TaskSignal {
  taskId: number;
  shouldPause: boolean;
  shouldCancel: boolean;
  pausedAt?: Date;
  cancelledAt?: Date;
}

/**
 * 任务信号管理器
 * 用于管理任务的暂停/取消状态
 */
class TaskSignalManager {
  private signals: Map<number, TaskSignal> = new Map();

  /**
   * 注册新任务信号
   */
  registerTask(taskId: number): void {
    this.signals.set(taskId, {
      taskId,
      shouldPause: false,
      shouldCancel: false
    });
  }

  /**
   * 注销任务信号
   */
  unregisterTask(taskId: number): void {
    this.signals.delete(taskId);
  }

  /**
   * 暂停任务
   */
  pauseTask(taskId: number): boolean {
    const signal = this.signals.get(taskId);
    if (!signal) {
      return false;
    }
    
    signal.shouldPause = true;
    signal.pausedAt = new Date();
    return true;
  }

  /**
   * 恢复任务
   */
  resumeTask(taskId: number): boolean {
    const signal = this.signals.get(taskId);
    if (!signal) {
      return false;
    }
    
    signal.shouldPause = false;
    signal.pausedAt = undefined;
    return true;
  }

  /**
   * 取消任务
   */
  cancelTask(taskId: number): boolean {
    const signal = this.signals.get(taskId);
    if (!signal) {
      return false;
    }
    
    signal.shouldCancel = true;
    signal.cancelledAt = new Date();
    signal.shouldPause = false; // 取消时不需要暂停状态
    return true;
  }

  /**
   * 检查任务是否应该暂停
   */
  shouldPause(taskId: number): boolean {
    const signal = this.signals.get(taskId);
    return signal?.shouldPause || false;
  }

  /**
   * 检查任务是否被取消
   */
  shouldCancel(taskId: number): boolean {
    const signal = this.signals.get(taskId);
    return signal?.shouldCancel || false;
  }

  /**
   * 获取任务信号
   */
  getSignal(taskId: number): TaskSignal | undefined {
    return this.signals.get(taskId);
  }

  /**
   * 获取所有活动任务的信号
   */
  getAllSignals(): TaskSignal[] {
    return Array.from(this.signals.values());
  }

  /**
   * 清理过期的信号（超过1小时的已完成任务）
   */
  cleanup(): void {
    // 暂时不实现，因为我们需要保持任务信号直到任务完全结束
  }
}

// 导出单例实例
export const taskSignalManager = new TaskSignalManager();

/**
 * 任务状态检查函数
 * 在任务执行的各个关键点调用
 */
export function checkTaskStatus(taskId: number): { shouldPause: boolean; shouldCancel: boolean } {
  const shouldPause = taskSignalManager.shouldPause(taskId);
  const shouldCancel = taskSignalManager.shouldCancel(taskId);
  
  return { shouldPause, shouldCancel };
}

/**
 * 等待任务恢复（如果暂停）
 */
export async function waitForResume(taskId: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const checkInterval = setInterval(() => {
      if (!taskSignalManager.shouldPause(taskId)) {
        clearInterval(checkInterval);
        resolve();
      }
      
      // 如果任务被取消，也停止等待
      if (taskSignalManager.shouldCancel(taskId)) {
        clearInterval(checkInterval);
        resolve();
      }
    }, 1000); // 每秒检查一次
  });
}

/**
 * 任务执行辅助函数
 * 在任务执行循环中使用
 */
export async function executeWithSignalCheck<T>(
  taskId: number,
  operation: () => Promise<T>,
  onPaused?: () => Promise<void>,
  onCancelled?: () => Promise<void>
): Promise<T> {
  // 检查取消状态
  if (taskSignalManager.shouldCancel(taskId)) {
    if (onCancelled) {
      await onCancelled();
    }
    throw new Error(`Task ${taskId} was cancelled`);
  }

  // 检查暂停状态
  if (taskSignalManager.shouldPause(taskId)) {
    if (onPaused) {
      await onPaused();
    }
    await waitForResume(taskId);
  }

  // 再次检查取消状态（可能在暂停期间被取消）
  if (taskSignalManager.shouldCancel(taskId)) {
    if (onCancelled) {
      await onCancelled();
    }
    throw new Error(`Task ${taskId} was cancelled`);
  }

  // 执行实际操作
  return await operation();
}