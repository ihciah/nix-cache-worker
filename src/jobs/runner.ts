import type { Bindings } from "../env";
import { AppError } from "../domain/errors";
import {
  effectiveRetentionDays,
  groupKey,
  matchingPolicies,
  policyGroupBy,
  type PolicyRow,
} from "../domain/policy";
import { emitAudit } from "../observability";
import { claimObjectWrite, releaseObjectWrite } from "../storage/r2";
import { bumpCacheGeneration, getSetting, now, type VersionRow } from "../storage/db";
import { createDeletionJob, findActiveDeletionJob, touchJob } from "./jobs";

const BATCH_SIZE = 500;
const GC_PAGE_SIZE = 200;
const NAR_CLEANUP_BATCH_SIZE = 100;

type MemberRow = { narinfo_key: string; nar_key: string | null };
type GcPayload = { phase?: "protect" | "evaluate"; lastVersionId?: string; policySnapshot?: PolicyRow[] };
type DeletePayload = { phase?: "members" | "cleanup_nars"; automaticGc?: boolean; reason?: string };

async function getPolicies(env: Bindings): Promise<PolicyRow[]> {
  const result = await env.DB.prepare("SELECT * FROM gc_policies ORDER BY id").all<PolicyRow>();
  return result.results;
}

async function defaultRetention(env: Bindings): Promise<number> {
  const configured = await getSetting(env, "default_retention_days");
  const value = Number(configured ?? env.DEFAULT_RETENTION_DAYS ?? "7");
  return Number.isSafeInteger(value) && value >= 0 ? value : 7;
}

function parsePayload<T>(value: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as T : fallback;
  } catch {
    return fallback;
  }
}

async function updateJob(env: Bindings, jobId: string, payload: Record<string, unknown>, status: "queued" | "running" | "completed", cursor = 0): Promise<void> {
  await env.DB.prepare("UPDATE jobs SET status = ?, cursor = ?, payload_json = ?, updated_at = ? WHERE id = ?")
    .bind(status, cursor, JSON.stringify(payload), now(), jobId).run();
}

async function getGcPage(env: Bindings, lastVersionId: string): Promise<VersionRow[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM artifact_versions
     WHERE state = 'active' AND version_id > ?
     ORDER BY version_id LIMIT ?`,
  ).bind(lastVersionId, GC_PAGE_SIZE).all<VersionRow>();
  return result.results;
}

async function recordGcPage(env: Bindings, jobId: string, versions: VersionRow[], policies: PolicyRow[]): Promise<void> {
  const statements = [];
  for (const row of versions) {
    statements.push(env.DB.prepare(
      "INSERT OR REPLACE INTO gc_scan_versions (job_id, version_id, updated_at) VALUES (?, ?, ?)",
    ).bind(jobId, row.version_id, row.updated_at));
    for (const policy of matchingPolicies(row, policies)) {
      const fields = policyGroupBy(policy);
      if ((policy.last_n ?? 0) <= 0 || !fields) continue;
      statements.push(env.DB.prepare(
        `INSERT OR REPLACE INTO gc_policy_matches
         (job_id, version_id, policy_id, group_key, registered_at, keep_count) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(jobId, row.version_id, policy.id, groupKey(row, fields), row.registered_at, policy.last_n));
    }
  }
  for (let offset = 0; offset < statements.length; offset += 100) {
    await env.DB.batch(statements.slice(offset, offset + 100));
  }
}

async function pruneGcMatches(env: Bindings, jobId: string): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM gc_policy_matches
     WHERE job_id = ? AND rowid IN (
       SELECT rowid FROM (
         SELECT m.rowid,
                ROW_NUMBER() OVER (
                  PARTITION BY m.policy_id, m.group_key
                  ORDER BY m.registered_at DESC, m.version_id DESC
                ) AS position,
                m.keep_count
         FROM gc_policy_matches m
         WHERE m.job_id = ?
       ) ranked
       WHERE ranked.position > ranked.keep_count
     )`,
  ).bind(jobId, jobId).run();
}

async function protectedVersionIds(env: Bindings, jobId: string, versions: VersionRow[]): Promise<Set<string>> {
  if (!versions.length) return new Set();
  const placeholders = versions.map(() => "?").join(",");
  const result = await env.DB.prepare(
    `SELECT DISTINCT version_id FROM gc_policy_matches
     WHERE job_id = ? AND version_id IN (${placeholders})`,
  ).bind(jobId, ...versions.map((row) => row.version_id)).all<{ version_id: string }>();
  return new Set(result.results.map((row) => row.version_id));
}

async function gcSnapshots(env: Bindings, jobId: string, versions: VersionRow[]): Promise<Map<string, string>> {
  if (!versions.length) return new Map();
  const placeholders = versions.map(() => "?").join(",");
  const result = await env.DB.prepare(
    `SELECT version_id, updated_at FROM gc_scan_versions
     WHERE job_id = ? AND version_id IN (${placeholders})`,
  ).bind(jobId, ...versions.map((row) => row.version_id)).all<{ version_id: string; updated_at: string }>();
  return new Map(result.results.map((row) => [row.version_id, row.updated_at]));
}

async function completeGc(env: Bindings, jobId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM gc_policy_matches WHERE job_id = ?").bind(jobId),
    env.DB.prepare("DELETE FROM gc_scan_versions WHERE job_id = ?").bind(jobId),
    env.DB.prepare("UPDATE jobs SET status = 'completed', updated_at = ? WHERE id = ?").bind(now(), jobId),
  ]);
}

export async function processGc(env: Bindings, jobId: string): Promise<void> {
  const job = await env.DB.prepare("SELECT payload_json FROM jobs WHERE id = ?").bind(jobId).first<{ payload_json: string }>();
  if (!job) throw new AppError("invalid_job", "The GC job does not exist", 500);
  const payload = parsePayload<GcPayload>(job.payload_json, { phase: "protect", lastVersionId: "" });
  const policies = payload.policySnapshot ?? await getPolicies(env);
  await touchJob(env, jobId);

  if ((payload.phase ?? "protect") === "protect") {
    const versions = await getGcPage(env, payload.lastVersionId ?? "");
    await recordGcPage(env, jobId, versions, policies);
    if (versions.length === GC_PAGE_SIZE) {
      await updateJob(env, jobId, { ...payload, policySnapshot: policies, phase: "protect", lastVersionId: versions[versions.length - 1].version_id }, "queued");
      return;
    }
    await pruneGcMatches(env, jobId);
    await updateJob(env, jobId, { ...payload, policySnapshot: policies, phase: "evaluate", lastVersionId: "" }, "queued");
    return;
  }

  const versions = await getGcPage(env, payload.lastVersionId ?? "");
  const protectedIds = await protectedVersionIds(env, jobId, versions);
  const snapshots = await gcSnapshots(env, jobId, versions);
  const fallbackRetention = await defaultRetention(env);
  const timestamp = Date.now();
  for (const row of versions) {
    const snapshotUpdatedAt = snapshots.get(row.version_id);
    if (!snapshotUpdatedAt || snapshotUpdatedAt !== row.updated_at || row.pinned || protectedIds.has(row.version_id)) continue;
    const retention = effectiveRetentionDays(row, policies, fallbackRetention);
    if (timestamp - Date.parse(row.registered_at) < retention * 24 * 60 * 60 * 1000) continue;
    const existing = await findActiveDeletionJob(env, row.version_id);
    if (existing) {
      await env.DB.prepare("UPDATE artifact_versions SET state = 'deleting', updated_at = ? WHERE version_id = ? AND state = 'active'")
        .bind(now(), row.version_id).run();
      continue;
    }
    await createDeletionJob(env, row.version_id, "gc", {
      reason: "retention",
      packageName: row.package_name,
      versionName: row.version_name,
      automaticGc: true,
    }, { automaticGc: true, expectedUpdatedAt: row.updated_at });
    await touchJob(env, jobId);
  }
  if (versions.length === GC_PAGE_SIZE) {
    await updateJob(env, jobId, { ...payload, policySnapshot: policies, phase: "evaluate", lastVersionId: versions[versions.length - 1].version_id }, "queued");
    return;
  }
  await completeGc(env, jobId);
}

async function markAndDeleteObject(env: Bindings, key: string, guard?: { sql: string; bindings: unknown[] }): Promise<boolean> {
  const owner = await claimObjectWrite(env, key);
  if (!owner) throw new AppError("object_busy", "The object is currently being uploaded or inspected", 409);
  try {
    const predicate = guard ? ` AND (${guard.sql})` : "";
    const existing = await env.DB.prepare("SELECT state FROM objects WHERE r2_key = ?").bind(key).first<{ state: string }>();
    if (!existing) return false;
    if (existing.state === "deleting") {
      // A retry must not depend on whether D1 counts a no-op UPDATE as a change.
      const permitted = await env.DB.prepare(
        `SELECT 1 AS present FROM objects
         WHERE r2_key = ? AND state = 'deleting'${predicate}`,
      ).bind(key, ...(guard?.bindings ?? [])).first<{ present: number }>();
      if (!permitted) return false;
    } else {
      const marked = await env.DB.prepare(
        `UPDATE objects SET state = 'deleting'
         WHERE r2_key = ? AND state IN ('ready', 'orphaned')${predicate}`,
      ).bind(key, ...(guard?.bindings ?? [])).run();
      if (marked.meta.changes !== 1) return false;
    }
    await env.CACHE_BUCKET.delete(key);
    return true;
  } finally {
    await releaseObjectWrite(env, key, owner);
  }
}

async function cleanupNarinfoRows(env: Bindings, jobId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM narinfo_refs
       WHERE narinfo_key IN (SELECT narinfo_key FROM delete_job_narinfos WHERE job_id = ?)
         AND NOT EXISTS (SELECT 1 FROM artifact_version_members m WHERE m.narinfo_key = narinfo_refs.narinfo_key)
         AND EXISTS (SELECT 1 FROM objects o WHERE o.r2_key = narinfo_refs.narinfo_key AND o.kind = 'narinfo' AND o.state = 'deleting')`,
    ).bind(jobId),
    env.DB.prepare(
      `DELETE FROM objects
       WHERE r2_key IN (SELECT narinfo_key FROM delete_job_narinfos WHERE job_id = ?)
         AND kind = 'narinfo' AND state = 'deleting'
         AND NOT EXISTS (SELECT 1 FROM narinfo_refs r WHERE r.narinfo_key = objects.r2_key)`,
    ).bind(jobId),
  ]);
}

async function finishDeleteVersion(env: Bindings, jobId: string, version: VersionRow): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM delete_job_nars WHERE job_id = ?").bind(jobId),
    env.DB.prepare("DELETE FROM delete_job_narinfos WHERE job_id = ?").bind(jobId),
    env.DB.prepare("UPDATE artifact_versions SET state = 'deleted', updated_at = ? WHERE version_id = ?").bind(now(), version.version_id),
    env.DB.prepare("UPDATE jobs SET status = 'completed', updated_at = ? WHERE id = ?").bind(now(), jobId),
  ]);
  await emitAudit(env, "version_deleted", "job", `${version.package_name}/${version.version_name}`, { jobId, versionId: version.version_id });
}

async function cleanupNars(env: Bindings, jobId: string, version: VersionRow): Promise<void> {
  const rows = await env.DB.prepare("SELECT nar_key FROM delete_job_nars WHERE job_id = ? ORDER BY nar_key LIMIT ?")
    .bind(jobId, NAR_CLEANUP_BATCH_SIZE).all<{ nar_key: string }>();
  if (!rows.results.length) {
    await finishDeleteVersion(env, jobId, version);
    return;
  }
  for (const row of rows.results) {
    const remaining = await env.DB.prepare("SELECT COUNT(*) AS count FROM narinfo_refs WHERE nar_key = ?").bind(row.nar_key).first<{ count: number }>();
    if (Number(remaining?.count ?? 0) === 0) {
      const deleted = await markAndDeleteObject(env, row.nar_key, {
        sql: `NOT EXISTS (
          SELECT 1 FROM narinfo_refs r
          WHERE r.nar_key = objects.r2_key
        )`,
        bindings: [],
      });
      if (deleted) await env.DB.prepare("DELETE FROM objects WHERE r2_key = ? AND state = 'deleting'").bind(row.nar_key).run();
    }
    await env.DB.prepare("DELETE FROM delete_job_nars WHERE job_id = ? AND nar_key = ?").bind(jobId, row.nar_key).run();
  }
  if (rows.results.length < NAR_CLEANUP_BATCH_SIZE) {
    await finishDeleteVersion(env, jobId, version);
  } else {
    await updateJob(env, jobId, { phase: "cleanup_nars" }, "queued");
  }
}

export async function processDeleteVersion(env: Bindings, jobId: string): Promise<void> {
  const job = await env.DB.prepare("SELECT target_version_id, cursor, payload_json FROM jobs WHERE id = ?")
    .bind(jobId).first<{ target_version_id: string | null; cursor: number; payload_json: string }>();
  if (!job?.target_version_id) throw new AppError("invalid_job", "The delete job has no target version", 500);
  const payload = parsePayload<DeletePayload>(job.payload_json, {});
  const version = await env.DB.prepare("SELECT * FROM artifact_versions WHERE version_id = ?")
    .bind(job.target_version_id).first<VersionRow>();
  if (!version || version.state === "deleted") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM delete_job_nars WHERE job_id = ?").bind(jobId),
      env.DB.prepare("DELETE FROM delete_job_narinfos WHERE job_id = ?").bind(jobId),
      env.DB.prepare("UPDATE jobs SET status = 'completed', cursor = 0, payload_json = ?, updated_at = ? WHERE id = ?")
        .bind(JSON.stringify(payload), now(), jobId),
    ]);
    return;
  }
  if (payload.automaticGc && version.pinned && version.state === "active") {
    await updateJob(env, jobId, payload, "completed");
    return;
  }
  if (version.state !== "deleting") {
    await env.DB.prepare("UPDATE artifact_versions SET state = 'deleting', updated_at = ? WHERE version_id = ? AND state IN ('registering', 'active')")
      .bind(now(), version.version_id).run();
  }
  if (!payload.phase) {
    await bumpCacheGeneration(env);
    await updateJob(env, jobId, { ...payload, phase: "members" }, "running", job.cursor);
    payload.phase = "members";
  }
  if (payload.phase === "cleanup_nars") {
    await cleanupNars(env, jobId, version);
    return;
  }

  const members = await env.DB.prepare(
    `SELECT m.narinfo_key, r.nar_key
     FROM artifact_version_members m
     LEFT JOIN narinfo_refs r ON r.narinfo_key = m.narinfo_key
     WHERE m.version_id = ? ORDER BY m.narinfo_key LIMIT ? OFFSET ?`,
  ).bind(version.version_id, BATCH_SIZE, job.cursor).all<MemberRow>();

  const narStatements = [...new Set(members.results.map((member) => member.nar_key).filter((key): key is string => Boolean(key)))].map((key) =>
    env.DB.prepare("INSERT OR IGNORE INTO delete_job_nars (job_id, nar_key) VALUES (?, ?)").bind(jobId, key));
  for (let offset = 0; offset < narStatements.length; offset += 100) await env.DB.batch(narStatements.slice(offset, offset + 100));
  const narinfoStatements = [...new Set(members.results.map((member) => member.narinfo_key))].map((key) =>
    env.DB.prepare("INSERT OR IGNORE INTO delete_job_narinfos (job_id, narinfo_key) VALUES (?, ?)").bind(jobId, key));
  for (let offset = 0; offset < narinfoStatements.length; offset += 100) await env.DB.batch(narinfoStatements.slice(offset, offset + 100));

  let lastHeartbeat = Date.now();
  for (const member of members.results) {
    const narinfoDeleted = await markAndDeleteObject(env, member.narinfo_key, {
      sql: `NOT EXISTS (
        SELECT 1
        FROM artifact_version_members m
        JOIN artifact_versions v ON v.version_id = m.version_id
        WHERE m.narinfo_key = objects.r2_key
          AND m.version_id != ?
          AND v.state IN ('registering', 'active', 'deleting')
      )`,
      bindings: [version.version_id],
    });
    if (narinfoDeleted && member.nar_key) {
      await markAndDeleteObject(env, member.nar_key, {
        sql: `NOT EXISTS (
          SELECT 1
          FROM narinfo_refs r
          JOIN objects ni ON ni.r2_key = r.narinfo_key
          WHERE r.nar_key = objects.r2_key
            AND r.narinfo_key != ?
            AND ni.kind = 'narinfo'
            AND ni.state IN ('ready', 'deleting')
        )`,
        bindings: [member.narinfo_key],
      });
    }
    if (Date.now() - lastHeartbeat >= 30_000) {
      await touchJob(env, jobId);
      lastHeartbeat = Date.now();
    }
  }

  if (members.results.length === BATCH_SIZE) {
    await updateJob(env, jobId, { ...payload, phase: "members" }, "queued", job.cursor + members.results.length);
    return;
  }

  await env.DB.prepare("DELETE FROM artifact_version_members WHERE version_id = ?").bind(version.version_id).run();
  await cleanupNarinfoRows(env, jobId);
  await updateJob(env, jobId, { ...payload, phase: "cleanup_nars" }, "queued");
  await cleanupNars(env, jobId, version);
}
