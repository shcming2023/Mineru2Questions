ALTER TABLE `extraction_tasks` ADD `chapterConfigId` integer;--> statement-breakpoint
ALTER TABLE `llm_configs` ADD `purpose` text DEFAULT 'vision_extract' NOT NULL;