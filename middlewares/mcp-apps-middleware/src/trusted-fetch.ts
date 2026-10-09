/** Bind transport requests to one origin and reject redirects before credentials leave it. */
export function createTrustedFetch(origin: string): typeof fetch {
  return (target, init) => {
    const url = new URL(
      target instanceof Request ? target.url : String(target),
    );
    if (url.origin !== origin) {
      return Promise.reject(new Error("MCP transport changed origin"));
    }
    return fetch(target, {
      ...init,
      redirect: "error",
      // A failed handshake may have already aborted the SDK signal.
      ...(init?.method === "DELETE"
        ? { signal: AbortSignal.timeout(3_000) }
        : {}),
    });
  };
}
