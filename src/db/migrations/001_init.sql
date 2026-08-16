CREATE TABLE IF NOT EXISTS logs (
  timestamp  TIMESTAMPTZ NOT NULL,
  id         BIGINT GENERATED ALWAYS AS IDENTITY,
  level      TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  service    TEXT NOT NULL CHECK (length(service) > 0),
  message    TEXT NOT NULL CHECK (length(message) > 0),
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes) = 'object'),
  PRIMARY KEY (timestamp, id)
) PARTITION BY RANGE (timestamp);

CREATE TABLE IF NOT EXISTS logs_default PARTITION OF logs DEFAULT;
ALTER TABLE logs_default SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.01
);

CREATE INDEX IF NOT EXISTS logs_service_level_page_idx
  ON logs (service, level, timestamp DESC, id DESC);

-- Indexes for high-selectivity attribute keys are not declared here. They are
-- created at startup from HOT_ATTRIBUTE_KEYS (see ensureHotAttributeIndexes in
-- src/db/migrate.ts), because which attribute is worth indexing is a deployment
-- decision, not a schema constant.

CREATE TABLE IF NOT EXISTS logs_agg_1m (
  bucket_start TIMESTAMPTZ NOT NULL,
  service      TEXT NOT NULL,
  level        TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  count        BIGINT NOT NULL CHECK (count >= 0),
  PRIMARY KEY (bucket_start, service, level)
);

CREATE INDEX IF NOT EXISTS logs_agg_service_bucket_idx
  ON logs_agg_1m (service, bucket_start, level);
