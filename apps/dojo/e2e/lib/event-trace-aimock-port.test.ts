import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Exercise the actual setup import without pulling every fixture into the trace
// typecheck. Stop at the LLMock constructor so these checks never open a socket.
function setupWithPort(port: string | undefined) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.AIMOCK_PORT;
  if (port !== undefined) env.AIMOCK_PORT = port;
  return spawnSync(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      "--input-type=module",
      "--eval",
      `
        import { registerHooks } from 'node:module';
        registerHooks({
          resolve(specifier, context, nextResolve) {
            if (specifier === '@copilotkit/aimock') {
              const actual = nextResolve(specifier, context);
              return {
                url: 'data:text/javascript,' + encodeURIComponent(
                  'export * from ' + JSON.stringify(actual.url) + ';' +
                  'export class LLMock { constructor(options) { throw new Error("MOCK_OPTIONS:" + JSON.stringify(options)); } }'
                ),
                shortCircuit: true,
              };
            }
            return nextResolve(specifier, context);
          },
        });
        const { setupLLMock } = await import('./aimock-setup.ts');
        await setupLLMock();
      `,
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
}

for (const [configured, expected] of [
  [undefined, 5555],
  ["5556", 5556],
  ["1", 1],
  ["65535", 65535],
] as const) {
  test(`setup passes ${configured ?? "the absent default"} as port ${expected}`, () => {
    const result = setupWithPort(configured);
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    const options = result.stderr.match(/Error: MOCK_OPTIONS:(\{[^\n]+\})/);
    assert.ok(options, result.stderr);
    assert.equal(JSON.parse(options[1]).port, expected);
  });
}

for (const configured of ["5556x", "0", "1.5", "65536", "-1", "", "   "]) {
  test(`setup rejects explicit AIMOCK_PORT=${JSON.stringify(configured)} before constructing LLMock`, () => {
    const result = setupWithPort(configured);
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /AIMOCK_PORT must be an integer from 1 to 65535/,
    );
    assert.doesNotMatch(result.stderr, /Error: MOCK_OPTIONS:/);
  });
}
