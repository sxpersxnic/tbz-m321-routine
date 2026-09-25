-- The symbol of a list, chosen by the user; NULL = the client's default (a checklist).
ALTER TABLE task_lists ADD COLUMN icon text;
