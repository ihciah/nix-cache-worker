import { createMiddleware } from "hono/factory";
import type { MiddlewareHandler } from "hono";
import type { AppEnv, Bindings } from "../env";

export type Role = "anonymous" | "read" | "write" | "admin";

const roleRank: Record<Role, number> = {
  anonymous: 0,
  read: 1,
  write: 2,
  admin: 3,
};

const missingSecretWarnings = new Set<string>();
const encoder = new TextEncoder();

function secureEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let result = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    result |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return result === 0;
}

function configuredSecret(env: Bindings, name: keyof Pick<Bindings, "READ_TOKEN" | "WRITE_TOKEN" | "ADMIN_TOKEN">): string | undefined {
  const value = env[name];
  if (!value && !missingSecretWarnings.has(name)) {
    missingSecretWarnings.add(name);
    console.error(JSON.stringify({ event: "configuration_error", secret: name, message: "Authentication role disabled because its Worker Secret is missing" }));
  }
  return value;
}

export function authenticate(request: Request, env: Bindings): Role {
  const authorization = request.headers.get("Authorization");
  if (!authorization) return "anonymous";

  const value = authorization.trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(value);
  let token: string | undefined = bearer?.[1];

  // Nix's stock HTTP uploader reads credentials from netrc and sends them as
  // Basic authentication. The password is still the Worker Secret token.
  if (!token) {
    const basic = /^Basic\s+(.+)$/i.exec(value);
    if (basic) {
      try {
        const decoded = atob(basic[1]);
        const separator = decoded.indexOf(":");
        if (separator >= 0) token = decoded.slice(separator + 1);
      } catch {
        return "anonymous";
      }
    }
  }
  if (!token) return "anonymous";

  const admin = configuredSecret(env, "ADMIN_TOKEN");
  if (admin && secureEqual(token, admin)) return "admin";
  const write = configuredSecret(env, "WRITE_TOKEN");
  if (write && secureEqual(token, write)) return "write";
  const read = configuredSecret(env, "READ_TOKEN");
  if (read && secureEqual(token, read)) return "read";
  return "anonymous";
}

export const authMiddleware: MiddlewareHandler<AppEnv> = createMiddleware<AppEnv>(async (c, next) => {
  const authorization = c.req.header("Authorization");
  const role = authenticate(c.req.raw, c.env);
  if (authorization && role === "anonymous") {
    throw new AuthError("invalid_token", "The authorization credential is invalid", 401);
  }
  c.set("role", role);
  await next();
});

export function requireRole(required: Exclude<Role, "anonymous">): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const role = c.get("role") ?? "anonymous";
    if (roleRank[role] < roleRank[required]) {
      throw new AuthError("insufficient_permission", "The token does not have sufficient permission", 403);
    }
    await next();
  });
}

export class AuthError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: 401 | 403) {
    super(message);
    this.name = "AuthError";
  }
}
