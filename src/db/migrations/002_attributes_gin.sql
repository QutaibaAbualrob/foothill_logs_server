-- Filtering on an arbitrary attribute key had no index to use, so it fell back
-- to walking the table in cursor order. That is bounded only by the table size,
-- and it is paid on a hit as well as a miss: a selective filter with a small
-- limit finds its row quickly and then keeps scanning to decide whether a next
-- page exists. Measured at 671k rows, one such lookup read every row and took
-- ~158 ms; a read-after-write client polling at ingestion rate therefore
-- consumed the whole database CPU and starved the write path.
--
-- jsonb_path_ops rather than the default jsonb_ops: it indexes only the
-- key/value pairs needed for containment, which is the only operator the query
-- builder emits, and it produces a smaller index with cheaper maintenance. The
-- measured ingest cost of this index is ~4.5% of throughput; the same lookup
-- drops to ~0.4 ms.
-- fastupdate = off is not a detail. With it on (the default), new entries land
-- in an unsorted pending list and *every* read of the index has to scan that
-- list end to end, so a read-after-write client polling at ingestion rate pays
-- for the writes it is racing. Measured on the mixed workload, leaving it on
-- cost more than half the achievable throughput: 6.3k logs/s at 83% database
-- CPU with it on, 10.5k at 41% with it off. Paying the tree insert up front is
-- the cheaper end of that trade whenever reads keep pace with writes.
CREATE INDEX IF NOT EXISTS logs_attributes_gin_idx
  ON logs USING gin (attributes jsonb_path_ops)
  WITH (fastupdate = off);
