import type { Bindings } from "../env";
import { cacheControlFor, type ObjectKind } from "../domain/keys";
import { effectiveRetentionDays, type PolicyRow } from "../domain/policy";
import { getSetting, type VersionRow } from "./db";

const UNCLASSIFIED_TTL_SECONDS = 6 * 60 * 60;
const FALLBACK_RETENTION_DAYS = 7;

function retentionDays(value: string | number | null | undefined): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : FALLBACK_RETENTION_DAYS;
}

function ttlCacheControl(kind: ObjectKind, seconds: number): string {
  return cacheControlFor(kind, seconds);
}

/**
 * Return the public cache TTL for an object at read time.
 *
 * R2 metadata is immutable along with the object bytes, so membership-driven
 * TTLs are intentionally applied to Worker responses rather than rewriting
 * an existing R2 object when a set is registered or updated.
 */
export async function cacheControlForObject(env: Bindings, key: string, kind: ObjectKind): Promise<string> {
  if (kind === "cache-info") return cacheControlFor(kind);

  const fallbackDays = retentionDays(await getSetting(env, "default_retention_days") ?? env.DEFAULT_RETENTION_DAYS);
  let policyRows: PolicyRow[] | null = null;
  let lastVersionId = "";
  let maxRetentionDays: number | null = null;
  while (true) {
    const memberships = await env.DB.prepare(
      `SELECT DISTINCT v.*
       FROM artifact_version_members m
       JOIN artifact_versions v ON v.version_id = m.version_id
       WHERE v.state = 'active'
         AND v.version_id > ?
         AND (
           m.narinfo_key = ?
           OR EXISTS (
             SELECT 1 FROM narinfo_refs r
             WHERE r.narinfo_key = m.narinfo_key AND r.nar_key = ?
           )
         )
       ORDER BY v.version_id LIMIT 200`,
    ).bind(lastVersionId, key, key).all<VersionRow>();
    if (memberships.results.length === 0 && maxRetentionDays === null) return ttlCacheControl(kind, UNCLASSIFIED_TTL_SECONDS);
    if (!policyRows) policyRows = (await env.DB.prepare("SELECT * FROM gc_policies ORDER BY id").all<PolicyRow>()).results;
    for (const row of memberships.results) {
      const days = effectiveRetentionDays(row, policyRows, fallbackDays);
      maxRetentionDays = maxRetentionDays === null ? days : Math.max(maxRetentionDays, days);
    }
    if (memberships.results.length < 200) break;
    lastVersionId = memberships.results[memberships.results.length - 1].version_id;
  }

  if (maxRetentionDays === null) return ttlCacheControl(kind, UNCLASSIFIED_TTL_SECONDS);
  const stillMember = await env.DB.prepare(
    `SELECT 1 AS present
     FROM artifact_version_members m
     JOIN artifact_versions v ON v.version_id = m.version_id
     WHERE v.state = 'active'
       AND (m.narinfo_key = ? OR EXISTS (SELECT 1 FROM narinfo_refs r WHERE r.narinfo_key = m.narinfo_key AND r.nar_key = ?))
     LIMIT 1`,
  ).bind(key, key).first<{ present: number }>();
  if (!stillMember) return ttlCacheControl(kind, UNCLASSIFIED_TTL_SECONDS);
  return ttlCacheControl(kind, maxRetentionDays * 24 * 60 * 60);
}
