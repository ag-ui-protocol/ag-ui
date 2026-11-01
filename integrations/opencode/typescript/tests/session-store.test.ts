import { it, expect } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileSessionStore, sessionKey } from "../src/session-store";

it("durably stores opaque scoped mappings and excludes independent store instances", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-store-"));
  try {
    const a = new FileSessionStore(directory),
      b = new FileSessionStore(directory);
    const key = sessionKey("owner", "../../arbitrary-client-id", "/project");
    const release = await a.acquire(key);
    await expect(b.acquire(key)).rejects.toThrow(/busy/);
    await a.write(key, {
      sessionID: "server-created-session",
      consumed: ["u1"],
    });
    expect(await b.read(key)).toEqual({
      sessionID: "server-created-session",
      consumed: ["u1"],
    });
    expect((await stat(join(directory, `${key}.json`))).mode & 0o777).toBe(
      0o600,
    );
    expect(
      await b.read(
        sessionKey("other", "../../arbitrary-client-id", "/project"),
      ),
    ).toBeUndefined();
    expect(key).not.toBe(
      sessionKey("owner", "../../arbitrary-client-id", "/other-project"),
    );
    await release();
    await (
      await b.acquire(key)
    )();
    await expect(b.read("../escape")).rejects.toThrow("Invalid session key");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
