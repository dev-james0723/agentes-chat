ALTER TABLE "run_tool_tokens" ADD COLUMN "effect_epoch_state" text;--> statement-breakpoint
ALTER TABLE "run_tool_tokens" ADD COLUMN "effect_calls" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "run_tool_tokens_one_open_effect_epoch" ON "run_tool_tokens" USING btree ("run_id") WHERE "run_tool_tokens"."effect_epoch_state" in ('open', 'closed_unknown');