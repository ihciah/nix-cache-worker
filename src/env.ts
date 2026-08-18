import type { Role } from "./middleware/auth";

export type Bindings = {
  CACHE_BUCKET: R2Bucket;
  DB: D1Database;
  READ_TOKEN?: string;
  WRITE_TOKEN?: string;
  ADMIN_TOKEN?: string;
  DEFAULT_STORE_DIR?: string;
  DEFAULT_PRIORITY?: string;
  DEFAULT_WANT_MASS_QUERY?: string;
  DEFAULT_RETENTION_DAYS?: string;
  NIX_PUBLIC_SIGN_KEY?: string;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    requestId: string;
    role: Role;
  };
};

export type WorkerEnv = Bindings;
