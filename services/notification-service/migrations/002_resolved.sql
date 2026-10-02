-- A failure notification is resolved once its run was resumed ("Retry from here") – ExecutionResumed.
ALTER TABLE notifications ADD COLUMN resolved_at timestamptz;
