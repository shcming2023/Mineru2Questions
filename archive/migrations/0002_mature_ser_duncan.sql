CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`stage` text(64) NOT NULL,
	`inputLen` integer,
	`outputLen` integer,
	`rejectReason` text,
	`fallbackUsed` integer,
	`timestamp` integer NOT NULL,
	`taskId` text
);
