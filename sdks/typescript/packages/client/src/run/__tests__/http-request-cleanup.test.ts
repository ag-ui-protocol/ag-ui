import { setImmediate } from "node:timers/promises";
import { firstValueFrom, lastValueFrom } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runHttpRequest } from "../http-request";

// Real Web Streams retain their error for cancel(), which is essential to
// reproducing this lifecycle; a reader stub that resolves cancel misses it.
function responseWithCancel(cancel: UnderlyingSource<Uint8Array>["cancel"]) {
  return new Response(new ReadableStream<Uint8Array>({ cancel }));
}

afterEach(() => vi.restoreAllMocks());

describe("HTTP response cleanup", () => {
  it("preserves the original read failure without a detached cleanup rejection", async () => {
    const error = new Error("upstream failed");
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(error);
        },
      }),
    );
    await expect(lastValueFrom(runHttpRequest(async () => response))).rejects.toBe(error);
    await setImmediate();
  });

  it("reports an unexpected cancellation failure after early unsubscribe", async () => {
    const error = new Error("cancel failed");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cancel = vi.fn(() => Promise.reject(error));
    await firstValueFrom(runHttpRequest(async () => responseWithCancel(cancel)));
    await setImmediate();
    expect(cancel).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith("Failed to cancel HTTP response stream:", error);
  });

  it("keeps AbortError cancellation quiet", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cancel = vi.fn(() => Promise.reject(new DOMException("aborted", "AbortError")));
    await firstValueFrom(runHttpRequest(async () => responseWithCancel(cancel)));
    await setImmediate();
    expect(cancel).toHaveBeenCalledOnce();
    expect(warning).not.toHaveBeenCalled();
  });

  it("completes a healthy response", async () => {
    const response = new Response("healthy");
    const result = await lastValueFrom(runHttpRequest(async () => response));
    expect(result).toMatchObject({ type: "data", data: new TextEncoder().encode("healthy") });
    await setImmediate();
  });
});
