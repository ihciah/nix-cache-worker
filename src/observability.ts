import type { Context } from "hono";
import type { AppEnv } from "./env";

export type MetricEvent =
  | "cache_hit"
  | "cache_miss"
  | "r2_get"
  | "r2_put"
  | "bytes_served"
  | "upload_bytes"
  | "auth_failure";

export function emitMetric(event: MetricEvent, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, timestamp: new Date().toISOString(), ...fields }));
}

export function emitAudit(env: AppEnv["Bindings"], action: string, actor: string, target: string | null, details: Record<string, unknown> = {}): void {
  const createdAt = new Date().toISOString();
  void env.DB.prepare(
    "INSERT INTO audit_log (action, actor, target, details_json, created_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(action, actor, target, JSON.stringify(details), createdAt).run().catch((error: unknown) => {
    console.error(JSON.stringify({ event: "audit_error", action, message: error instanceof Error ? error.message : String(error) }));
  });
}

export function requestId(c: Context<AppEnv>): string {
  return c.get("requestId") ?? "unknown";
}
