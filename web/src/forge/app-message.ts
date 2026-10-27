// Inbound tunnel application messages as an explicit ADT shared by
// `ForgeSession` (unary) and `ForgeStream` (SUBSCRIBE answer).

import { Either, Match, Schema } from "effect";
import { isChunkFrame, TunnelChunk } from "./chunk.ts";
import { TunnelResponse } from "./codec.ts";

export type AppMessage =
  | { readonly _tag: "Chunk"; readonly chunk: TunnelChunk }
  | { readonly _tag: "Response"; readonly response: TunnelResponse }
  | { readonly _tag: "BadChunk"; readonly transfer: string; readonly reason: string }
  | { readonly _tag: "BadFrame" };

export const decode_app_message = (json: unknown): AppMessage =>
  Match.value(json).pipe(
    Match.when(isChunkFrame, (chunk_frame) =>
      Either.match(Schema.decodeUnknownEither(TunnelChunk)(chunk_frame), {
        onLeft: (e): AppMessage => ({ _tag: "BadChunk", transfer: chunk_frame.transfer, reason: e.message }),
        onRight: (chunk): AppMessage => ({ _tag: "Chunk", chunk }),
      }),
    ),
    Match.orElse((not_chunk) =>
      Either.match(Schema.decodeUnknownEither(TunnelResponse)(not_chunk), {
        onLeft: (): AppMessage => ({ _tag: "BadFrame" }),
        onRight: (response): AppMessage => ({ _tag: "Response", response }),
      }),
    ),
  );
