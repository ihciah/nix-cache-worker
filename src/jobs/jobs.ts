import type { Bindings } from "../env";
import { now } from "../storage/db";
import { processDeleteVersion, processGc } from "./runner";

export type JobRow = {
  id: string;
  type: "gc" | "delete_version";
  status: "queued" | "running" | "failed" | "completed";
  target_version_id: string | null;
  cursor: number;
  attempts: number;
  payload_json: string;
  last_error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export async function createJob(env: Bindings, type: JobRow["type"], targetVersionId: string | null, actor: string, payload: Record<string, unknown> = {}): Promise<string> {
  const id = crypto.randomUUID();
  const timestamp = now();
  await env.DB.prepare(
    "INSERT INTO jobs (id, type, status, target_version_id, payload_json, created_by, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)",
  ).bind(id, type, targetVersionId, JSON.stringify(payload), actor, timestamp, timestamp).run();
  return id;
}

export async function getJob(env: Bindings, id: string): Promise<JobRow | null> {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>();
}

export async function runJob(env: Bindings, id: string): Promise<void> {
  const job = await getJob(env, id);
  if (!job || job.status === "completed") return;
  const staleBefore = new Date(Date.now() - 15 * 60_000).toISOString();
  const claimed = await env.DB.prepare(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ?
     WHERE id = ? AND (status IN ('queued', 'failed') OR (status = 'running' AND updated_at < ?))`,
  ).bind(now(), id, staleBefore).run();
  if (claimed.meta.changes === 0) return;
  try {
    if (job.type === "delete_version") await processDeleteVersion(env, id);
    else await processGc(env, id);
  } catch (error) {
    await env.DB.prepare("UPDATE jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?")
      .bind(error instanceof Error ? error.message : String(error), now(), id).run();
    console.error(JSON.stringify({ event: "job_error", jobId: id, message: error instanceof Error ? error.message : String(error) }));
  }
}

export async function runQueuedJobs(env: Bindings, limit = 2): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    const jobs = await env.DB.prepare(
      "SELECT id FROM jobs WHERE status IN ('queued', 'failed') ORDER BY updated_at ASC LIMIT ?",
    ).bind(limit).all<{ id: string }>();
    if (jobs.results.length === 0) return;
    for (const job of jobs.results) await runJob(env, job.id);
  }
}
