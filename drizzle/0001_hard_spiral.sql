CREATE TABLE `extraction_tasks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`configId` int,
	`name` varchar(256) NOT NULL,
	`status` enum('pending','processing','completed','failed','paused') NOT NULL DEFAULT 'pending',
	`sourceFolder` text NOT NULL,
	`markdownPath` text,
	`contentListPath` text,
	`imagesFolder` text,
	`totalPages` int NOT NULL DEFAULT 0,
	`processedPages` int NOT NULL DEFAULT 0,
	`currentPage` int NOT NULL DEFAULT 0,
	`startedAt` timestamp,
	`completedAt` timestamp,
	`estimatedTimeRemaining` int,
	`resultJsonPath` text,
	`resultMarkdownPath` text,
	`extractedCount` int NOT NULL DEFAULT 0,
	`errorMessage` text,
	`retryCount` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `extraction_tasks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `llm_configs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(128) NOT NULL,
	`apiUrl` text NOT NULL,
	`apiKey` text NOT NULL,
	`modelName` varchar(128) NOT NULL,
	`maxWorkers` int NOT NULL DEFAULT 5,
	`timeout` int NOT NULL DEFAULT 300,
	`isDefault` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `llm_configs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `page_processing_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`taskId` int NOT NULL,
	`pageIndex` int NOT NULL,
	`status` enum('pending','processing','completed','failed') NOT NULL DEFAULT 'pending',
	`inputImages` json,
	`outputText` text,
	`extractedQuestions` json,
	`errorMessage` text,
	`processingTime` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `page_processing_logs_id` PRIMARY KEY(`id`)
);
