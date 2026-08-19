import { Hono } from "hono";
import type { AppEnv } from "./env";
import { AuthError, authMiddleware } from "./middleware/auth";
import { emitMetric } from "./observability";
import { AppError, isAppError } from "./domain/errors";
import { adminRoutes } from "./routes/admin";
import { cacheRoutes } from "./routes/cache";
import { versionRoutes } from "./routes/versions";
import { adminPage } from "./ui/admin";
import { homePage } from "./ui/home";

export const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  const id = c.req.header("X-Request-Id") || crypto.randomUUID();
  c.set("requestId", id);
  await next();
  c.header("X-Request-Id", id);
});
app.use("*", authMiddleware);

app.onError((error, c) => {
  const requestId = c.get("requestId") ?? "unknown";
  if (error instanceof AuthError) emitMetric("auth_failure", { requestId, method: c.req.method, code: error.code, status: error.status, bytes: 0 });
  const status = isAppError(error) ? error.status : error instanceof AuthError ? error.status : 500;
  const code = isAppError(error) || error instanceof AuthError ? error.code : "internal_error";
  const message = isAppError(error) || error instanceof AuthError ? error.message : "Internal server error";
  if (status >= 500) console.error(JSON.stringify({ event: "request_error", requestId, code, message: error instanceof Error ? error.message : String(error) }));
  return c.json({ error: { code, message, requestId } }, status as 400);
});

app.get("/admin", (c) => adminPage(new URL(c.req.url).origin));
app.get("/", (c) => homePage(c.env.NIX_PUBLIC_SIGN_KEY, new URL(c.req.url).origin));
app.route("", adminRoutes);
app.route("", versionRoutes);
app.route("", cacheRoutes);

app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found", requestId: c.get("requestId") ?? "unknown" } }, 404));

export function normalizeUnhandledError(error: unknown): AppError {
  return error instanceof AppError ? error : new AppError("internal_error", "Internal server error", 500);
}
