// Forge barrel: stable import surface for pages/tests.
// New code imports from `./forge/<module>` directly; this file re-exports
// everything so `../forge.ts` keeps working.

export {
  TunnelMethod,
  TunnelPath,
  TunnelRequest,
  TunnelResponse,
  TunnelBytes,
  BYTES_ENVELOPE_KEY,
  asTunnelBytes,
  base64urlEncode,
  base64urlDecode,
  encodeTunnelRequest,
  decodeTunnelResponse,
  throwIfTunnelError,
  SINGLE_FRAME_BYTES,
  newRequestId,
} from "./forge/codec.ts";
export type { TunnelMethod as TunnelMethodType, TunnelRequest as TunnelRequestType, TunnelResponse as TunnelResponseType } from "./forge/codec.ts";
export {
  TunnelChunk,
  TRANSFER_MAX_BYTES,
  CHUNK_SEND_RAW_BYTES,
  isChunkFrame,
  chunkBytes,
  ChunkReassembly,
} from "./forge/chunk.ts";
export {
  asThreadsPage,
  asItemsPage,
  itemSummary,
  firstText,
  textOf,
} from "./forge/dto.ts";
export type { ForgeThread, ForgeThreadsPage, ForgeItem, ForgeItemsPage, ForgeState } from "./forge/dto.ts";
export {
  pendingApproval,
  pendingQuestions,
  approvalAnswer,
  questionAnswer,
  sendMessageBody,
} from "./forge/approval.ts";
export type { PendingApproval, PendingQuestion } from "./forge/approval.ts";
export { TRANSCRIPT_BODY_CAP, transcriptText } from "./forge/transcript.ts";
export type { StoredRef, TranscriptText } from "./forge/transcript.ts";
export { StreamStart, StreamEvent, asStreamStart, asStreamEvent, asLiveEnvelope } from "./forge/stream-frames.ts";
export type { LiveEnvelope } from "./forge/stream-frames.ts";
export { decode_app_message } from "./forge/app-message.ts";
export type { AppMessage } from "./forge/app-message.ts";
