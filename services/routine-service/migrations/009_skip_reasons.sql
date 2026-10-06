-- Why a step was skipped: its condition didn't hold, an earlier step failed, it expired, the user
-- skipped it, or a test run left it out (docs/v2/06-engine.md §6, §13). Resume only reruns steps
-- skipped because of the failure, so the two v1 cases are told apart here.
ALTER TABLE execution_actions ADD COLUMN skip_reason text;
UPDATE execution_actions SET skip_reason = 'failure' WHERE status = 'SKIPPED' AND run_if IS NULL;
UPDATE execution_actions SET skip_reason = 'condition' WHERE status = 'SKIPPED' AND run_if IS NOT NULL;
