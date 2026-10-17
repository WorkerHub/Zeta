-- 1. notebook_runs.seq: a run's number within its notebook (#1, #2, …). It never changes, and
--    numbers are not reused once a run is deleted or pruned, so the list may have gaps.
-- 2. notebooks.last_run_seq: the notebook's last handed-out number. New runs take the next one
--    (see src/lib/runs.ts); keeping it on the notebook stops deleting the newest run or clearing the
--    list from handing a number out again.
-- 3. Existing runs are numbered from 1 per notebook, oldest first (executed_at, then id).
-- 4. The unique (notebook_id, seq) index rules out duplicate numbers and serves the run list and
--    the per-notebook pruning, which now order by seq; it replaces idx_notebook_runs_notebook.
-- NOTE: only for databases created from these migrations. Databases initialised through
-- POST /api/setup (the documented path, including TABLE_PREFIX deployments) get the same changes
-- by re-running POST /api/setup after deploying.
ALTER TABLE notebook_runs ADD COLUMN seq INTEGER;
ALTER TABLE notebooks ADD COLUMN last_run_seq INTEGER NOT NULL DEFAULT 0;

UPDATE notebook_runs SET seq = numbered.seq
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY notebook_id ORDER BY executed_at, id) AS seq FROM notebook_runs
) AS numbered
WHERE notebook_runs.id = numbered.id;

UPDATE notebooks SET last_run_seq = (
  SELECT COALESCE(MAX(seq), 0) FROM notebook_runs WHERE notebook_runs.notebook_id = notebooks.id
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notebook_runs_seq ON notebook_runs(notebook_id, seq);
DROP INDEX IF EXISTS idx_notebook_runs_notebook;
