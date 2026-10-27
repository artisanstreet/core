// Remote-Forge session barrel: stable import surface for pages/tests.
// New code imports from `./relay/<module>` directly.

export { newEphemeralCnf, newChannelId, grantJti } from "./relay/cnf.ts";
export type { CnfKeypair } from "./relay/cnf.ts";
export { channel_url, default_link_factory, flush_outbound, initiate_secure, mint_channel_grant_effect, wait_open_effect } from "./relay/channel-connect.ts";
export { fetchPresence, fetch_presence_effect, PresenceFailure } from "./relay/presence.ts";
export type { Presence } from "./relay/presence.ts";
export { PacedSender, SendTimeoutError, SendWouldBlockError } from "./relay/paced-sender.ts";
export { ForgeSession } from "./relay/session.ts";
export type { ForgeSessionOptions } from "./relay/session.ts";
export { ForgeStream } from "./relay/stream.ts";
export type { ForgeStreamEvents, ForgeStreamOptions } from "./relay/stream.ts";
export type { RelayLinkLike, ChannelEvents, ForgeSessionEvent, SendStatus } from "./relay/transport.ts";
