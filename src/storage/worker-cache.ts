import { emitMetric } from "../observability";

export type WaitUntilContext = { waitUntil(promise: Promise<unknown>): void };

function workerCache(): Cache | null {
  try {
    if (typeof caches === "undefined") return null;
    return (caches as unknown as { default?: Cache }).default ?? null;
  } catch {
    return null;
  }
}

export function workerCacheKey(request: Request, generation = "0"): Request {
  const url = new URL(request.url);
  url.search = "";
  url.searchParams.set("__nix_cache_generation", generation);
  return new Request(url.toString(), { method: "GET" });
}

export function isWorkerCacheEligible(request: Request): boolean {
  return (request.method === "GET" || request.method === "HEAD")
    && !request.headers.has("Range")
    && !request.headers.has("If-None-Match")
    && !request.headers.has("If-Match");
}

export async function matchWorkerCache(request: Request, generation = "0"): Promise<Response | null> {
  if (!isWorkerCacheEligible(request)) return null;
  const cache = workerCache();
  if (!cache) return null;
  try {
    return await cache.match(workerCacheKey(request, generation)) ?? null;
  } catch {
    return null;
  }
}

export function responseForRequestMethod(response: Response, method: string): Response {
  if (method === "HEAD") return new Response(null, { status: response.status, headers: response.headers });
  return response;
}

export function scheduleWorkerCachePut(ctx: WaitUntilContext, request: Request, response: Response, generation = "0"): void {
  if (request.method !== "GET" || response.status !== 200 || !isWorkerCacheEligible(request)) return;
  const cache = workerCache();
  if (!cache) return;
  const key = workerCacheKey(request, generation);
  ctx.waitUntil(cache.put(key, response.clone()).catch(() => undefined));
}

export function emitWorkerCacheHit(key: string, kind: string, request: Request, response: Response): void {
  const bytes = request.method === "GET" ? Number(response.headers.get("Content-Length") ?? "0") : 0;
  emitMetric("cache_hit", {
    key,
    kind,
    method: request.method,
    source: "worker_cache",
    bytes,
  });
  if (request.method === "GET") emitMetric("bytes_served", { key, bytes, source: "worker_cache" });
}
