CREATE TABLE `task_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`taskId` integer NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`stage` text(64),
	`chunkIndex` integer,
	`totalChunks` integer,
	`message` text NOT NULL,
	`details` text,
	`createdAt` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
