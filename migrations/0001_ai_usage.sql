-- The AI cost ledger. Holds no prompt, no completion, and no user identity:
-- subject_id is an opaque attribution key you choose (tenant, workspace, document).
CREATE TABLE `ai_usage` (
	`id` text PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))) NOT NULL,
	`created_at` integer NOT NULL,
	`operation` text NOT NULL,
	`model` text NOT NULL,
	`provider` text NOT NULL,
	`subject_id` text,
	`attempt` integer NOT NULL,
	`outcome` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`units_in` integer NOT NULL,
	`units_out` integer NOT NULL,
	`units_source` text NOT NULL,
	`cost_micros` integer NOT NULL,
	`price_version` text NOT NULL
);
-- The prune scans by created_at; per-subject cost groups by subject_id within a window.
CREATE INDEX `ai_usage_created_at_idx` ON `ai_usage` (`created_at`);
CREATE INDEX `ai_usage_subject_id_idx` ON `ai_usage` (`subject_id`, `created_at`);

-- The permanent roll-up. ai_usage is pruned; this is not.
CREATE TABLE `ai_usage_daily` (
	`day` integer NOT NULL,
	`operation` text NOT NULL,
	`model` text NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`errors` integer DEFAULT 0 NOT NULL,
	`units_in` integer DEFAULT 0 NOT NULL,
	`units_out` integer DEFAULT 0 NOT NULL,
	`cost_micros` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `operation`, `model`)
);

-- Month-to-date spend for the cap, and the once-a-month soft-cap latch.
CREATE TABLE `ai_spend` (
	`month_start` integer PRIMARY KEY NOT NULL,
	`cost_micros` integer DEFAULT 0 NOT NULL,
	`soft_notified_at` integer
);
