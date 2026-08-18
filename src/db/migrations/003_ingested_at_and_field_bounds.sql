-- Ingest time, recorded separately from the client-supplied event timestamp, so
-- that ingest lag is measurable and a backdated batch is detectable at all.
--
-- The two statements are deliberate and must not be collapsed into
-- ADD COLUMN ... NOT NULL DEFAULT clock_timestamp(). clock_timestamp() is
-- VOLATILE, and PostgreSQL can only store a default in the catalog and skip the
-- table rewrite when that default is non-volatile; with a volatile one it
-- rewrites every partition under ACCESS EXCLUSIVE. migrate() runs at startup
-- before the service accepts traffic, so that would turn an ordinary restart
-- into an outage proportional to table size. Adding the column nullable and
-- then setting the default is catalog-only at any table size.
--
-- The column stays nullable on purpose: rows written before this migration have
-- no ingest time, and NULL says that honestly. A backfilled value would be a
-- fabricated measurement.
ALTER TABLE logs ADD COLUMN IF NOT EXISTS ingested_at TIMESTAMPTZ;
ALTER TABLE logs ALTER COLUMN ingested_at SET DEFAULT clock_timestamp();

-- service and message carried a floor (length > 0) and no ceiling, so a single
-- multi-megabyte field was accepted and TOASTed; only the 4 MB body limit
-- bounded it, and that bounds the whole request rather than one field.
--
-- These are backstops, not the primary gate: validateEntry rejects the same
-- lengths at the edge with a per-entry reason, which is the difference between
-- one bad entry being reported and a whole batch failing. The two agree in the
-- safe direction because JavaScript's UTF-16 .length is never smaller than
-- PostgreSQL's character length() -- a non-BMP character counts 2 in JS and 1
-- here -- so anything the validator accepts satisfies these constraints.
--
-- NOT VALID keeps this catalog-only as well: the constraints are enforced for
-- every new row immediately, and existing rows are not scanned. Nothing in this
-- table can violate them anyway, since the edge has never accepted a longer
-- field than the body limit allowed.
ALTER TABLE logs ADD CONSTRAINT logs_service_length_chk
  CHECK (length(service) <= 255) NOT VALID;
ALTER TABLE logs ADD CONSTRAINT logs_message_length_chk
  CHECK (length(message) <= 65536) NOT VALID;
