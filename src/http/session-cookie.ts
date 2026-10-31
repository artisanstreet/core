import { Option } from "effect";

export const MAX_ACCOUNTS = 8;

const token_shape = /^ast_sess_[A-Za-z0-9_-]+$/;

export interface Held {
  readonly token: string;
  readonly account_id: string;
}

export const parse_session_cookie = (raw: string | undefined): ReadonlyArray<string> => {
  const decoded = Option.fromNullable(raw).pipe(
    Option.flatMap((value) => Option.liftThrowable(decodeURIComponent)(value)),
    Option.getOrElse(() => ""),
  );
  const tokens = decoded.split(".").filter((token) => token_shape.test(token));
  return [...new Set(tokens)].slice(0, MAX_ACCOUNTS);
};

export const serialize_session_cookie = (tokens: ReadonlyArray<string>): string => tokens.join(".");

export const pick_session = <A extends Held>(held: ReadonlyArray<A>, selected: Option.Option<string>): Option.Option<A> =>
  Option.match(selected, {
    onNone: () => Option.fromNullable(held[0]),
    onSome: (account_id) => Option.fromNullable(held.find((entry) => entry.account_id === account_id)),
  });

export const tokens_after_sign_in = (held: ReadonlyArray<Held>, signed_in: Held): ReadonlyArray<string> =>
  [signed_in.token, ...held.filter((entry) => entry.account_id !== signed_in.account_id).map((entry) => entry.token)].slice(
    0,
    MAX_ACCOUNTS,
  );

export const tokens_without_account = (held: ReadonlyArray<Held>, account_id: string): ReadonlyArray<string> =>
  held.filter((entry) => entry.account_id !== account_id).map((entry) => entry.token);
