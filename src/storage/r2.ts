import type { Bindings } from "../env";
import { AppError } from "../domain/errors";
import { cacheControlFor, contentTypeFor, type ObjectKind } from "../domain/keys";
import { hashStream, Sha256 } from "../domain/sha256";
import { emitMetric } from "../observability";
import { getObject, now, upsertObject } from "./db";
import { cacheControlForObject } from "./retention";

const MULTIPART_THRESHOLD = 8 * 1024 * 1024;
const PART_SIZE = 8 * 1024 * 1024;
const WRITE_CLAIM_TTL_MS = 15 * 60_000;

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

function strongEtagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").map((part) => part.trim()).some((part) => part === "*" || part === etag);
}

export async function claimObjectWrite(env: Bindings, key: string): Promise<string | null> {
  const owner = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + WRITE_CLAIM_TTL_MS).toISOString();
  await env.DB.prepare("DELETE FROM write_claims WHERE expires_at < ?").bind(now()).run();
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO write_claims (r2_key, owner, expires_at) VALUES (?, ?, ?)",
  ).bind(key, owner, expiresAt).run();
  return result.meta.changes === 1 ? owner : null;
}

async function renewWrite(env: Bindings, key: string, owner: string): Promise<void> {
  const expiresAt = new Date(Date.now() + WRITE_CLAIM_TTL_MS).toISOString();
  const result = await env.DB.prepare("UPDATE write_claims SET expires_at = ? WHERE r2_key = ? AND owner = ?")
    .bind(expiresAt, key, owner).run();
  if (result.meta.changes === 0) throw new AppError("upload_claim_lost", "The upload claim expired or was lost", 409);
}

export async function releaseObjectWrite(env: Bindings, key: string, owner: string): Promise<void> {
  await env.DB.prepare("DELETE FROM write_claims WHERE r2_key = ? AND owner = ?").bind(key, owner).run();
}

async function duplicateDecisionByDigest(
  env: Bindings,
  key: string,
  kind: ObjectKind,
  incoming: { sha256: string; size: number },
  existing: R2Object,
  indexed: Awaited<ReturnType<typeof getObject>>,
): Promise<UploadResult> {
  let existingSha256 = indexed?.sha256;
  if (!existingSha256) {
    const stored = await env.CACHE_BUCKET.get(key);
    if (!stored?.body) throw new AppError("orphaned_object", "The object exists in R2 but cannot be read for index repair", 503);
    const storedDigest = await hashStream(stored.body);
    existingSha256 = storedDigest.sha256;
  }
  if (incoming.sha256 !== existingSha256 || incoming.size !== existing.size) {
    throw new AppError("immutable_conflict", "An object with this key already exists with different content", 409);
  }
  if (!indexed?.sha256 || indexed.state !== "ready") {
    await upsertObject(env, {
      key,
      kind: indexed?.kind ?? kind,
      etag: existing.httpEtag,
      sha256: existingSha256,
      size: existing.size,
      state: "ready",
    });
  }
  emitMetric("r2_put", { key, kind, status: 204, duplicate: true, bytes: 0 });
  return { object: existing, duplicate: true, sha256: incoming.sha256 };
}

async function duplicateDecision(env: Bindings, key: string, kind: ObjectKind, request: Request, existing: R2Object, indexed: Awaited<ReturnType<typeof getObject>>): Promise<UploadResult> {
  if (indexed?.state === "deleting") throw new AppError("object_deleting", "The object is currently being deleted", 409);
  const ifMatch = request.headers.get("If-Match");
  if (ifMatch && !strongEtagMatches(ifMatch, existing.httpEtag)) {
    throw new AppError("precondition_failed", "If-Match does not match the existing object", 412);
  }
  if (etagMatches(request.headers.get("If-None-Match"), existing.httpEtag)) {
    throw new AppError("precondition_failed", "The object already exists", 412);
  }
  if (!request.body) throw new AppError("empty_body", "PUT requests must contain a body", 400);
  const incoming = await hashStream(request.body);
  return duplicateDecisionByDigest(env, key, kind, incoming, existing, indexed);
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
  let lastRenewedAt = Date.now();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (Date.now() - lastRenewedAt >= WRITE_CLAIM_TTL_MS / 3) {
        await renewWrite(env, key, owner);
        lastRenewedAt = Date.now();
      }
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
        await renewWrite(env, key, owner);
        lastRenewedAt = Date.now();
        partNumber += 1;
      }
    }
    if (pending.byteLength > 0 || parts.length === 0) {
      parts.push(await upload.uploadPart(partNumber, pending));
    }
    await renewWrite(env, key, owner);
    const object = await upload.complete(parts);
    emitMetric("r2_put", { key, kind, status: 201, duplicate: false, bytes: size, multipart: true });
    return { object, duplicate: false, sha256: hash.digest() };
  } catch (error) {
    try {
      await upload.abort();
    } catch (abortError) {
      console.error(JSON.stringify({ event: "multipart_abort_error", key, message: abortError instanceof Error ? abortError.message : String(abortError) }));
    }
    throw error;
  }
}

export async function putImmutableObject(env: Bindings, key: string, kind: ObjectKind, request: Request): Promise<UploadResult> {
  const owner = await claimObjectWrite(env, key);
  if (!owner) throw new AppError("upload_in_progress", "Another upload for this object is in progress", 409);

  let existing: R2Object | null;
  let indexed: Awaited<ReturnType<typeof getObject>>;
  try {
    existing = await env.CACHE_BUCKET.head(key);
    indexed = await getObject(env, key);
  } catch (error) {
    await releaseObjectWrite(env, key, owner);
    throw error;
  }
  if (indexed?.state === "deleting") {
    await releaseObjectWrite(env, key, owner);
    throw new AppError("object_deleting", "The object is currently being deleted", 409);
  }
  if (existing) {
    try {
      const result = await duplicateDecision(env, key, kind, request, existing, indexed);
      await releaseObjectWrite(env, key, owner);
      return result;
    } catch (error) {
      await releaseObjectWrite(env, key, owner);
      throw error;
    }
  }
  if (request.headers.get("If-Match")) {
    await releaseObjectWrite(env, key, owner);
    throw new AppError("precondition_failed", "If-Match requires an existing object", 412);
  }
  if (etagMatches(request.headers.get("If-None-Match"), "*")) {
    // The object was absent at the preflight check, so a conditional write is still applied below.
  }

  const contentLengthText = request.headers.get("Content-Length");
  const contentLengthValid = contentLengthText !== null && /^\d+$/.test(contentLengthText) && Number.isSafeInteger(Number(contentLengthText));
  const parsedContentLength = contentLengthValid ? Number(contentLengthText) : 0;
  const contentLength = Number.isSafeInteger(parsedContentLength) ? parsedContentLength : 0;
  const useMultipart = contentLength > MULTIPART_THRESHOLD || (kind === "nar" && !contentLengthValid);
  try {
    const raced = await env.CACHE_BUCKET.head(key);
    if (raced) return duplicateDecision(env, key, kind, request, raced, await getObject(env, key));

    if (useMultipart) {
      const result = await multipartPut(env, key, kind, request, owner);
      emitMetric("upload_bytes", { key, kind, status: 201, bytes: result.object.size });
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
      const racedObject = await env.CACHE_BUCKET.head(key);
      if (racedObject) return duplicateDecisionByDigest(env, key, kind, incoming, racedObject, await getObject(env, key));
      throw new AppError("upload_race", "The conditional upload failed without an observable object", 503);
    }
    emitMetric("r2_put", { key, kind, status: 201, duplicate: false, bytes: incoming.size });
    emitMetric("upload_bytes", { key, kind, status: 201, bytes: incoming.size });
    await upsertObject(env, { key, kind, etag: object.httpEtag, sha256: incoming.sha256, size: object.size });
    return { object, duplicate: false, sha256: incoming.sha256 };
  } finally {
    await releaseObjectWrite(env, key, owner);
  }
}

export async function getObjectResponse(env: Bindings, request: Request, key: string, kind: ObjectKind): Promise<Response> {
  const head = await env.CACHE_BUCKET.head(key);
  emitMetric("r2_get", { key, kind, method: request.method, operation: "head", status: head ? 200 : 404, bytes: 0 });
  if (!head) {
    emitMetric("cache_miss", { key, kind, method: request.method, status: 404, bytes: 0 });
    return new Response(null, { status: 404 });
  }

  const ifMatch = request.headers.get("If-Match");
  if (ifMatch && !strongEtagMatches(ifMatch, head.httpEtag)) return new Response(null, { status: 412, headers: { ETag: head.httpEtag } });
  if (etagMatches(request.headers.get("If-None-Match"), head.httpEtag)) {
    emitMetric("cache_hit", { key, kind, method: request.method, status: 304, bytes: 0, notModified: true });
    return new Response(null, { status: 304, headers: { ETag: head.httpEtag, "Cache-Control": await cacheControlForObject(env, key, kind) } });
  }

  const rangeHeader = request.headers.get("Range");
  let range: ReturnType<typeof parseRangeHeader> | undefined;
  try {
    range = rangeHeader ? parseRangeHeader(rangeHeader, head.size) : undefined;
  } catch (error) {
    if (error instanceof AppError && error.status === 416) {
      return new Response(null, {
        status: 416,
        headers: {
          ETag: head.httpEtag,
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes */${head.size}`,
          "Content-Length": "0",
        },
      });
    }
    throw error;
  }
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
    emitMetric("cache_hit", { key, kind, method: "HEAD", status: 200, bytes: 0 });
    return new Response(null, { status: 200, headers });
  }

  const object = await env.CACHE_BUCKET.get(key, range ? { range: { offset: range.offset, length: range.length } } : undefined);
  if (!object || !object.body) {
    emitMetric("r2_get", { key, kind, method: request.method, operation: "get", status: 404, bytes: 0 });
    emitMetric("cache_miss", { key, kind, method: request.method, status: 404, bytes: 0 });
    return new Response(null, { status: 404 });
  }
  headers.set("Content-Length", String(range?.length ?? head.size));
  if (range) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${head.size}`);
  }
  const status = range ? 206 : 200;
  const bytes = range?.length ?? head.size;
  emitMetric("r2_get", { key, kind, method: request.method, operation: "get", status, bytes });
  emitMetric("cache_hit", { key, kind, method: "GET", status, bytes });
  emitMetric("bytes_served", { key, kind, method: "GET", status, bytes });
  return new Response(object.body, { status, headers });
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
