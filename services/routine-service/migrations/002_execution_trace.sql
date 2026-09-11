-- Link every execution to the distributed trace that started it (Jaeger deep link).
ALTER TABLE executions ADD COLUMN trace_id text;
