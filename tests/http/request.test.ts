import { describe, expect, it } from "vitest";
import { Cause, Effect } from "effect";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import { assemble_bytes, read_raw_body } from "../../src/http/request.ts";
import { max_body_bytes } from "../../src/http/response.ts";
import { CoreError } from "../../src/errors.ts";

const run_body = (request: Request) => {
  const req = HttpServerRequest.fromWeb(request);
  return Effect.runPromiseExit(read_raw_body.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, req)));
};

describe("request body chunk processing", () => {
  it("reassembles fragmented UTF-8 bytes exactly (split multi-byte sequences)", async () => {
    const original = "héllo 🌍 世界 𝄞 café naïve — end";
    const bytes = new TextEncoder().encode(original);
    const fragments: Array<Uint8Array> = [];
    for (let i = 0; i < bytes.length; i++) fragments.push(bytes.slice(i, i + 1));
    expect(fragments.length).toBeGreaterThan(10);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const f of fragments) c.enqueue(f);
        c.close();
      } });
    const request = new Request("http://localhost/v1/test", {
      method: "POST",
      body: stream as unknown as BodyInit,
      duplex: "half" } as unknown as RequestInit);
    const exit = await run_body(request);
    if (exit._tag === "Failure") throw new Error("expected success");
    expect(exit.value).toBe(original);
    expect(assemble_bytes(bytes.length, fragments).length).toBe(bytes.length);
  });

  it("fails over the 1MiB cap without draining upstream", async () => {
    const chunk_size = 65536;
    const available_chunks = 32;
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        if (pulled <= available_chunks) c.enqueue(new Uint8Array(chunk_size));
        else c.close();
      } });
    const request = new Request("http://localhost/v1/test", {
      method: "POST",
      body: stream as unknown as BodyInit,
      duplex: "half" } as unknown as RequestInit);
    const exit = await run_body(request);
    if (exit._tag === "Success") throw new Error("expected payload-too-large failure");
    const failure = Cause.failureOption(exit.cause);
    expect(failure._tag).toBe("Some");
    if (failure._tag === "Some") {
      expect(failure.value).toBeInstanceOf(CoreError);
      expect((failure.value as CoreError).code).toBe("payload_too_large");
    }
    expect(pulled).toBeLessThan(available_chunks);
    expect(pulled * chunk_size).toBeLessThanOrEqual(max_body_bytes + 2 * chunk_size);
  });
});
