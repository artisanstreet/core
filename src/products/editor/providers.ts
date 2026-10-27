import { Effect } from "effect";
import { badRequest } from "../../errors.ts";

// Editor product: provider credential adapter rules.
//
// The vault stores API keys ONLY. Core performs no OAuth for providers:
// there are no subscription-OAuth flows, no invented provider APIs. The
// user pastes a provider-issued API key (created in the provider's own
// dashboard/CLI); the generic vault encrypts it at rest and releases the
// plaintext solely to assigned live machines of the same account.
//
// Supported adapters (verified integrations): Anthropic, OpenAI, OpenRouter
// (all API-key). Expected key shapes are documented below for UI hints;
// enforcement stays at sane length bounds so future provider rotations do
// not lock users out. OAuth-based "login with X" for providers is
// explicitly unavailable: use the harness's own local login, whose
// artifacts sync through engine_artifacts instead.
export const PROVIDER_KINDS = ["anthropic", "openai", "openrouter", "google"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const PROVIDER_KEY_HINTS: Record<ProviderKind, string> = {
  anthropic: "sk-ant-… (Anthropic Console API key)",
  openai: "sk-… (OpenAI API key)",
  openrouter: "sk-or-… (OpenRouter API key)",
  google: "AI… (Google AI Studio API key)",
};

export const validateProviderKey = (provider: string, apiKey: string) =>
  Effect.gen(function* () {
    if (!(PROVIDER_KINDS as readonly string[]).includes(provider)) {
      return yield* Effect.fail(badRequest("unsupported provider"));
    }
    const key = apiKey.trim();
    // Bounds only: prefixes rotate and must never lock users out.
    if (key.length < 8 || key.length > 4096) {
      return yield* Effect.fail(badRequest("apiKey looks invalid"));
    }
    return { provider: provider as ProviderKind, apiKey: key };
  });
