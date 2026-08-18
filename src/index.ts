import type { ScheduledController, ExecutionContext } from "@cloudflare/workers-types";
import { app } from "./app";
import type { WorkerEnv } from "./env";
import { createJob, runQueuedJobs } from "./jobs/jobs";
import { now } from "./storage/db";

async function scheduleGarbageCollection(env: WorkerEnv): Promise<void> {
  const existing = await env.DB.prepare("SELECT id FROM jobs WHERE type = 'gc' AND status IN ('queued', 'running', 'failed') LIMIT 1").first<{ id: string }>();
  if (!existing) await createJob(env, "gc", null, "cron", { scheduledAt: now() });
  await runQueuedJobs(env, 4);
}

const worker = {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: WorkerEnv, _ctx: ExecutionContext): Promise<void> {
    await scheduleGarbageCollection(env);
  },
};

export default worker;
