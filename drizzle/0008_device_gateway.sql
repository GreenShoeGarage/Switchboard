CREATE TABLE `device_gateway_rate_limits` (
	`bucket_key` text PRIMARY KEY NOT NULL,
	`window_started_at` integer NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `device_gateway_rate_limits_updated_idx` ON `device_gateway_rate_limits` (`updated_at`);