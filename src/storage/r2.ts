import type { Bindings } from "../env";
import { AppError } from "../domain/errors";
import { cacheControlFor, contentTypeFor, type ObjectKind } from "../domain/keys";
import { hashStream, Sha256 } from "../domain/sha256";
import { emitMetric } from "../observability";
import { getObject, now, upsertObject } from "./db";
import { cacheControlForObject } from "./retention";

const MULTIPART_THRESHOLD = 8 * 1024 * 1024;
const PART_SIZE = 8 * 1024 * 1024;

export type UploadResult = {
  object: R2Object;
  duplicate: boolean;
  sha256: string;
};

function metadata(kind: ObjectKind): R2HTTPMetadata {
  return {
    contentType: contentTypeFor(kind),
    cacheControl: cacheControlFor(kind),
  };
}

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").map((part) => part.trim()).some((part) => part === "*" || part === etag || part === `W/${etag}`);
}

async function claimWrite(env: Bindings, key: string): Promise<string | null> {
  const owner = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  await env.DB.prepare("DELETE FROM write_claims WHERE expires_at < ?").bind(now()).run();
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO write_claims (r2_key, owner, expires_at) VALUES (?, ?, ?)",
  ).bind(key, owner, expiresAt).run();
  return result.meta.changes === 1 ? owner : null;
}

async function releaseWrite(env: Bindings, key: string, owner: string): Promise<void> {
  await env.DB.prepare("DELETE FROM write_claims WHERE r2_key = ? AND owner = ?").bind(key, owner).run();
}

async function duplicateDecisionByDigest(env: Bindings, key: string, incoming: { sha256: string; size: number }, existing: R2Object, indexed: Awaited<ReturnType<typeof getObject>>): Promise<UploadResult> {
  if (!indexed?.sha256) {
    throw new AppError("orphaned_object", "The object exists in R2 but is not indexed with a content digest", 409);
  }
  if (incoming.sha256 !== indexed.sha256 || incoming.size !== existing.size) {
    throw new AppError("immutable_conflict", "An object with this key already exists with different content", 409);
  }
  emitMetric("r2_put", { key, duplicate: true, bytes: 0 });
  return { object: existing, duplicate: true, sha256: incoming.sha256 };
}

async function duplicateDecision(env: Bindings, key: string, request: Request, existing: R2Object, indexed: Awaited<ReturnType<typeof getObject>>): Promise<UploadResult> {
  const ifMatch = request.headers.get("If-Match");
  if (ifMatch && !etagMatches(ifMatch, existing.httpEtag)) {
    throw new AppError("precondition_failed", "If-Match does not match the existing object", 412);
  }
  if (etagMatches(request.headers.get("If-None-Match"), existing.httpEtag)) {
    throw new AppError("precondition_failed", "The object already exists", 412);
  }
  const incoming = await hashStream(request.body);
  return duplicateDecisionByDigest(env, key, incoming, existing, indexed);
}

async function multipartPut(env: Bindings, key: string, kind: ObjectKind, request: Request, owner: string): Promise<UploadResult> {
  if (!request.body) throw new AppError("empty_body", "PUT requests must contain a body", 400);
  const upload = await env.CACHE_BUCKET.createMultipartUpload(key, { httpMetadata: metadata(kind) });
  const reader = request.body.getReader();
  const hash = new Sha256();
  const parts: R2UploadedPart[] = [];
  let partNumber = 1;
  let size = 0;
  let pending = new Uint8Array(0);
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      hash.update(chunk);
      size += chunk.byteLength;
      const combined = new Uint8Array(pending.byteLength + chunk.byteLength);
      combined.set(pending);
      combined.set(chunk, pending.byteLength);
      pending = combined;
      while (pending.byteLength >= PART_SIZE) {
        const part = pending.slice(0, PART_SIZE);
        pending = pending.slice(PART_SIZE);
        parts.push(await upload.uploadPart(partNumber, part));
        partNumber += 1;
      }
    }
    if (pending.byteLength > 0 || parts.length === 0) {
      parts.push(await upload.uploadPart(partNumber, pending));
    }
    const object = await upload.complete(parts);
    emitMetric("r2_put", { key, duplicate: false, bytes: size, multipart: true });
    return { object, duplicate: false, sha256: hash.digest() };
  } catch (error) {
    try {
      await upload.abort();
    } catch (abortError) {
      console.error(JSON.stringify({ event: "multipart_abort_error", key, message: abortError instanceof Error ? abortError.message : String(abortError) }));
    }
    throw error;
  } finally {
    await releaseWrite(env, key, owner);
  }
}

export async function putImmutableObject(env: Bindings, key: string, kind: ObjectKind, request: Request): Promise<UploadResult> {
  const existing = await env.CACHE_BUCKET.head(key);
  const indexed = await getObject(env, key);
  if (existing) return duplicateDecision(env, key, request, existing, indexed);
  if (request.headers.get("If-Match")) throw new AppError("precondition_failed", "If-Match requires an existing object", 412);
  if (etagMatches(request.headers.get("If-None-Match"), "*")) {
    // The object was absent at the preflight check, so a conditional write is still applied below.
  }

  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (contentLength > MULTIPART_THRESHOLD) {
    const owner = await claimWrite(env, key);
    if (!owner) throw new AppError("upload_in_progress", "Another upload for this object is in progress", 409);
    const raced = await env.CACHE_BUCKET.head(key);
    if (raced) {
      await releaseWrite(env, key, owner);
      return duplicateDecision(env, key, request, raced, await getObject(env, key));
    }
    const result = await multipartPut(env, key, kind, request, owner);
    emitMetric("upload_bytes", { key, bytes: result.object.size });
    await upsertObject(env, { key, kind, etag: result.object.httpEtag, sha256: result.sha256, size: result.object.size });
    return result;
  }

  if (!request.body) throw new AppError("empty_body", "PUT requests must contain a body", 400);
  const [hashBody, uploadBody] = request.body.tee();
  const hashPromise = hashStream(hashBody);
  const object = await env.CACHE_BUCKET.put(key, uploadBody, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: metadata(kind),
  });
  const incoming = await hashPromise;
  if (!object) {
    const raced = await env.CACHE_BUCKET.head(key);
    if (raced) return duplicateDecisionByDigest(env, key, incoming, raced, await getObject(env, key));
    throw new AppError("upload_race", "The conditional upload failed without an observable object", 503);
  }
  emitMetric("r2_put", { key, duplicate: false, bytes: incoming.size });
  emitMetric("upload_bytes", { key, bytes: incoming.size });
  await upsertObject(env, { key, kind, etag: object.httpEtag, sha256: incoming.sha256, size: object.size });
  return { object, duplicate: false, sha256: incoming.sha256 };
}

export async function getObjectResponse(env: Bindings, request: Request, key: string, kind: ObjectKind): Promise<Response> {
  const head = await env.CACHE_BUCKET.head(key);
  emitMetric("r2_get", { key, hit: Boolean(head) });
  if (!head) {
    emitMetric("cache_miss", { key, kind });
    return new Response(null, { status: 404 });
  }

  const ifMatch = request.headers.get("If-Match");
  if (ifMatch && !etagMatches(ifMatch, head.httpEtag)) return new Response(null, { status: 412, headers: { ETag: head.httpEtag } });
  if (etagMatches(request.headers.get("If-None-Match"), head.httpEtag)) {
    emitMetric("cache_hit", { key, kind, method: request.method, notModified: true });
    return new Response(null, { status: 304, headers: { ETag: head.httpEtag, "Cache-Control": await cacheControlForObject(env, key, kind) } });
  }

  const rangeHeader = request.headers.get("Range");
  const range = rangeHeader ? parseRangeHeader(rangeHeader, head.size) : undefined;
  const cacheControl = await cacheControlForObject(env, key, kind);
  const headers = new Headers();
  headers.set("ETag", head.httpEtag);
  headers.set("Cache-Control", cacheControl);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Type", contentTypeFor(kind));
  headers.set("Last-Modified", head.uploaded.toUTCString());
  if (request.method === "HEAD") {
    headers.set("Content-Length", String(range?.length ?? head.size));
    if (range) {
      headers.set("Content-Range", `bytes ${range.start}-${range.end}/${head.size}`);
      return new Response(null, { status: 206, headers });
    }
    emitMetric("cache_hit", { key, kind, method: "HEAD" });
    return new Response(null, { status: 200, headers });
  }

  const object = await env.CACHE_BUCKET.get(key, range ? { range: { offset: range.offset, length: range.length } } : undefined);
  if (!object || !object.body) return new Response(null, { status: 404 });
  headers.set("Content-Length", String(range?.length ?? head.size));
  if (range) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${head.size}`);
  }
  emitMetric("cache_hit", { key, kind, method: "GET" });
  emitMetric("bytes_served", { key, bytes: range?.length ?? head.size });
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

function parseRangeHeader(header: string, size: number): { offset: number; length: number; start: number; end: number } {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) throw new AppError("invalid_range", "Only one byte range is supported", 416);
  const startText = match[1];
  const endText = match[2];
  if (!startText && !endText) throw new AppError("invalid_range", "The byte range is invalid", 416);
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isInteger(suffix) || suffix <= 0 || size === 0) throw new AppError("invalid_range", "The byte range is unsatisfiable", 416);
    const length = Math.min(suffix, size);
    return { offset: size - length, length, start: size - length, end: size - 1 };
  }
  const start = Number(startText);
  const end = endText ? Number(endText) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) throw new AppError("invalid_range", "The byte range is unsatisfiable", 416);
  const boundedEnd = Math.min(end, size - 1);
  return { offset: start, length: boundedEnd - start + 1, start, end: boundedEnd };
}
