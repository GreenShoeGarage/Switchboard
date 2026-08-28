CREATE TABLE `automation_action_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`action_id` text,
	`position` integer NOT NULL,
	`target_device_id` text NOT NULL,
	`target_pin_id` text NOT NULL,
	`command_kind` text NOT NULL,
	`requested_value` real NOT NULL,
	`status` text DEFAULT 'PLANNED' NOT NULL,
	`gpio_command_id` text,
	`error` text DEFAULT '' NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`execution_id`) REFERENCES `automation_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`action_id`) REFERENCES `automation_actions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`gpio_command_id`) REFERENCES `gpio_commands`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_action_runs_execution_position_idx` ON `automation_action_runs` (`execution_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `automation_action_runs_command_idx` ON `automation_action_runs` (`gpio_command_id`);--> statement-breakpoint
CREATE INDEX `automation_action_runs_status_time_idx` ON `automation_action_runs` (`status`,`started_at`);--> statement-breakpoint
CREATE TABLE `automation_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text NOT NULL,
	`position` integer NOT NULL,
	`target_device_id` text,
	`target_pin_id` text NOT NULL,
	`command_kind` text NOT NULL,
	`requested_value` real NOT NULL,
	`target_configuration_version` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `automation_rules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_actions_rule_position_idx` ON `automation_actions` (`rule_id`,`position`);--> statement-breakpoint
CREATE INDEX `automation_actions_target_idx` ON `automation_actions` (`target_device_id`,`target_pin_id`);--> statement-breakpoint
CREATE TABLE `automation_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text NOT NULL,
	`trigger_id` text,
	`rule_revision` integer NOT NULL,
	`source_kind` text NOT NULL,
	`source_event_key` text NOT NULL,
	`execution_mode` text NOT NULL,
	`status` text NOT NULL,
	`actor` text NOT NULL,
	`root_execution_id` text,
	`parent_execution_id` text,
	`chain_depth` integer DEFAULT 0 NOT NULL,
	`trigger_value` real,
	`trigger_recorded_at` integer,
	`condition_since_at` integer,
	`matched` integer DEFAULT false NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`requested_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`rule_id`) REFERENCES `automation_rules`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`trigger_id`) REFERENCES `automation_triggers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_executions_rule_event_idx` ON `automation_executions` (`rule_id`,`source_event_key`);--> statement-breakpoint
CREATE INDEX `automation_executions_rule_time_idx` ON `automation_executions` (`rule_id`,`requested_at`);--> statement-breakpoint
CREATE INDEX `automation_executions_status_time_idx` ON `automation_executions` (`status`,`requested_at`);--> statement-breakpoint
CREATE INDEX `automation_executions_root_idx` ON `automation_executions` (`root_execution_id`);--> statement-breakpoint
CREATE TABLE `automation_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`mode` text DEFAULT 'DISABLED' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`mutation_id` text DEFAULT '' NOT NULL,
	`permission_scope` text DEFAULT 'OWNER_ONLY' NOT NULL,
	`action_scope` text DEFAULT 'SIMULATOR_ONLY' NOT NULL,
	`approved_revision` integer,
	`approved_by` text,
	`approved_at` integer,
	`cooldown_ms` integer DEFAULT 60000 NOT NULL,
	`rate_limit_count` integer DEFAULT 10 NOT NULL,
	`rate_limit_window_ms` integer DEFAULT 3600000 NOT NULL,
	`max_chain_depth` integer DEFAULT 2 NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE INDEX `automation_rules_mode_updated_idx` ON `automation_rules` (`mode`,`updated_at`);--> statement-breakpoint
CREATE INDEX `automation_rules_archived_idx` ON `automation_rules` (`archived_at`);--> statement-breakpoint
CREATE TABLE `automation_triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text NOT NULL,
	`kind` text NOT NULL,
	`source_device_id` text,
	`source_pin_id` text,
	`comparator` text,
	`threshold_value` real,
	`hysteresis` real DEFAULT 0 NOT NULL,
	`hold_for_ms` integer DEFAULT 0 NOT NULL,
	`max_sample_age_ms` integer DEFAULT 30000 NOT NULL,
	`source_unit` text,
	`source_configuration_version` integer,
	`interval_ms` integer,
	`schedule_minute_utc` integer,
	`schedule_days_mask` integer,
	`schedule_timezone` text DEFAULT 'UTC' NOT NULL,
	`last_source_event_key` text,
	`last_observed_value` real,
	`condition_since_at` integer,
	`armed` integer DEFAULT true NOT NULL,
	`next_due_at` integer,
	`last_evaluated_at` integer,
	`last_fired_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `automation_rules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_triggers_rule_idx` ON `automation_triggers` (`rule_id`);--> statement-breakpoint
CREATE INDEX `automation_triggers_source_idx` ON `automation_triggers` (`source_device_id`,`source_pin_id`);--> statement-breakpoint
CREATE INDEX `automation_triggers_due_idx` ON `automation_triggers` (`kind`,`next_due_at`);--> statement-breakpoint
ALTER TABLE `devices` ADD `automation_armed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `hardware_test_runs` ADD `validated_configuration_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `hardware_test_runs` ADD `validated_firmware_version` text;--> statement-breakpoint
ALTER TABLE `gpio_commands` ADD `automation_rule_id` text REFERENCES automation_rules(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `gpio_commands` ADD `automation_rule_revision` integer;--> statement-breakpoint
ALTER TABLE `gpio_commands` ADD `automation_action_id` text REFERENCES automation_actions(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `gpio_commands` ADD `automation_execution_id` text REFERENCES automation_executions(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `gpio_commands_automation_rule_status_idx` ON `gpio_commands` (`automation_rule_id`,`status`);--> statement-breakpoint
CREATE INDEX `gpio_commands_automation_execution_idx` ON `gpio_commands` (`automation_execution_id`);
