CREATE TABLE `device_agent_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` text NOT NULL,
	`session_id` text,
	`level` text NOT NULL,
	`code` text NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`device_uptime_ms` integer,
	`recorded_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `device_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `device_agent_logs_device_time_idx` ON `device_agent_logs` (`device_id`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `device_agent_logs_level_time_idx` ON `device_agent_logs` (`level`,`recorded_at`);--> statement-breakpoint
CREATE TABLE `hardware_test_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`status` text DEFAULT 'RUNNING' NOT NULL,
	`agent_version` text NOT NULL,
	`fixture` text DEFAULT 'D7 output to D2 input loopback' NOT NULL,
	`target_cycles` integer DEFAULT 1000 NOT NULL,
	`completed_cycles` integer DEFAULT 0 NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`operator` text DEFAULT 'owner' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `hardware_test_runs_device_time_idx` ON `hardware_test_runs` (`device_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `hardware_test_steps` (
	`run_id` text NOT NULL,
	`step_key` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`observation` text DEFAULT '' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`run_id`, `step_key`),
	FOREIGN KEY (`run_id`) REFERENCES `hardware_test_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `hardware_test_steps_run_status_idx` ON `hardware_test_steps` (`run_id`,`status`);