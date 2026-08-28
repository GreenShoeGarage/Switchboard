ALTER TABLE `device_pins` ADD `server_safe_value` real;--> statement-breakpoint
ALTER TABLE `devices` ADD `monitor_only` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `devices` ADD `firmware_failsafe_mode` text DEFAULT 'NOT_REPORTED' NOT NULL;--> statement-breakpoint
ALTER TABLE `devices` ADD `firmware_failsafe_timeout_ms` integer;--> statement-breakpoint
ALTER TABLE `devices` ADD `firmware_failsafe_reported_at` integer;