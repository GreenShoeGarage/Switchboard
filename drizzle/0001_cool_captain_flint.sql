CREATE TABLE `device_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`enrollment_token_id` text NOT NULL,
	`secret_hash` text NOT NULL,
	`secret_prefix` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`enrollment_token_id`) REFERENCES `enrollment_tokens`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_credentials_secret_hash_idx` ON `device_credentials` (`secret_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_credentials_enrollment_token_idx` ON `device_credentials` (`enrollment_token_id`);--> statement-breakpoint
CREATE INDEX `device_credentials_device_idx` ON `device_credentials` (`device_id`);--> statement-breakpoint
CREATE TABLE `device_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`state` text DEFAULT 'CONNECTED' NOT NULL,
	`connected_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_heartbeat_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`disconnected_at` integer,
	`close_code` integer,
	`close_reason` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credential_id`) REFERENCES `device_credentials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `device_sessions_device_time_idx` ON `device_sessions` (`device_id`,`connected_at`);--> statement-breakpoint
CREATE INDEX `device_sessions_state_heartbeat_idx` ON `device_sessions` (`state`,`last_heartbeat_at`);--> statement-breakpoint
CREATE TABLE `device_state_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` text NOT NULL,
	`session_id` text,
	`sequence` integer NOT NULL,
	`payload_json` text NOT NULL,
	`recorded_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `device_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_state_snapshots_session_sequence_idx` ON `device_state_snapshots` (`session_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `device_state_snapshots_device_time_idx` ON `device_state_snapshots` (`device_id`,`recorded_at`);--> statement-breakpoint
CREATE TABLE `enrollment_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`board_profile_id` text NOT NULL,
	`device_name` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`used_at` integer,
	`used_by_device_id` text,
	`revoked_at` integer,
	FOREIGN KEY (`used_by_device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `enrollment_tokens_hash_idx` ON `enrollment_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `enrollment_tokens_expiry_idx` ON `enrollment_tokens` (`expires_at`);