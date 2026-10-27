// Magic-link sign-in flow, with the request-secret binding that keeps a
// forwarded/scanned email link from signing anyone in.
//
// Rules (from core/docs/contracts.md §6 + http.ts behavior):
// - `requestMagicLink` returns a `requestSecret` ONCE to the originating
//   browser. It is kept in sessionStorage (`ast-core:secret:<requestId>`,
//   tab-scoped: closing the tab drops the secret) with a memory fallback,
//   and travels only in POST bodies, never in URLs.
// - Actual session lifecycle (Core, not the wire-doc cafe sketch): sign-in
//   sets a persistent HttpOnly `ast_session` cookie (30 days). Closing the
//   tab drops the Noise keys and the request secret, but NOT the Core
//   session — only explicit sign-out (session revoke) ends it. The UI says
//   exactly this on the Browsers page.
// - The emailed token only marks the request approved (`consume`, POST).
//   Link GET never consumes: opening the link in a mail scanner changes
//   nothing until the explicit approve POST.
// - `finalize` requires BOTH the approved token state AND the
//   `requestSecret`. A different browser (email opened on a phone) can
//   approve, but only the originating browser can finish sign-in.
// - Email alone never bypasses TOTP: when `totpRequired`, finalize needs
//   `totpCode` (or a recovery code).

const SECRET_PREFIX = "ast-core:secret:";

export function secretKey(requestId: string): string {
  return `${SECRET_PREFIX}${requestId}`;
}

function storageGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): boolean {
  try {
    sessionStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function storageDel(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export function storeRequestSecret(requestId: string, secret: string): void {
  if (!storageSet(secretKey(requestId), secret)) {
    // Private mode etc: the flow still works in this tab via memory.
    memorySecrets.set(requestId, secret);
  }
}

const memorySecrets = new Map<string, string>();

export function loadRequestSecret(requestId: string): string | null {
  return storageGet(secretKey(requestId)) ?? memorySecrets.get(requestId) ?? null;
}

export function clearRequestSecret(requestId: string): void {
  storageDel(secretKey(requestId));
  memorySecrets.delete(requestId);
}

export type LoginPhase = "idle" | "requested" | "pending" | "email_approved" | "completed" | "expired";

export interface LoginState {
  requestId: string;
  email: string;
  expiresAt: string;
  phase: LoginPhase;
  totpRequired: boolean;
}

/** Map a /v1/auth/magic/status response onto UI state. */
export function nextLoginState(
  current: LoginState,
  status: { status: "pending" | "email_approved" | "completed" | "expired"; totpRequired: boolean; email: string; expiresAt: string },
): LoginState {
  return {
    ...current,
    phase: status.status,
    totpRequired: status.totpRequired,
    email: status.email,
    expiresAt: status.expiresAt,
  };
}

/**
 * Guard for the finalize step. Returns the payload or throws with a
 * user-facing reason. Enforced in the client AND the page; the server
 * re-enforces.
 */
export function finalizePayload(
  args: { state: LoginState; opts: { requestSecret: string | null; totpCode?: string; recoveryCode?: string } },
): { requestId: string; requestSecret: string; totpCode?: string; recoveryCode?: string } {
  const { state, opts } = args;
  if (state.phase !== "email_approved") {
    throw new Error(
      state.phase === "expired"
        ? "This sign-in request expired. Start over."
        : "The emailed link has not been approved yet. Approve it first.",
    );
  }
  if (!opts.requestSecret) {
    throw new Error(
      "This browser did not start the sign-in, so it cannot finish it. " +
        "Finish on the browser that requested the link.",
    );
  }
  if (state.totpRequired && !opts.totpCode && !opts.recoveryCode) {
    throw new Error("This account needs its authenticator code (or a recovery code).");
  }
  const payload: { requestId: string; requestSecret: string; totpCode?: string; recoveryCode?: string } = {
    requestId: state.requestId,
    requestSecret: opts.requestSecret,
  };
  if (opts.totpCode) payload.totpCode = opts.totpCode;
  if (opts.recoveryCode) payload.recoveryCode = opts.recoveryCode;
  return payload;
}
