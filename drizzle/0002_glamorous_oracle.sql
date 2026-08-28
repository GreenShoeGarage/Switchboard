CREATE TABLE `gpio_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`pin_id` text NOT NULL,
	`kind` text NOT NULL,
	`requested_mode` text,
	`requested_value` real,
	`status` text DEFAULT 'QUEUED' NOT NULL,
	`actor` text DEFAULT 'owner' NOT NULL,
	`requested_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deadline_at` integer NOT NULL,
	`delivered_at` integer,
	`completed_at` integer,
	`session_id` text,
	`confirmed_mode` text,
	`confirmed_value` real,
	`device_timestamp_ms` integer,
	`latency_ms` integer,
	`error` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `device_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `gpio_commands_device_time_idx` ON `gpio_commands` (`device_id`,`requested_at`);--> statement-breakpoint
CREATE INDEX `gpio_commands_device_status_idx` ON `gpio_commands` (`device_id`,`status`);--> statement-breakpoint
CREATE INDEX `gpio_commands_status_deadline_idx` ON `gpio_commands` (`status`,`deadline_at`);--> statement-breakpoint
CREATE INDEX `gpio_commands_session_idx` ON `gpio_commands` (`session_id`);