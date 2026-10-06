-- Tombstones (trigger-service.md §4, version rule): a routine whose trigger is no longer an event, or
-- that was deleted, keeps a row without event_type – so an older RoutineSaved arriving late cannot
-- bring its subscription back. Matching only reads rows with an event type.
ALTER TABLE subscriptions ALTER COLUMN event_type DROP NOT NULL;
