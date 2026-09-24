-- Feishu channel removal: the @larksuiteoapi/node-sdk adapter and the 'feishu'
-- channel type are gone. Existing rows would be rejected by the zod boundary and
-- could never load an adapter again. agent_channel_session and agent_channel_task
-- rows cascade via their ON DELETE cascade foreign keys.
DELETE FROM `agent_channel` WHERE `type` = 'feishu';
