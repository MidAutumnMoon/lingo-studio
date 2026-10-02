-- CherryAI keyless default-model funnel removal: the managed 'cherryai' and
-- 'cherryai-subscription' (Cherry Cloud) providers, their seeded default model,
-- and the preferences pointing at it are gone from the codebase. Fresh installs
-- start with no default model, so existing rows that still reference those
-- providers must not survive a migrate-forward.
--
-- user_model children are deleted before user_provider: user_model.provider_id
-- has an ON DELETE CASCADE foreign key, but migrations run with foreign_keys=OFF
-- (applyMigrations.ts), so the ordering is explicit rather than relied upon.
-- Columns with ON DELETE SET NULL (assistant.model_id, message.model_id,
-- agent_session_message.model_id, agent.model, knowledge_base.rerank_model_id)
-- are nulled manually for the same reason — the cascade action never fires with
-- enforcement off, and applyMigrations logs any dangling reference the migration
-- leaves behind (PRAGMA foreign_key_check).
--
-- knowledge_base.embedding_model_id has NO ON DELETE action and participates in
-- a status CHECK (mirrors 0026's local-embedding handling): bases wired to a
-- removed model are demoted to failed/missing_embedding_model with their
-- dimensions cleared, then the model row can be deleted.
--
-- preference values are stored as JSON: the seeded default was written as the
-- JSON string "cherryai::qwen", so both the quoted form and any
-- cherryai-subscription value are covered by the quoted-LIKE match and reset to
-- JSON null — which is exactly the fresh-install state for these keys
-- ('chat.default_model_id' / 'feature.translate.model_id' default to null).
--
-- pin rows are polymorphic (no FK), so model pins referencing the removed models
-- are deleted explicitly. The on-disk OAuth credential file
-- ({userData}/Credentials/cherry-account.json) cannot be touched from SQL and
-- is collected by the legacy cache-cleanup plan (legacyV1.ts) instead.
UPDATE `assistant`
SET `model_id` = NULL
WHERE `model_id` LIKE 'cherryai::%' OR `model_id` LIKE 'cherryai-subscription::%';--> statement-breakpoint
UPDATE `message`
SET `model_id` = NULL
WHERE `model_id` LIKE 'cherryai::%' OR `model_id` LIKE 'cherryai-subscription::%';--> statement-breakpoint
UPDATE `agent_session_message`
SET `model_id` = NULL
WHERE `model_id` LIKE 'cherryai::%' OR `model_id` LIKE 'cherryai-subscription::%';--> statement-breakpoint
UPDATE `agent`
SET `model` = NULL
WHERE `model` LIKE 'cherryai::%' OR `model` LIKE 'cherryai-subscription::%';--> statement-breakpoint
UPDATE `agent`
SET `plan_model` = NULL
WHERE `plan_model` LIKE 'cherryai::%' OR `plan_model` LIKE 'cherryai-subscription::%';--> statement-breakpoint
UPDATE `agent`
SET `small_model` = NULL
WHERE `small_model` LIKE 'cherryai::%' OR `small_model` LIKE 'cherryai-subscription::%';--> statement-breakpoint
UPDATE `knowledge_base`
SET `embedding_model_id` = NULL,
    `dimensions` = NULL,
    `status` = 'failed',
    `error` = 'missing_embedding_model'
WHERE `embedding_model_id` LIKE 'cherryai::%' OR `embedding_model_id` LIKE 'cherryai-subscription::%';--> statement-breakpoint
UPDATE `knowledge_base`
SET `rerank_model_id` = NULL
WHERE `rerank_model_id` LIKE 'cherryai::%' OR `rerank_model_id` LIKE 'cherryai-subscription::%';--> statement-breakpoint
DELETE FROM `pin`
WHERE `entity_type` = 'model'
  AND (`entity_id` LIKE 'cherryai::%' OR `entity_id` LIKE 'cherryai-subscription::%');--> statement-breakpoint
UPDATE `preference`
SET `value` = 'null'
WHERE `scope` = 'default'
  AND `key` IN ('chat.default_model_id', 'feature.translate.model_id')
  AND (`value` LIKE '"cherryai::%"' OR `value` LIKE '"cherryai-subscription::%"');--> statement-breakpoint
DELETE FROM `user_model`
WHERE `provider_id` IN ('cherryai', 'cherryai-subscription');--> statement-breakpoint
DELETE FROM `user_provider`
WHERE `provider_id` IN ('cherryai', 'cherryai-subscription');
