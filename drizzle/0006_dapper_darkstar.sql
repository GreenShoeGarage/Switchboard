CREATE TABLE `device_safe_state_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`actor` text DEFAULT 'owner' NOT NULL,
	`status` text DEFAULT 'QUEUED' NOT NULL,
	`target_count` integer NOT NULL,
	`requested_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `device_safe_state_runs_device_time_idx` ON `device_safe_state_runs` (`device_id`,`requested_at`);--> statement-breakpoint
ALTER TABLE `devices` ADD `control_ready` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `gpio_commands` ADD `origin` text DEFAULT 'OPERATOR' NOT NULL;--> statement-breakpoint
ALTER TABLE `gpio_commands` ADD `safe_state_run_id` text REFERENCES device_safe_state_runs(id);--> statement-breakpoint
CREATE INDEX `gpio_commands_safe_state_run_idx` ON `gpio_commands` (`safe_state_run_id`);