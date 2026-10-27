import type { PostgresClient } from "reylo";

// Reylo's PostgresClient union structurally covers both our drivers:
// postgres.js Sql (unsafe()) in the Worker, PGlite (query()) in tests.
export type Db = PostgresClient;

export interface R2Like {
  put(key: string, body: Uint8Array | string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

export interface AppEnv {
  readonly vars: Record<string, string | undefined>;
  readonly hyperdrive_connection_string?: string;
  readonly admin_token?: string;
}
