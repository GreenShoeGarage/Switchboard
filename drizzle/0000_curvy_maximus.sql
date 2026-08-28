CREATE TABLE `device_connection_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` text NOT NULL,
	`state` text NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`occurred_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `device_connection_events_device_time_idx` ON `device_connection_events` (`device_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `device_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `device_groups_name_idx` ON `device_groups` (`name`);--> statement-breakpoint
CREATE TABLE `device_pins` (
	`device_id` text NOT NULL,
	`pin_id` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`mode` text DEFAULT 'INPUT' NOT NULL,
	`confirmed_value` real,
	`logical_low_label` text,
	`logical_high_label` text,
	`engineering_unit` text,
	`scale_input_low` real,
	`scale_output_low` real,
	`scale_input_high` real,
	`scale_output_high` real,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`device_id`, `pin_id`),
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `device_pins_device_idx` ON `device_pins` (`device_id`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`board_profile_id` text NOT NULL,
	`kind` text DEFAULT 'PHYSICAL' NOT NULL,
	`connection_state` text DEFAULT 'UNKNOWN' NOT NULL,
	`group_id` text,
	`agent_version` text,
	`firmware_version` text,
	`rssi_dbm` integer,
	`ip_address` text,
	`last_seen_at` integer,
	`last_connected_at` integer,
	`last_disconnected_at` integer,
	`simulated` integer DEFAULT false NOT NULL,
	`maintenance_mode` integer DEFAULT false NOT NULL,
	`configuration_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `device_groups`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `devices_name_idx` ON `devices` (`name`);--> statement-breakpoint
CREATE INDEX `devices_state_idx` ON `devices` (`connection_state`);--> statement-breakpoint
CREATE INDEX `devices_profile_idx` ON `devices` (`board_profile_id`);--> statement-breakpoint
CREATE INDEX `devices_group_idx` ON `devices` (`group_id`);