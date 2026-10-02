-- Questions (docs/v2/services/notification-service.md §2, M3): "Ask me" human steps. A question has
-- 2–4 options; answering it completes the step waiting for it. An expired or cancelled step leaves
-- it `expired`.
ALTER TABLE notifications ADD COLUMN kind text NOT NULL DEFAULT 'info';   -- info | question
ALTER TABLE notifications ADD COLUMN options jsonb;                      -- [{ value, label }] for questions
ALTER TABLE notifications ADD COLUMN answer jsonb;                       -- { value, label, answeredAt }
ALTER TABLE notifications ADD COLUMN awaiting_action_id uuid UNIQUE;
ALTER TABLE notifications ADD COLUMN expires_at timestamptz;
ALTER TABLE notifications ADD COLUMN state text NOT NULL DEFAULT 'open'; -- open | answered | expired
ALTER TABLE notifications ADD COLUMN routine_id uuid;
