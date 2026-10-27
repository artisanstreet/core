import { Data, Effect, Either, Match } from "effect";

const SECRET_PREFIX = "ast-core:secret:";

export function secret_key(request_id: string): string {
  return `${SECRET_PREFIX}${request_id}`;
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

export function store_request_secret(request_id: string, secret: string): void {
  if (!write_storage(secret_key(request_id), secret)) {
    memory_secrets.set(request_id, secret);
  }
}

const memory_secrets = new Map<string, string>();

export function load_request_secret(request_id: string): string | null {
  return read_storage(secret_key(request_id)) ?? memory_secrets.get(request_id) ?? null;
}

export function clear_request_secret(request_id: string): void {
  delete_storage(secret_key(request_id));
  memory_secrets.delete(request_id);
}

export type LoginPhase = "idle" | "requested" | "pending" | "email_approved" | "completed" | "expired";

export interface LoginState {
  request_id: string;
  email: string;
  expires_at: string;
  phase: LoginPhase;
  totp_required: boolean;
}

export function next_login_state(
  current: LoginState,
  status: { status: "pending" | "email_approved" | "completed" | "expired"; totp_required: boolean; email: string; expires_at: string },
): LoginState {
  return {
    ...current,
    phase: status.status,
    totp_required: status.totp_required,
    email: status.email,
    expires_at: status.expires_at,
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
  request_id: string;
  request_secret: string;
  totp_code?: string;
  recovery_code?: string;
}

const check_finalize = (args: {
  state: LoginState;
  opts: { request_secret: string | null; totp_code?: string; recovery_code?: string };
}): Either.Either<FinalizePayload, FinalizeFailure> => {
  const { state, opts } = args;
  if (state.phase === "expired") {
    return Either.left(new FinalizeExpired());
  }
  if (state.phase !== "email_approved") {
    return Either.left(new FinalizeNotApproved({ phase: state.phase }));
  }
  if (!opts.request_secret) {
    return Either.left(new FinalizeMissingSecret());
  }
  if (state.totp_required && !opts.totp_code && !opts.recovery_code) {
    return Either.left(new FinalizeTotpRequired());
  }
  const payload: FinalizePayload = {
    request_id: state.request_id,
    request_secret: opts.request_secret,
  };
  if (opts.totp_code) payload.totp_code = opts.totp_code;
  if (opts.recovery_code) payload.recovery_code = opts.recovery_code;
  return Either.right(payload);
};

export const finalize_failure_message = (failure: FinalizeFailure): string =>
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

export function finalize_payload(
  args: { state: LoginState; opts: { request_secret: string | null; totp_code?: string; recovery_code?: string } },
): { request_id: string; request_secret: string; totp_code?: string; recovery_code?: string } {
  return Either.match(check_finalize(args), {
    onLeft: (failure): never => {
      throw new Error(finalize_failure_message(failure));
    },
    onRight: (payload) => payload,
  });
}

export const validate_finalize = (args: {
  state: LoginState;
  opts: { request_secret: string | null; totp_code?: string; recovery_code?: string };
}): Either.Either<FinalizePayload, FinalizeFailure> => check_finalize(args);

export const finalize_effect = (
  args: {
    state: LoginState;
    opts: { request_secret: string | null; totp_code?: string; recovery_code?: string };
  },
): Effect.Effect<FinalizePayload, FinalizeFailure> =>
  Effect.gen(function* () {
    return yield* validate_finalize(args);
  });
