-- Version history (docs/v2/06-engine.md §7): every write that bumps routines.version stores the
-- definition it produced, in the same transaction. Restore = a normal update to an old definition.
CREATE TABLE routine_versions (
  routine_id  uuid        NOT NULL REFERENCES routines (id) ON DELETE CASCADE,
  version     integer     NOT NULL,
  definition  jsonb       NOT NULL,            -- name, description, trigger, actions, icon, color, active
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text        NOT NULL,            -- user id
  origin      text        NOT NULL,            -- create | edit | appearance | activate | deactivate | webhook | restore | backfill
  PRIMARY KEY (routine_id, version)
);

-- the version each run used
ALTER TABLE executions ADD COLUMN routine_version integer;

-- history starts with every routine's current definition
INSERT INTO routine_versions (routine_id, version, definition, created_at, created_by, origin)
SELECT id, version,
       jsonb_build_object('name', name, 'description', description, 'trigger', trigger, 'actions', actions,
                          'icon', icon, 'color', color, 'active', active),
       updated_at, owner_id::text, 'backfill'
  FROM routines;
