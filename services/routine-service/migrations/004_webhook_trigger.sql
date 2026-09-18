-- Webhook trigger: an external system starts a routine by POSTing to a secret URL.
-- The token is the only credential, so it is unguessable (32 random bytes) and unique.
-- It survives switching to another trigger type, so switching back keeps the URL.
ALTER TABLE routines ADD COLUMN webhook_token text UNIQUE;
-- The JSON body of the call that started an execution, readable as {{trigger.body.…}}.
ALTER TABLE executions ADD COLUMN trigger_payload jsonb;
