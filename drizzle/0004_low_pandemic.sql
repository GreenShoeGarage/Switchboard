CREATE TABLE `device_telemetry_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` text NOT NULL,
	`pin_id` text NOT NULL,
	`sequence` integer,
	`raw_value` real NOT NULL,
	`voltage_value` real NOT NULL,
	`engineering_value` real NOT NULL,
	`engineering_unit` text DEFAULT 'V' NOT NULL,
	`recorded_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `device_telemetry_pin_time_idx` ON `device_telemetry_samples` (`device_id`,`pin_id`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `device_telemetry_device_time_idx` ON `device_telemetry_samples` (`device_id`,`recorded_at`);--> statement-breakpoint
ALTER TABLE `device_pins` ADD `confirmed_raw_value` real;--> statement-breakpoint
ALTER TABLE `device_pins` ADD `sampled_at` integer;