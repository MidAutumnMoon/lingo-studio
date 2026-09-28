-- Prompts feature removal: the prompt library (settings page, quick-phrases composer
-- tool, assistant/agent prompt bindings, v1 quick-phrase migration) is gone. The tables
-- have no readers left, so drop them; stored phrases are intentionally discarded.
-- prompt_binding is dropped first: its promptId foreign key references prompt.id.
DROP TABLE `prompt_binding`;--> statement-breakpoint
DROP TABLE `prompt`;
