-- Local inference removal: the local embedding provider/model and the local
-- file processors are gone. Knowledge bases wired to the seeded local
-- embedding model are demoted first — `embedding_model_id` has no ON DELETE
-- action, so the row cannot be dropped while a base still references it, and
-- the demoted status/error pair keeps the knowledge_base CHECK contract.
UPDATE `knowledge_base`
SET `embedding_model_id` = NULL,
    `dimensions` = NULL,
    `status` = 'failed',
    `error` = 'missing_embedding_model'
WHERE `embedding_model_id` = 'local-embedding::qwen3-embedding-0.6b';
--> statement-breakpoint
UPDATE `knowledge_base`
SET `file_processor_id` = NULL
WHERE `file_processor_id` IN ('local-document', 'local-paddleocr');
--> statement-breakpoint
DELETE FROM `user_model` WHERE `id` = 'local-embedding::qwen3-embedding-0.6b';
--> statement-breakpoint
DELETE FROM `user_provider` WHERE `provider_id` = 'local-embedding';
--> statement-breakpoint
-- Drop the local-model preference toggle and clear persisted defaults naming
-- the removed processors: resolveProcessorConfigByFeature throws on unknown
-- processor ids, so a stale default would break file processing at runtime.
DELETE FROM `preference` WHERE `key` = 'feature.local_model.hardware_acceleration.enabled';
--> statement-breakpoint
UPDATE `preference`
SET `value` = 'null'
WHERE `key` = 'feature.file_processing.default_image_to_text' AND `value` = '"local-paddleocr"';
--> statement-breakpoint
UPDATE `preference`
SET `value` = 'null'
WHERE `key` = 'feature.file_processing.default_document_to_markdown' AND `value` = '"local-document"';
--> statement-breakpoint
UPDATE `preference`
SET `value` = json_remove(`value`, '$."local-paddleocr"', '$."local-document"')
WHERE `key` = 'feature.file_processing.overrides' AND json_type(`value`) = 'object';
