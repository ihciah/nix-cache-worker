-- Persistent scan and cleanup state for bounded, resumable background work.
CREATE TABLE IF NOT EXISTS gc_scan_versions (
  job_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, version_id)
);

CREATE INDEX IF NOT EXISTS idx_gc_scan_versions_job_version
  ON gc_scan_versions(job_id, version_id);

CREATE TABLE IF NOT EXISTS gc_policy_matches (
  job_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  policy_id INTEGER NOT NULL,
  group_key TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  keep_count INTEGER NOT NULL,
  PRIMARY KEY (job_id, version_id, policy_id)
);

CREATE INDEX IF NOT EXISTS idx_gc_policy_matches_job_group
  ON gc_policy_matches(job_id, policy_id, group_key, registered_at DESC);

CREATE TABLE IF NOT EXISTS delete_job_nars (
  job_id TEXT NOT NULL,
  nar_key TEXT NOT NULL,
  PRIMARY KEY (job_id, nar_key)
);

CREATE INDEX IF NOT EXISTS idx_delete_job_nars_job
  ON delete_job_nars(job_id, nar_key);

CREATE TABLE IF NOT EXISTS delete_job_narinfos (
  job_id TEXT NOT NULL,
  narinfo_key TEXT NOT NULL,
  PRIMARY KEY (job_id, narinfo_key)
);

CREATE INDEX IF NOT EXISTS idx_delete_job_narinfos_job
  ON delete_job_narinfos(job_id, narinfo_key);

-- Preserve the oldest active deletion job if a pre-hardening database already
-- contains duplicate jobs for one version.
UPDATE jobs
SET status = 'completed', last_error = 'superseded duplicate deletion job', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE rowid IN (
  SELECT rowid FROM (
    SELECT rowid,
           ROW_NUMBER() OVER (PARTITION BY target_version_id ORDER BY created_at ASC, id ASC) AS position
    FROM jobs
    WHERE type = 'delete_version'
      AND target_version_id IS NOT NULL
      AND status IN ('queued', 'running', 'failed')
  ) ranked
  WHERE ranked.position > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_delete_target
  ON jobs(target_version_id)
  WHERE type = 'delete_version'
    AND target_version_id IS NOT NULL
    AND status IN ('queued', 'running', 'failed');
