-- Squashed baseline for the current package/version schema.
-- Existing databases must complete the pre-squash migration chain first.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS artifact_packages (
  package_name TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS objects (
  r2_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('nar', 'narinfo', 'cache-info')),
  etag TEXT NOT NULL,
  sha256 TEXT,
  size INTEGER NOT NULL CHECK (size >= 0),
  uploaded_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'orphaned', 'deleting', 'deleted'))
);

CREATE INDEX IF NOT EXISTS idx_objects_kind_uploaded
  ON objects(kind, uploaded_at);

CREATE TABLE IF NOT EXISTS narinfo_refs (
  narinfo_key TEXT PRIMARY KEY REFERENCES objects(r2_key) ON DELETE CASCADE,
  nar_key TEXT NOT NULL REFERENCES objects(r2_key),
  store_path TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_narinfo_refs_nar ON narinfo_refs(nar_key);

CREATE TABLE IF NOT EXISTS artifact_versions (
  version_id TEXT PRIMARY KEY,
  package_name TEXT NOT NULL REFERENCES artifact_packages(package_name),
  version_name TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '{}',
  retention_days INTEGER,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  registered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('registering', 'active', 'deleting', 'deleted')),
  UNIQUE(package_name, version_name)
);

CREATE INDEX IF NOT EXISTS idx_artifact_versions_package_registered
  ON artifact_versions(package_name, registered_at DESC);

CREATE TABLE IF NOT EXISTS artifact_version_members (
  version_id TEXT NOT NULL REFERENCES artifact_versions(version_id) ON DELETE CASCADE,
  narinfo_key TEXT NOT NULL REFERENCES narinfo_refs(narinfo_key),
  PRIMARY KEY (version_id, narinfo_key)
);

CREATE INDEX IF NOT EXISTS idx_artifact_version_members_narinfo
  ON artifact_version_members(narinfo_key);

CREATE TABLE IF NOT EXISTS gc_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  conditions_json TEXT NOT NULL DEFAULT '[]',
  group_by_json TEXT NOT NULL DEFAULT '[]',
  last_n INTEGER CHECK (last_n IS NULL OR last_n >= 0),
  duration_days INTEGER CHECK (duration_days IS NULL OR duration_days >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gc_policies_updated
  ON gc_policies(updated_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('gc', 'delete_version')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'failed', 'completed')),
  target_version_id TEXT,
  cursor INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_updated
  ON jobs(status, updated_at);

CREATE TABLE IF NOT EXISTS write_claims (
  r2_key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  target TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created
  ON audit_log(created_at DESC);

INSERT OR IGNORE INTO gc_policies (
  name,
  conditions_json,
  group_by_json,
  last_n,
  duration_days,
  created_at,
  updated_at
) VALUES (
  'default-package-tags',
  '[]',
  '["pkg_name","pkg_tags"]',
  3,
  NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
