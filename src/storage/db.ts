import type { Bindings } from "../env";
import type { ObjectKind } from "../domain/keys";

export type ObjectRow = {
  r2_key: string;
  kind: ObjectKind;
  etag: string;
  sha256: string | null;
  size: number;
  uploaded_at: string;
  state: string;
};

export type PackageRow = {
  package_name: string;
  created_at: string;
  updated_at: string;
};

export type VersionRow = {
  version_id: string;
  package_name: string;
  version_name: string;
  tags_json: string;
  retention_days: number | null;
  pinned: number;
  registered_at: string;
  updated_at: string;
  state: string;
};

export function now(): string {
  return new Date().toISOString();
}

export async function getObject(env: Bindings, key: string): Promise<ObjectRow | null> {
  return env.DB.prepare("SELECT * FROM objects WHERE r2_key = ?").bind(key).first<ObjectRow>();
}

export async function upsertObject(env: Bindings, object: {
  key: string;
  kind: ObjectKind;
  etag: string;
  sha256: string | null;
  size: number;
  state?: string;
}): Promise<void> {
  const timestamp = now();
  await env.DB.prepare(
    `INSERT INTO objects (r2_key, kind, etag, sha256, size, uploaded_at, state)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(r2_key) DO UPDATE SET etag = excluded.etag, sha256 = excluded.sha256,
       size = excluded.size, state = excluded.state`,
  ).bind(object.key, object.kind, object.etag, object.sha256, object.size, timestamp, object.state ?? "ready").run();
}

export async function getSetting(env: Bindings, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(env: Bindings, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(key, value, now()).run();
}

export async function bumpCacheGeneration(env: Bindings): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('worker_cache_generation', '1', ?)
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = excluded.updated_at`,
  ).bind(now()).run();
}

export async function getVersion(env: Bindings, packageName: string, versionName: string): Promise<VersionRow | null> {
  return env.DB.prepare(
    "SELECT * FROM artifact_versions WHERE package_name = ? AND version_name = ?",
  ).bind(packageName, versionName).first<VersionRow>();
}

export async function getVersionById(env: Bindings, versionId: string): Promise<VersionRow | null> {
  return env.DB.prepare("SELECT * FROM artifact_versions WHERE version_id = ?").bind(versionId).first<VersionRow>();
}

export function parseTags(value: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}
