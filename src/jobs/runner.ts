import type { Bindings } from "../env";
import { AppError } from "../domain/errors";
import { effectiveRetentionDays, isProtectedByKeepLatest, type PolicyRow } from "../domain/policy";
import { emitAudit } from "../observability";
import { bumpCacheGeneration, getSetting, now, type VersionRow } from "../storage/db";
import { createJob } from "./jobs";

const BATCH_SIZE = 500;

type MemberRow = { narinfo_key: string; nar_key: string };

async function getPolicies(env: Bindings): Promise<PolicyRow[]> {
  const result = await env.DB.prepare("SELECT * FROM gc_policies ORDER BY id").all<PolicyRow>();
  return result.results;
}

async function getVersions(env: Bindings): Promise<VersionRow[]> {
  const result = await env.DB.prepare("SELECT * FROM artifact_versions WHERE state = 'active' ORDER BY registered_at DESC").all<VersionRow>();
  return result.results;
}

async function defaultRetention(env: Bindings): Promise<number> {
  const configured = await getSetting(env, "default_retention_days");
  const value = Number(configured ?? env.DEFAULT_RETENTION_DAYS ?? "7");
  return Number.isSafeInteger(value) && value >= 0 ? value : 7;
}

function eligibleForGc(row: VersionRow, versions: VersionRow[], policies: PolicyRow[], fallbackRetention: number, timestamp: number): boolean {
  if (row.pinned || row.state !== "active") return false;
  if (isProtectedByKeepLatest(row, versions, policies)) return false;
  const retention = effectiveRetentionDays(row, policies, fallbackRetention);
  const age = timestamp - Date.parse(row.registered_at);
  return age >= retention * 24 * 60 * 60 * 1000;
}

export async function processGc(env: Bindings, jobId: string): Promise<void> {
  const versions = await getVersions(env);
  const policies = await getPolicies(env);
  const fallbackRetention = await defaultRetention(env);
  const timestamp = Date.now();
  for (const row of versions) {
    if (!eligibleForGc(row, versions, policies, fallbackRetention, timestamp)) continue;
    const existing = await env.DB.prepare(
      "SELECT id FROM jobs WHERE type = 'delete_version' AND target_version_id = ? AND status IN ('queued', 'running', 'failed')",
    ).bind(row.version_id).first();
    if (!existing) await createJob(env, "delete_version", row.version_id, "gc", { reason: "retention", packageName: row.package_name, versionName: row.version_name });
  }
  await env.DB.prepare("UPDATE jobs SET status = 'completed', updated_at = ? WHERE id = ?").bind(now(), jobId).run();
}

async function hasOtherVersionMember(env: Bindings, versionId: string, narinfoKey: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM artifact_version_members m
     JOIN artifact_versions v ON v.version_id = m.version_id
     WHERE m.narinfo_key = ? AND m.version_id != ? AND v.state IN ('registering', 'active', 'deleting')`,
  ).bind(narinfoKey, versionId).first<{ count: number }>();
  return Number(row?.count ?? 0) > 0;
}

async function hasOtherNarReference(env: Bindings, narKey: string, narinfoKey: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM narinfo_refs r
     JOIN objects o ON o.r2_key = r.narinfo_key
     WHERE r.nar_key = ? AND r.narinfo_key != ? AND o.state IN ('ready', 'deleting')`,
  ).bind(narKey, narinfoKey).first<{ count: number }>();
  return Number(row?.count ?? 0) > 0;
}

async function markAndDeleteObject(env: Bindings, key: string): Promise<void> {
  await env.DB.prepare("UPDATE objects SET state = 'deleting' WHERE r2_key = ? AND state IN ('ready', 'orphaned')").bind(key).run();
  await env.CACHE_BUCKET.delete(key);
}

export async function processDeleteVersion(env: Bindings, jobId: string): Promise<void> {
  const job = await env.DB.prepare("SELECT target_version_id, cursor FROM jobs WHERE id = ?")
    .bind(jobId).first<{ target_version_id: string | null; cursor: number }>();
  if (!job?.target_version_id) throw new AppError("invalid_job", "The delete job has no target version", 500);
  const version = await env.DB.prepare("SELECT * FROM artifact_versions WHERE version_id = ?")
    .bind(job.target_version_id).first<VersionRow>();
  if (!version) {
    await env.DB.prepare("UPDATE jobs SET status = 'completed', updated_at = ? WHERE id = ?").bind(now(), jobId).run();
    return;
  }
  if (version.state === "deleted") {
    await env.DB.prepare("UPDATE jobs SET status = 'completed', updated_at = ? WHERE id = ?").bind(now(), jobId).run();
    return;
  }
  await env.DB.prepare("UPDATE artifact_versions SET state = 'deleting', updated_at = ? WHERE version_id = ? AND state IN ('registering', 'active', 'deleting')")
    .bind(now(), version.version_id).run();

  const members = await env.DB.prepare(
    `SELECT m.narinfo_key, r.nar_key
     FROM artifact_version_members m
     JOIN narinfo_refs r ON r.narinfo_key = m.narinfo_key
     WHERE m.version_id = ? ORDER BY m.narinfo_key LIMIT ? OFFSET ?`,
  ).bind(version.version_id, BATCH_SIZE, job.cursor).all<MemberRow>();

  for (const member of members.results) {
    const sharedNarinfo = await hasOtherVersionMember(env, version.version_id, member.narinfo_key);
    if (!sharedNarinfo) {
      await markAndDeleteObject(env, member.narinfo_key);
      if (!(await hasOtherNarReference(env, member.nar_key, member.narinfo_key))) {
        await markAndDeleteObject(env, member.nar_key);
      }
    }
  }

  if (members.results.length === BATCH_SIZE) {
    await env.DB.prepare("UPDATE jobs SET status = 'queued', cursor = cursor + ?, updated_at = ? WHERE id = ?")
      .bind(members.results.length, now(), jobId).run();
    return;
  }

  const targetMembers = await env.DB.prepare(
    `SELECT m.narinfo_key, r.nar_key
     FROM artifact_version_members m JOIN narinfo_refs r ON r.narinfo_key = m.narinfo_key
     WHERE m.version_id = ?`,
  ).bind(version.version_id).all<{ narinfo_key: string; nar_key: string }>();
  const targetNarKeys = [...new Set(targetMembers.results.map((item) => item.nar_key))];
  for (let offset = 0; offset < targetMembers.results.length; offset += 100) {
    const keys = targetMembers.results.slice(offset, offset + 100).map((item) => item.narinfo_key);
    const placeholders = keys.map(() => "?").join(",");
    await env.DB.prepare(`DELETE FROM artifact_version_members WHERE version_id = ? AND narinfo_key IN (${placeholders})`)
      .bind(version.version_id, ...keys).run();
    await env.DB.prepare(`DELETE FROM narinfo_refs WHERE narinfo_key IN (${placeholders}) AND NOT EXISTS (SELECT 1 FROM artifact_version_members WHERE artifact_version_members.narinfo_key = narinfo_refs.narinfo_key)`)
      .bind(...keys).run();
    await env.DB.prepare(`DELETE FROM objects WHERE r2_key IN (${placeholders}) AND state = 'deleting'`)
      .bind(...keys).run();
  }
  for (const narKey of targetNarKeys) {
    const remaining = await env.DB.prepare("SELECT COUNT(*) AS count FROM narinfo_refs WHERE nar_key = ?").bind(narKey).first<{ count: number }>();
    if (Number(remaining?.count ?? 0) === 0) {
      await markAndDeleteObject(env, narKey);
      await env.DB.prepare("DELETE FROM objects WHERE r2_key = ? AND state = 'deleting'").bind(narKey).run();
    }
  }
  await env.DB.prepare("UPDATE artifact_versions SET state = 'deleted', updated_at = ? WHERE version_id = ?")
    .bind(now(), version.version_id).run();
  await bumpCacheGeneration(env);
  await env.DB.prepare("UPDATE jobs SET status = 'completed', updated_at = ? WHERE id = ?").bind(now(), jobId).run();
  emitAudit(env, "version_deleted", "job", `${version.package_name}/${version.version_name}`, { jobId, versionId: version.version_id });
}
