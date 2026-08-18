import { Hono } from "hono";
import type { AppEnv } from "../env";
import { AppError } from "../domain/errors";
import { emitAudit } from "../observability";
import { bumpCacheGeneration, getObject, getVersion, now, parseTags, type VersionRow } from "../storage/db";
import { requireRole } from "../middleware/auth";

export const versionRoutes = new Hono<AppEnv>();

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

export function validatePackageName(value: string): string {
  if (!NAME_PATTERN.test(value)) {
    throw new AppError("invalid_package_name", "packageName must be a URL-safe single path segment", 422);
  }
  return value;
}

export function validateVersionName(value: string): string {
  if (!NAME_PATTERN.test(value)) {
    throw new AppError("invalid_version_name", "versionName must be a URL-safe single path segment", 422);
  }
  return value;
}

export function validateTags(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("invalid_tags", "tags must be an object", 422);
  const entries = Object.entries(value);
  if (entries.length > 64) throw new AppError("invalid_tags", "A version may contain at most 64 tags", 422);
  const tags: Record<string, string> = {};
  for (const [key, tagValue] of entries) {
    if (!/^[A-Za-z0-9._~-]{1,64}$/.test(key) || typeof tagValue !== "string" || tagValue.length > 256) {
      throw new AppError("invalid_tags", "Tag keys and values have invalid lengths or characters", 422);
    }
    tags[key] = tagValue;
  }
  return tags;
}

export function validateNonNegativeInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new AppError(`invalid_${field}`, `${field} must be a non-negative integer`, 422);
  return Number(value);
}

async function assertMembers(env: AppEnv["Bindings"], values: unknown): Promise<string[]> {
  if (!Array.isArray(values) || values.length === 0 || values.length > 10_000 || values.some((value) => typeof value !== "string")) {
    throw new AppError("invalid_members", "narinfoKeys must contain between 1 and 10000 strings", 422);
  }
  const keys = [...new Set(values as string[])];
  for (const key of keys) {
    if (!/^[A-Za-z0-9._~-]+\.narinfo$/.test(key)) throw new AppError("invalid_members", `Invalid narinfo key: ${key}`, 422);
    const object = await getObject(env, key);
    const ref = await env.DB.prepare("SELECT narinfo_key FROM narinfo_refs WHERE narinfo_key = ?").bind(key).first();
    if (!object || object.state !== "ready" || !ref) throw new AppError("missing_narinfo", `The narinfo is not indexed: ${key}`, 424);
  }
  return keys;
}

export function serializeVersion(row: VersionRow): Record<string, unknown> {
  return {
    versionId: row.version_id,
    packageName: row.package_name,
    versionName: row.version_name,
    tags: parseTags(row.tags_json),
    retentionDays: row.retention_days,
    pinned: Boolean(row.pinned),
    registeredAt: row.registered_at,
    updatedAt: row.updated_at,
    state: row.state,
  };
}

versionRoutes.put("/api/packages/:packageName/versions/:versionName", requireRole("write"), async (c) => {
  const packageName = validatePackageName(c.req.param("packageName"));
  const versionName = validateVersionName(c.req.param("versionName"));
  const body = await c.req.json<Record<string, unknown>>().catch(() => { throw new AppError("invalid_json", "The request body must be JSON", 400); });
  const members = await assertMembers(c.env, body.narinfoKeys);
  const tags = validateTags(body.tags);
  const retentionDays = validateNonNegativeInteger(body.retentionDays, "retention_days");
  const timestamp = now();
  const existing = await getVersion(c.env, packageName, versionName);
  if (existing?.state === "deleting") throw new AppError("version_deleting", "The version is currently being deleted", 409);
  const versionId = existing?.version_id ?? crypto.randomUUID();
  const registeredAt = existing?.registered_at ?? timestamp;

  await c.env.DB.prepare(
    `INSERT INTO artifact_packages (package_name, created_at, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(package_name) DO UPDATE SET updated_at = excluded.updated_at`,
  ).bind(packageName, timestamp, timestamp).run();
  await c.env.DB.prepare(
    `INSERT INTO artifact_versions (version_id, package_name, version_name, tags_json, retention_days, pinned, registered_at, updated_at, state)
     VALUES (?, ?, ?, ?, ?, COALESCE((SELECT pinned FROM artifact_versions WHERE version_id = ?), 0), ?, ?, 'registering')
     ON CONFLICT(package_name, version_name) DO UPDATE SET tags_json = excluded.tags_json,
       retention_days = excluded.retention_days, updated_at = excluded.updated_at,
       state = 'registering'`,
  ).bind(versionId, packageName, versionName, JSON.stringify(tags), retentionDays, versionId, registeredAt, timestamp).run();

  await c.env.DB.prepare("DELETE FROM artifact_version_members WHERE version_id = ?").bind(versionId).run();
  for (let offset = 0; offset < members.length; offset += 100) {
    const statements = members.slice(offset, offset + 100).map((key) => c.env.DB.prepare(
      "INSERT INTO artifact_version_members (version_id, narinfo_key) VALUES (?, ?)",
    ).bind(versionId, key));
    await c.env.DB.batch(statements);
  }
  await c.env.DB.prepare("UPDATE artifact_versions SET state = 'active', updated_at = ? WHERE version_id = ?")
    .bind(timestamp, versionId).run();
  await bumpCacheGeneration(c.env);
  emitAudit(c.env, existing ? "version_update" : "version_create", c.get("role"), `${packageName}/${versionName}`, { versionId, members: members.length, tags });
  return c.json({ versionId, packageName, versionName, tags, narinfoKeys: members, retentionDays, pinned: Boolean(existing?.pinned), registeredAt }, existing ? 200 : 201);
});
