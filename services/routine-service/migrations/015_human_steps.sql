-- Human steps (docs/v2/06-engine.md §5): a step a person does waits as AWAITING_USER with the item
-- the domain created (`awaiting`), since `accepted_at`; with a timeout it expires at `deadline_at`.
ALTER TABLE execution_actions ADD COLUMN awaiting jsonb;
ALTER TABLE execution_actions ADD COLUMN accepted_at timestamptz;
ALTER TABLE execution_actions ADD COLUMN deadline_at timestamptz;
ALTER TABLE execution_actions ADD COLUMN timeout jsonb;               -- { after: ISO 8601 duration, then: skip | fail }
CREATE INDEX execution_actions_deadline_idx ON execution_actions (deadline_at) WHERE status = 'AWAITING_USER' AND deadline_at IS NOT NULL;

-- Why a run ended without a failed step: CANCELLED when the user cancelled it (services/routine-service.md §3).
ALTER TABLE executions ADD COLUMN error_code text;
