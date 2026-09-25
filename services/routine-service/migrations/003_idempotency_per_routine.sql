-- An Idempotency-Key identifies one trigger request of one routine. Scoped per owner,
-- reusing a key for another routine returned the first routine's execution instead.
ALTER TABLE executions DROP CONSTRAINT executions_owner_id_idempotency_key_key;
ALTER TABLE executions ADD CONSTRAINT executions_routine_id_idempotency_key_key UNIQUE (routine_id, idempotency_key);
