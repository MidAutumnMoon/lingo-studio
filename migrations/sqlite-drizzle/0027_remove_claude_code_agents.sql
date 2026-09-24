-- Claude Code runtime removal: the claude-code agent driver (and with it the
-- claude-code provider and the builtin Cherry Assistant / Cherry Support agents) is
-- gone. Existing 'claude-code' agent rows would be rejected by the zod boundary and
-- could never load a driver again, so delete them and their sessions.
-- agent_session rows are deleted first: agent_session.agent_id is ON DELETE SET NULL,
-- so dropping the agents alone would strand their sessions as agent-less rows.
-- agent_session_message and agent_channel_session rows cascade via their ON DELETE
-- cascade foreign keys; agent_mcp_server / agent_knowledge_base / agent_skill junctions
-- cascade with the agent row; agent_channel rows bound to a removed agent are set null.
DELETE FROM `agent_session` WHERE `agent_id` IN (SELECT `id` FROM `agent` WHERE `type` = 'claude-code');
--> statement-breakpoint
DELETE FROM `agent` WHERE `type` = 'claude-code';
--> statement-breakpoint
-- Same reasoning for the seeded claude-code provider and its model rows.
DELETE FROM `user_model` WHERE `provider_id` = 'claude-code';
--> statement-breakpoint
DELETE FROM `user_provider` WHERE `provider_id` = 'claude-code';
