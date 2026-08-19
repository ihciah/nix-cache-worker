import { Hono } from "hono";
import type { AppEnv } from "../env";
import { AppError } from "../domain/errors";
import { parseNarInfo } from "../domain/narinfo";
import { kindForKey, normalizeKeyFromUrl } from "../domain/keys";
import { emitAudit } from "../observability";
import { getObject, now } from "../storage/db";
import { claimObjectWrite, putImmutableObject, releaseObjectWrite } from "../storage/r2";
import { requireRole } from "../middleware/auth";
import type { Context } from "hono";

export const narinfoRoutes = new Hono<AppEnv>();

export async function handleNarinfoPut(c: Context<AppEnv>): Promise<Response> {
  const key = normalizeKeyFromUrl(new URL(c.req.url));
  if (kindForKey(key) !== "narinfo") throw new AppError("invalid_path", "The narinfo route only accepts .narinfo objects", 404);
  const bodyCopy = c.req.raw.clone();
  const text = await bodyCopy.text();
  const parsed = parseNarInfo(text);
  const dependencyOwner = await claimObjectWrite(c.env, parsed.narKey);
  if (!dependencyOwner) throw new AppError("upload_in_progress", "The referenced NAR is being changed or deleted", 409);
  try {
    const narObject = await c.env.CACHE_BUCKET.head(parsed.narKey);
    const narIndex = await getObject(c.env, parsed.narKey);
    if (!narObject || !narIndex || narIndex.state !== "ready") {
      throw new AppError("missing_nar_dependency", "The narinfo references a missing NAR", 424, { narKey: parsed.narKey });
    }
    const result = await putImmutableObject(c.env, key, "narinfo", c.req.raw);
    await c.env.DB.prepare(
      `INSERT INTO narinfo_refs (narinfo_key, nar_key, store_path, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(narinfo_key) DO UPDATE SET nar_key = excluded.nar_key, store_path = excluded.store_path`,
    ).bind(key, parsed.narKey, parsed.storePath, now()).run();
    await emitAudit(c.env, result.duplicate ? "narinfo_replay" : "narinfo_upload", c.get("role"), key, { narKey: parsed.narKey });
    return new Response(null, { status: result.duplicate ? 204 : 201, headers: { ETag: result.object.httpEtag } });
  } finally {
    await releaseObjectWrite(c.env, parsed.narKey, dependencyOwner);
  }
}

narinfoRoutes.put("/*", requireRole("write"), handleNarinfoPut);
