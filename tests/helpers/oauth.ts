import { Effect } from "effect";
import { base64urlnopad as base64url_nopad } from "@scure/base";
import { sha256 as noble_sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes as utf8_to_bytes } from "@noble/hashes/utils.js";
import { unauthorized } from "../../src/errors.ts";
import type { OauthClient, OauthProfile, OauthProvider } from "../../src/services/oauth.ts";

interface Grant {
  readonly provider: OauthProvider;
  readonly code_challenge: string;
  readonly redirect_uri: string;
  readonly profile: OauthProfile;
}

export interface FakeProvider {
  readonly client: OauthClient;
  approve(authorize_url: string, profile: OauthProfile): { state: string; code: string };
}

export function fake_provider(): FakeProvider {
  const grants = new Map<string, Grant>();
  let next_code = 0;
  const client: OauthClient = {
    authorize_url: (provider, request) => {
      const url = new URL(`https://${provider}.test/authorize`);
      url.search = new URLSearchParams({
        state: request.state,
        code_challenge: request.code_challenge,
        redirect_uri: request.redirect_uri }).toString();
      return Effect.succeed(url.toString());
    },
    exchange: (provider, request) => {
      const grant = grants.get(request.code);
      grants.delete(request.code);
      const challenge = base64url_nopad.encode(noble_sha256(utf8_to_bytes(request.code_verifier)));
      return grant &&
        grant.provider === provider &&
        grant.code_challenge === challenge &&
        grant.redirect_uri === request.redirect_uri
        ? Effect.succeed(grant.profile)
        : Effect.fail(unauthorized("sign-in with provider failed"));
    } };
  return {
    client,
    approve(authorize_url, profile) {
      const url = new URL(authorize_url);
      const provider = url.hostname.split(".")[0] as OauthProvider;
      const code = `code-${next_code++}`;
      grants.set(code, {
        provider,
        code_challenge: url.searchParams.get("code_challenge")!,
        redirect_uri: url.searchParams.get("redirect_uri")!,
        profile });
      return { state: url.searchParams.get("state")!, code };
    } };
}

export const provider_profile = (overrides: Partial<OauthProfile> = {}): OauthProfile => ({
  subject: "google-sub-1",
  verified_email: "ada@example.com",
  display_name: "Ada Lovelace",
  avatar_url: "https://avatars.test/ada.png",
  ...overrides });
