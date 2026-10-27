// Full transcript text for one item kind, in the contract's defined order.
// Reads the actual Forge ItemKind shapes (tagged `type` variants,
// TextContent inline-or-Stored, Collections inline-or-Stored) and preserves
// ALL text parts — no 8-item cap, no depth cap, no first-result shortcut.
// Unknown future variants fall back to the generic digger so additive Rust
// fields still show something. Summaries for lists keep using firstText.

import { firstText } from "./dto.ts";

/** Cap for rendered transcript bodies: whole threads, no silent cut. */
export const TRANSCRIPT_BODY_CAP = 2_000_000;

export interface StoredRef {
  id: string;
  bytes: number;
  label: string;
}

export interface TranscriptText {
  /** Complete text in defined order (may exceed the render cap). */
  text: string;
  /** Stored sources needing explicit /content range loads. */
  stored: StoredRef[];
  /** Notes about genuinely unavailable bytes (omitted server-side). */
  notices: string[];
}

function tc_into(tc: unknown, label: string, out: TranscriptText): void {
  if (typeof tc === "string") {
    out.text += tc;
    return;
  }
  if (typeof tc === "object" && tc !== null) {
    const o = tc as Record<string, unknown>;
    if (typeof o.id === "string" && typeof o.bytes === "number") {
      out.stored.push({ id: o.id, bytes: o.bytes, label });
      return;
    }
    const fallback = firstText(tc);
    if (fallback) out.text += fallback;
  }
}

function coll_into<T>(value: unknown, label: string, out: TranscriptText, each: (record: T, out: TranscriptText) => void): void {
  if (Array.isArray(value)) {
    for (const record of value) each(record as T, out);
    return;
  }
  if (typeof value === "object" && value !== null) {
    const o = value as Record<string, unknown>;
    const src = o.source as Record<string, unknown> | undefined;
    if (src && typeof src.content === "string") {
      out.stored.push({ id: src.content, bytes: typeof o.count === "number" ? o.count : 0, label });
      return;
    }
    if (typeof o.count === "number") {
      out.notices.push(`${label}: ${o.count} stored records (not fetched in this view)`);
    }
  }
}

function approval_into(approval: unknown, out: TranscriptText): void {
  if (typeof approval !== "object" || approval === null) return;
  const a = approval as Record<string, unknown>;
  if (typeof a.decision === "string") out.text += `\nDecision: ${a.decision}`;
  if (Array.isArray(a.options)) out.text += `\nOffered: ${(a.options as unknown[]).map(String).join(", ")}`;
}

function tool_into(tool: unknown, out: TranscriptText): void {
  if (typeof tool !== "object" || tool === null) return;
  const t = tool as Record<string, unknown>;
  const kind = typeof t.kind === "string" ? t.kind : "";
  switch (kind) {
    case "agent_message": {
      tc_into(t.text as Record<string, unknown> | undefined, "message", out);
      if (typeof t.recipient === "string") out.text += `\nTo: ${t.recipient}`;
      break;
    }
    case "shell": {
      tc_into(t.command, "command", out);
      if (typeof t.cwd === "string" && t.cwd) out.text += `\nIn ${t.cwd}`;
      break;
    }
    case "read": {
      if (typeof t.path === "string") out.text += t.path;
      if (Array.isArray(t.range)) out.text += ` @${(t.range as unknown[]).map(String).join("..")}`;
      break;
    }
    case "edit": {
      coll_into(t.changes, "edits", out, (ch: Record<string, unknown>, o2) => {
        if (typeof ch.path === "string") o2.text += `\n${ch.path} `;
        if (typeof ch.op === "string") o2.text += `(${ch.op})`;
        tc_into(ch.diff, "diff", o2);
      });
      break;
    }
    case "search": {
      if (typeof t.pattern === "string") out.text += t.pattern;
      if (typeof t.path === "string" && t.path) out.text += ` in ${t.path}`;
      break;
    }
    case "web_fetch": {
      if (typeof t.url === "string") out.text += t.url;
      break;
    }
    case "web_search": {
      if (typeof t.query === "string") out.text += t.query;
      break;
    }
    case "mcp": {
      if (typeof t.server === "string") out.text += `${t.server}.`;
      if (typeof t.tool === "string") out.text += t.tool;
      tc_into(t.input, "input", out);
      break;
    }
    case "view_image": {
      if (typeof t.path === "string") out.text += t.path;
      break;
    }
    default: {
      if (typeof t.name === "string") out.text += t.name;
      tc_into(t.input, "input", out);
      break;
    }
  }
}

/**
 * Full transcript text for one item kind, in the contract's defined order.
 * Every message part is preserved; nothing is capped here (rendering
 * caps with explicit Show-rest/download expansion instead).
 */
export function transcriptText(kind: unknown): TranscriptText {
  const out: TranscriptText = { text: "", stored: [], notices: [] };
  if (typeof kind !== "object" || kind === null) return out;
  const k = kind as Record<string, unknown>;
  const type = typeof k.type === "string" ? k.type : "";
  const push = (s: string) => {
    out.text += s;
  };
  switch (type) {
    case "user_message": {
      tc_into(k.text, "message", out);
      if (typeof k.sender === "object" && k.sender !== null) {
        const s = k.sender as Record<string, unknown>;
        if (typeof s.title === "string" && s.title) push(`\n— ${s.title}`);
      }
      break;
    }
    case "assistant_message": {
      tc_into(k.text, "reply", out);
      break;
    }
    case "tool": {
      if (typeof k.title === "string" && k.title) push(`${k.title}\n`);
      tool_into(k.tool, out);
      const output = k.output as Record<string, unknown> | null | undefined;
      if (output && typeof output === "object") {
        tc_into(output.text, "output", out);
        if (typeof output.omitted_bytes === "number" && output.omitted_bytes > 0) {
          out.notices.push(`${output.omitted_bytes} output bytes omitted server-side`);
        }
      }
      if (typeof k.exit_code === "number") push(`\nexit ${k.exit_code}`);
      approval_into(k.approval, out);
      break;
    }
    case "agent": {
      if (typeof k.label === "string" && k.label) push(`${k.label}\n`);
      else if (typeof k.name === "string" && k.name) push(`${k.name}\n`);
      tc_into(k.description, "task", out);
      tc_into(k.prompt, "prompt", out);
      tc_into(k.result, "result", out);
      if (typeof k.model === "string" && k.model) push(`\nModel: ${k.model}`);
      break;
    }
    case "question": {
      if (k.blocking) push("[blocking]\n");
      coll_into(k.questions, "questions", out, (q: Record<string, unknown>, o2) => {
        if (typeof q.header === "string" && q.header) o2.text += `\n${q.header}\n`;
        tc_into(q.text, "question", o2);
        coll_into(q.options, "options", out, (o: Record<string, unknown>, o3) => {
          if (typeof o.label === "string") o3.text += `\n- ${o.label}`;
          tc_into(o.description, "option", o3);
        });
      });
      const answers = k.answers;
      if (Array.isArray(answers)) {
        answers.forEach((a: unknown, i: number) => {
          if (a === null || a === undefined) return;
          const r = a as Record<string, unknown>;
          if (r.kind === "text" && typeof r.text === "string") out.text += `\nAnswer ${i + 1}: ${r.text}`;
          else if (r.kind === "choices" && Array.isArray(r.ids)) out.text += `\nAnswer ${i + 1}: ${(r.ids as unknown[]).map(String).join(", ")}`;
        });
      }
      tc_into(k.answer_text, "answers", out);
      break;
    }
    case "plan": {
      coll_into(k.steps, "steps", out, (s: Record<string, unknown>, o2) => {
        tc_into(s.text, "step", o2);
        if (typeof s.status === "string") o2.text += ` [${s.status}]`;
        o2.text += "\n";
      });
      tc_into(k.proposal, "proposal", out);
      approval_into(k.approval, out);
      break;
    }
    case "image": {
      tc_into(k.caption, "caption", out);
      break;
    }
    case "compaction": {
      tc_into(k.summary, "summary", out);
      const sw = k.switch as Record<string, unknown> | undefined;
      if (sw && typeof sw === "object") {
        const from = sw.from as Record<string, unknown> | undefined;
        const to = sw.to as Record<string, unknown> | undefined;
        const name = (m: Record<string, unknown> | undefined) => (typeof m?.name === "string" ? m.name : "?");
        out.text += `\nModel switch: ${name(from)} → ${name(to)}`;
      }
      break;
    }
    case "notice": {
      tc_into(k.text, "notice", out);
      break;
    }
    case "error": {
      tc_into(k.message, "error", out);
      break;
    }
    default: {
      const fallback = firstText(k);
      if (fallback) out.text += fallback;
      break;
    }
  }
  return out;
}
