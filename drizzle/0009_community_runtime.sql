CREATE TABLE `installation_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`public_base_url` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `operator_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `operator_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operator_sessions_token_idx` ON `operator_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `operator_sessions_user_idx` ON `operator_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `operator_sessions_expiry_idx` ON `operator_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `operator_users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'OWNER' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`disabled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operator_users_email_idx` ON `operator_users` (`email`);