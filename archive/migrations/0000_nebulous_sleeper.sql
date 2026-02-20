CREATE TABLE `extraction_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`configId` integer,
	`name` text(256) NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`sourceFolder` text NOT NULL,
	`markdownPath` text,
	`contentListPath` text,
	`imagesFolder` text,
	`totalPages` integer DEFAULT 0 NOT NULL,
	`processedPages` integer DEFAULT 0 NOT NULL,
	`currentPage` integer DEFAULT 0 NOT NULL,
	`startedAt` integer,
	`completedAt` integer,
	`estimatedTimeRemaining` integer,
	`resultJsonPath` text,
	`resultMarkdownPath` text,
	`extractedCount` integer DEFAULT 0 NOT NULL,
	`errorMessage` text,
	`retryCount` integer DEFAULT 0 NOT NULL,
	`createdAt` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updatedAt` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `llm_configs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`name` text(128) NOT NULL,
	`apiUrl` text NOT NULL,
	`apiKey` text NOT NULL,
	`modelName` text(128) NOT NULL,
	`maxWorkers` integer DEFAULT 5 NOT NULL,
	`timeout` integer DEFAULT 300 NOT NULL,
	`isDefault` integer DEFAULT false NOT NULL,
	`createdAt` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updatedAt` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `page_processing_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`taskId` integer NOT NULL,
	`pageIndex` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`inputImages` text,
	`outputText` text,
	`extractedQuestions` text,
	`errorMessage` text,
	`processingTime` integer,
	`createdAt` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updatedAt` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`openId` text(64) NOT NULL,
	`name` text,
	`email` text(320),
	`loginMethod` text(64),
	`role` text DEFAULT 'user' NOT NULL,
	`createdAt` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updatedAt` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`lastSignedIn` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_openId_unique` ON `users` (`openId`);