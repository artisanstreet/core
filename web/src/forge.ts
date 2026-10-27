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
  as_tunnel_bytes,
  encode_tunnel_request,
  decode_tunnel_response,
  throw_if_tunnel_error,
  SINGLE_FRAME_BYTES,
  new_request_id,
} from "./forge/codec.ts";
export type { TunnelMethod as TunnelMethodType, TunnelRequest as TunnelRequestType, TunnelResponse as TunnelResponseType } from "./forge/codec.ts";
export {
  TunnelChunk,
  TRANSFER_MAX_BYTES,
  CHUNK_SEND_RAW_BYTES,
  is_chunk_frame,
  chunk_bytes,
  ChunkReassembly,
} from "./forge/chunk.ts";
export {
  as_threads_page,
  as_items_page,
  item_summary,
  first_text,
  text_of,
} from "./forge/dto.ts";
export type { ForgeThread, ForgeThreadsPage, ForgeItem, ForgeItemsPage, ForgeState } from "./forge/dto.ts";
export {
  pending_approval,
  pending_questions,
  approval_answer,
  question_answer,
  send_message_body,
} from "./forge/approval.ts";
export type { PendingApproval, PendingQuestion } from "./forge/approval.ts";
export { TRANSCRIPT_BODY_CAP, transcript_text } from "./forge/transcript.ts";
export type { StoredRef, TranscriptText } from "./forge/transcript.ts";
export { StreamStart, StreamEvent, as_stream_start, as_stream_event, as_live_envelope } from "./forge/stream-frames.ts";
export type { LiveEnvelope } from "./forge/stream-frames.ts";
export { decode_app_message } from "./forge/app-message.ts";
export type { AppMessage } from "./forge/app-message.ts";
