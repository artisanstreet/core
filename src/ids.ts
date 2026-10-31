import { ulid } from "ulid";

export type IdPrefix =
  | "acct" | "sess" | "mch" | "enr" | "logreq"
  | "conn" | "art" | "bundle" | "tkn" | "evt" | "rc" | "oflow";

export function new_id(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}
