-- Lists group tasks. Every user has exactly one default list ("Todo") that
-- cannot be deleted; a task without an explicit list lands there.
CREATE TABLE task_lists (
  id           uuid PRIMARY KEY,
  owner_id     uuid        NOT NULL,
  name         text        NOT NULL,
  description  text        NOT NULL DEFAULT '',
  color        text        NOT NULL DEFAULT 'sky',
  is_default   boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX task_lists_one_default_idx ON task_lists (owner_id) WHERE is_default;
CREATE INDEX task_lists_owner_idx ON task_lists (owner_id, created_at);

-- existing tasks move into their owner's new default list
INSERT INTO task_lists (id, owner_id, name, is_default)
  SELECT gen_random_uuid(), owner_id, 'Todo', true FROM (SELECT DISTINCT owner_id FROM tasks) owners;

ALTER TABLE tasks ADD COLUMN list_id uuid REFERENCES task_lists (id) ON DELETE CASCADE;
UPDATE tasks SET list_id = task_lists.id FROM task_lists WHERE task_lists.owner_id = tasks.owner_id AND task_lists.is_default;
ALTER TABLE tasks ALTER COLUMN list_id SET NOT NULL;
CREATE INDEX tasks_list_idx ON tasks (list_id);
