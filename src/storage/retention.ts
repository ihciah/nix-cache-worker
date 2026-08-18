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
  const memberships = await env.DB.prepare(
    `SELECT DISTINCT v.*
     FROM artifact_version_members m
     JOIN artifact_versions v ON v.version_id = m.version_id
     WHERE v.state = 'active'
       AND (
         m.narinfo_key = ?
         OR EXISTS (
           SELECT 1 FROM narinfo_refs r
           WHERE r.narinfo_key = m.narinfo_key AND r.nar_key = ?
         )
       )`,
  ).bind(key, key).all<VersionRow>();

  if (memberships.results.length === 0) return ttlCacheControl(kind, UNCLASSIFIED_TTL_SECONDS);

  const policyRows = await env.DB.prepare("SELECT * FROM gc_policies ORDER BY id").all<PolicyRow>();
  const maxRetentionDays = Math.max(...memberships.results.map((row) => effectiveRetentionDays(row, policyRows.results, fallbackDays)));
  return ttlCacheControl(kind, maxRetentionDays * 24 * 60 * 60);
}
