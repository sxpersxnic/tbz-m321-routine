-- Why an action failed, as one of the codes of docs/v2/05-messaging.md §6 (NULL for rows
-- that failed before v2 and for actions that did not fail).
ALTER TABLE execution_actions ADD COLUMN error_code text;
