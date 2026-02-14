import { describe, expect, it, vi, beforeEach } from "vitest";
import { taskService } from "./taskService";
import { 
  getExtractionTaskById, 
  createExtractionTask, 
  createPageProcessingLogs 
} from "./db";
import { startTaskProcessing } from "./taskProcessor";

// Mock database functions
vi.mock("./db", () => ({
  getExtractionTaskById: vi.fn(),
  createExtractionTask: vi.fn(),
  createPageProcessingLogs: vi.fn(),
}));

// Mock task processor
vi.mock("./taskProcessor", () => ({
  startTaskProcessing: vi.fn().mockResolvedValue(undefined),
}));

describe("TaskService", () => {
  const mockUserId = 1;
  const mockTaskId = 100;
  const mockNewTaskId = 200;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("retryTask", () => {
    it("should create a new retry task with correct lineage and config", async () => {
      // Mock original task
      const originalTask = {
        id: mockTaskId,
        userId: mockUserId,
        name: "Test Task",
        configId: 10,
        chapterConfigId: 20,
        sourceFolder: "s3://test/folder",
        markdownPath: "s3://test/md",
        contentListPath: "s3://test/list",
        imagesFolder: "s3://test/images",
        totalPages: 5,
        status: "completed",
        createdAt: new Date(),
        retryCount: 0,
        rootTaskId: null, // First task in lineage
      };

      vi.mocked(getExtractionTaskById).mockResolvedValue(originalTask as any);
      vi.mocked(createExtractionTask).mockResolvedValue(mockNewTaskId);

      // Execute
      const result = await taskService.retryTask(mockTaskId, mockUserId);

      // Verify
      expect(result).toEqual({ id: mockNewTaskId });

      // Verify createExtractionTask called with correct params
      expect(createExtractionTask).toHaveBeenCalledWith(expect.objectContaining({
        userId: mockUserId,
        name: "Test Task (Retry 1)",
        configId: originalTask.configId,
        chapterConfigId: originalTask.chapterConfigId,
        sourceFolder: originalTask.sourceFolder,
        totalPages: originalTask.totalPages,
        status: "processing",
        parentTaskId: mockTaskId,
        rootTaskId: mockTaskId, // Should be original ID since it was root
        retryCount: 1,
      }));

      // Verify logs created
      expect(createPageProcessingLogs).toHaveBeenCalled();
      const logs = vi.mocked(createPageProcessingLogs).mock.calls[0][0];
      expect(logs).toHaveLength(4); // totalPages - 1
      expect(logs[0]).toMatchObject({ taskId: mockNewTaskId, status: "pending" });

      // Verify processing started
      expect(startTaskProcessing).toHaveBeenCalledWith(mockNewTaskId, mockUserId);
    });

    it("should handle nested retries correctly (maintain rootTaskId)", async () => {
      // Mock a task that is already a retry
      const originalTask = {
        id: mockTaskId,
        userId: mockUserId,
        name: "Test Task (Retry 1)",
        configId: 10,
        totalPages: 5,
        status: "failed",
        retryCount: 1,
        rootTaskId: 50, // Original root
        parentTaskId: 90,
      };

      vi.mocked(getExtractionTaskById).mockResolvedValue(originalTask as any);
      vi.mocked(createExtractionTask).mockResolvedValue(mockNewTaskId);

      // Execute
      await taskService.retryTask(mockTaskId, mockUserId);

      // Verify naming and lineage
      expect(createExtractionTask).toHaveBeenCalledWith(expect.objectContaining({
        name: "Test Task (Retry 2)", // Incremented
        rootTaskId: 50, // Preserved
        parentTaskId: mockTaskId, // Parent is the one being retried
        retryCount: 2,
      }));
    });

    it("should throw error if original task not found", async () => {
      vi.mocked(getExtractionTaskById).mockResolvedValue(null);

      await expect(taskService.retryTask(mockTaskId, mockUserId))
        .rejects.toThrow("原任务不存在");
    });
  });
});
