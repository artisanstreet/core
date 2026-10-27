import { Data, Effect, Either, Match } from "effect";

const SECRET_PREFIX = "ast-core:secret:";

export function secretKey(requestId: string): string {
  return `${SECRET_PREFIX}${requestId}`;
}

const read_storage = (key: string): string | null =>
  Either.match(Either.try({ try: () => sessionStorage.getItem(key), catch: () => null }), {
    onLeft: (): string | null => null,
    onRight: (value): string | null => value,
  });

const write_storage = (key: string, value: string): boolean =>
  Either.match(Either.try({ try: () => sessionStorage.setItem(key, value), catch: () => null }), {
    onLeft: () => false,
    onRight: () => true,
  });

const delete_storage = (key: string): void => {
  Either.getOrNull(Either.try({ try: () => sessionStorage.removeItem(key), catch: () => null }));
};

export function storeRequestSecret(requestId: string, secret: string): void {
  if (!write_storage(secretKey(requestId), secret)) {
    memorySecrets.set(requestId, secret);
  }
}

const memorySecrets = new Map<string, string>();

export function loadRequestSecret(requestId: string): string | null {
  return read_storage(secretKey(requestId)) ?? memorySecrets.get(requestId) ?? null;
}

export function clearRequestSecret(requestId: string): void {
  delete_storage(secretKey(requestId));
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

export class FinalizeNotApproved extends Data.TaggedError("FinalizeNotApproved")<{
  readonly phase: LoginPhase;
}> {}

export class FinalizeExpired extends Data.TaggedError("FinalizeExpired")<{}> {}

export class FinalizeMissingSecret extends Data.TaggedError("FinalizeMissingSecret")<{}> {}

export class FinalizeTotpRequired extends Data.TaggedError("FinalizeTotpRequired")<{}> {}

export type FinalizeFailure = FinalizeNotApproved | FinalizeExpired | FinalizeMissingSecret | FinalizeTotpRequired;

export interface FinalizePayload {
  requestId: string;
  requestSecret: string;
  totpCode?: string;
  recoveryCode?: string;
}

const check_finalize = (args: {
  state: LoginState;
  opts: { requestSecret: string | null; totpCode?: string; recoveryCode?: string };
}): Either.Either<FinalizePayload, FinalizeFailure> => {
  const { state, opts } = args;
  if (state.phase === "expired") {
    return Either.left(new FinalizeExpired());
  }
  if (state.phase !== "email_approved") {
    return Either.left(new FinalizeNotApproved({ phase: state.phase }));
  }
  if (!opts.requestSecret) {
    return Either.left(new FinalizeMissingSecret());
  }
  if (state.totpRequired && !opts.totpCode && !opts.recoveryCode) {
    return Either.left(new FinalizeTotpRequired());
  }
  const payload: FinalizePayload = {
    requestId: state.requestId,
    requestSecret: opts.requestSecret,
  };
  if (opts.totpCode) payload.totpCode = opts.totpCode;
  if (opts.recoveryCode) payload.recoveryCode = opts.recoveryCode;
  return Either.right(payload);
};

export const finalizeFailureMessage = (failure: FinalizeFailure): string =>
  Match.value(failure).pipe(
    Match.tag("FinalizeExpired", () => "This sign-in request expired. Start over."),
    Match.tag("FinalizeNotApproved", () => "The emailed link has not been approved yet. Approve it first."),
    Match.tag(
      "FinalizeMissingSecret",
      () =>
        "This browser did not start the sign-in, so it cannot finish it. " +
        "Finish on the browser that requested the link.",
    ),
    Match.tag("FinalizeTotpRequired", () => "This account needs its authenticator code (or a recovery code)."),
    Match.exhaustive,
  );

export function finalizePayload(
  args: { state: LoginState; opts: { requestSecret: string | null; totpCode?: string; recoveryCode?: string } },
): { requestId: string; requestSecret: string; totpCode?: string; recoveryCode?: string } {
  return Either.match(check_finalize(args), {
    onLeft: (failure): never => {
      throw new Error(finalizeFailureMessage(failure));
    },
    onRight: (payload) => payload,
  });
}

export const validateFinalize = (args: {
  state: LoginState;
  opts: { requestSecret: string | null; totpCode?: string; recoveryCode?: string };
}): Either.Either<FinalizePayload, FinalizeFailure> => check_finalize(args);

export const finalize_effect = (
  args: {
    state: LoginState;
    opts: { requestSecret: string | null; totpCode?: string; recoveryCode?: string };
  },
): Effect.Effect<FinalizePayload, FinalizeFailure> =>
  Effect.gen(function* () {
    return yield* validateFinalize(args);
  });
