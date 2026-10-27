// Pending approvals/questions + answer/send bodies (request.rs).
// A tool/plan approval still waiting on the user (`decision: null`);
// a question item with no answers yet.

import { firstText, textOf } from "./dto.ts";

export interface PendingApproval {
  request: unknown;
  reason: string | null;
  options: string[];
}

/** A tool/plan approval still waiting on the user (`decision: null`). */
export function pendingApproval(kind: unknown): PendingApproval | null {
  if (typeof kind !== "object" || kind === null) return null;
  const k = kind as Record<string, unknown>;
  if (k.type !== "tool" && k.type !== "plan") return null;
  const approval = k.approval as Record<string, unknown> | null | undefined;
  if (typeof approval !== "object" || approval === null) return null;
  if (approval.decision !== null && approval.decision !== undefined) return null;
  const options = Array.isArray(approval.options) ? (approval.options as unknown[]).filter((o): o is string => typeof o === "string") : [];
  return { request: approval.request ?? null, reason: textOf(approval.reason), options };
}

export interface PendingQuestion {
  blocking: boolean;
  questions: Array<{ id: string; header: string | null; text: string | null; multiSelect: boolean; options: Array<{ id: string; label: string; description: string | null }> }>;
}

/** A question item with no answers yet. */
export function pendingQuestions(kind: unknown): PendingQuestion | null {
  if (typeof kind !== "object" || kind === null) return null;
  const k = kind as Record<string, unknown>;
  if (k.type !== "question") return null;
  if (k.answers !== null && k.answers !== undefined) return null;
  const list = inline_collection(k.questions);
  if (!list) return null;
  return {
    blocking: k.blocking === true,
    questions: list
      .filter((q): q is Record<string, unknown> => typeof q === "object" && q !== null && typeof (q as Record<string, unknown>).id === "string")
      .map((q) => ({
        id: q.id as string,
        header: typeof q.header === "string" ? q.header : null,
        text: textOf(q.text),
        multiSelect: q.multi_select === true,
        options: inline_collection(q.options)
          ?.filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null)
          .map((o) => ({
            id: typeof o.id === "string" ? o.id : "",
            label: typeof o.label === "string" ? o.label : "",
            description: textOf(o.description),
          })) ?? [],
      })),
  };
}

/** Forge `Collection<T>`: untagged inline array or a stored ref. Inline only. */
function inline_collection(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  return null;
}

/** `Answer` bodies for POST /items/{id}/answer (request.rs). */
export function approvalAnswer(decision: string): { type: string; decision: string } {
  return { type: "approval", decision };
}

export function questionAnswer(answers: Array<Array<string> | { text: string } | null>): { type: string; answers: unknown[] } {
  return {
    type: "question",
    answers: answers.map((a) => (a === null ? null : Array.isArray(a) ? { kind: "choices", ids: a } : { kind: "text", text: a.text })),
  };
}

/** `SendMessage` body for POST /threads/{id}/messages (request.rs). */
export function sendMessageBody(id: string, text: string): { id: string; text: string; images: string[] } {
  return { id, text, images: [] };
}

export { firstText, textOf };
