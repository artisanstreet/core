// Forge DTO subset (editor/crates/artisan-api/src/request.rs).
// Lenient: every field optional at the boundary; pages check what they show.

export interface ForgeThread {
  id: string;
  project_id?: string;
  title?: string | null;
  archived?: boolean;
  activity_seq?: number;
}

export interface ForgeThreadsPage {
  threads: ForgeThread[];
  next?: { activity_seq: number; id: string } | null;
  newer?: boolean;
}

export interface ForgeItem {
  id: string;
  thread_id?: string;
  position?: number;
  kind?: unknown;
}

export interface ForgeItemsPage {
  items: ForgeItem[];
  more: boolean;
}

export function asThreadsPage(body: unknown): ForgeThreadsPage {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const threads = Array.isArray(b.threads)
    ? (b.threads as Array<Record<string, unknown>>)
        .filter((t) => typeof t?.id === "string")
        .map((t) => ({
          id: t.id as string,
          project_id: typeof t.project_id === "string" ? t.project_id : undefined,
          title: typeof t.title === "string" ? t.title : null,
          archived: typeof t.archived === "boolean" ? t.archived : undefined,
          activity_seq: typeof t.activity_seq === "number" ? t.activity_seq : undefined,
        }))
    : [];
  return { threads, next: null, newer: false };
}

export function asItemsPage(body: unknown): ForgeItemsPage {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const items = Array.isArray(b.items)
    ? (b.items as Array<Record<string, unknown>>)
        .filter((i) => typeof i?.id === "string")
        .map((i) => ({ id: i.id as string, thread_id: typeof i.thread_id === "string" ? i.thread_id : undefined, position: typeof i.position === "number" ? i.position : undefined, kind: i.kind }))
    : [];
  return { items, more: b.more === true };
}

export interface ForgeState {
  forge_version?: string;
  protocol?: number;
  projects?: Array<{ id: string; name?: string | null; path?: string }>;
  threads?: ForgeThread[];
  head?: number;
}

/** One-line summary of an item's kind for the transcript list. */
export function itemSummary(item: ForgeItem): { kind: string; text: string } {
  const kind = item.kind;
  if (typeof kind === "string") return { kind, text: "" };
  if (typeof kind === "object" && kind !== null) {
    const k = kind as Record<string, unknown>;
    const tag = tag_of(k);
    const text = firstText(k);
    return { kind: tag, text };
  }
  return { kind: "item", text: "" };
}

function tag_of(k: Record<string, unknown>): string {
  // Serde-tagged enums arrive as {type: "...", ...} or {Variant: {...}}.
  if (typeof k.type === "string") return k.type;
  const keys = Object.keys(k);
  if (keys.length === 1 && typeof keys[0] === "string") return keys[0] as string;
  if (typeof k.kind === "string") return k.kind;
  return "item";
}

/** Best-effort text extraction for display; never throws, never invents.
 * `cap` bounds a single item (default 500 for summaries). Transcript
 * bodies pass a large cap: long threads must render whole, never silently
 * cut. When the cap hits, the caller must say so explicitly. */
export function firstText(value: unknown, depth = 0, cap = 500): string {
  if (depth > 4) return "";
  if (typeof value === "string") return value.length > cap ? `${value.slice(0, cap)}…` : value;
  if (Array.isArray(value)) {
    for (const v of value.slice(0, 8)) {
      const t = firstText(v, depth + 1, cap);
      if (t) return t;
    }
    return "";
  }
  if (typeof value === "object" && value !== null) {
    const o = value as Record<string, unknown>;
    for (const key of ["text", "body", "content", "message", "summary", "label"]) {
      const t = firstText(o[key], depth + 1, cap);
      if (typeof o[key] === "string" && t) return t;
    }
    for (const v of Object.values(o).slice(0, 12)) {
      const t = firstText(v, depth + 1, cap);
      if (t) return t;
    }
  }
  return "";
}

/**
 * Forge `TextContent`: untagged inline string or a stored-source ref
 * (content.rs). Stored sources need an explicit /content range load;
 * this returns the inline text, or null for stored refs AND for any other
 * shape. It deliberately does NOT dig into arbitrary objects: item kinds
 * carry their own `type` tag, which must never render as body text.
 */
export function textOf(tc: unknown): string | null {
  if (typeof tc === "string") return tc;
  if (typeof tc === "object" && tc !== null) {
    const o = tc as Record<string, unknown>;
    // Stored refs have an id + byte count; never render the id as text.
    if (typeof o.id === "string" && (typeof o.bytes === "number" || typeof o.content === "string")) return null;
  }
  return null;
}
