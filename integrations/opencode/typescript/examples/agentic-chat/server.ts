import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import {
  OpenCodeBridge,
  FileSessionStore,
  createSdkTransport,
  createRequestHandler,
} from "../../src/server";

async function main() {
  const fixture = process.env.OPENCODE_FIXTURE === "1";
  const token = process.env.AG_UI_TOKEN;
  if (!fixture && !token)
    throw new Error(
      "Set AG_UI_TOKEN for this single-user example (Dojo must send the same token).",
    );
  if (!fixture && !process.env.OPENCODE_URL)
    throw new Error(
      "Set OPENCODE_URL to a running, model-configured OpenCode server. See README.md.",
    );
  let baseUrl = process.env.OPENCODE_URL!;
  if (fixture) {
    const { startFixture } = await import("./fixture");
    baseUrl = (await startFixture()).url;
  }
  const directory = resolve(process.env.OPENCODE_DIRECTORY ?? process.cwd());
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  const model = process.env.OPENCODE_MODEL?.split("/");
  const transport = createSdkTransport({
    baseUrl,
    directory,
    headers: password
      ? {
          Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        }
      : undefined,
    model: model
      ? { providerID: model[0], modelID: model.slice(1).join("/") }
      : undefined,
  });
  const bridge = new OpenCodeBridge({
    transport,
    directory,
    store: new FileSessionStore(
      process.env.OPENCODE_SESSION_STORE ?? resolve(".opencode-ag-ui-sessions"),
    ),
  });
  const handler = createRequestHandler({
    bridge,
    directory,
    authenticate: async (req) =>
      fixture ||
      timingSafeEqual(
        createHash("sha256")
          .update(req.headers.authorization ?? "")
          .digest(),
        createHash("sha256").update(`Bearer ${token}`).digest(),
      )
        ? "example-owner"
        : undefined,
  });
  const server = createServer((req, res) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.listen(
    Number(process.env.PORT ?? 8031),
    fixture ? "127.0.0.1" : (process.env.HOST ?? "0.0.0.0"),
    () =>
      console.log(
        `OpenCode AG-UI example listening on port ${process.env.PORT ?? 8031}${fixture ? " (deterministic fixture)" : ""}`,
      ),
  );
}
void main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
