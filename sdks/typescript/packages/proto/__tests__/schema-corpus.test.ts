import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EventSchemas, EventType } from "@ag-ui/core";
import { decode, encode } from "../src/proto";

/**
 * The fixture corpus is the behavioural contract, and the binary transport
 * must carry the same protocol as the JSON path: every valid event fixture
 * round-trips through encode/decode to the same materialised event, absent
 * fields staying absent. Events the handwritten SDK does not know yet ride
 * structurally and must round-trip byte-true as well.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..", "..");
const FIXTURES_DIR = join(REPO_ROOT, "spec", "draft", "fixtures");
const BYTES_DIR = join(HERE, "__fixtures__", "bytes");

const KNOWN_TO_CORE = new Set<string>(Object.values(EventType));

interface Case {
  name: string;
  document: Record<string, unknown>;
}

const cases: Case[] = [];
for (const anchor of readdirSync(FIXTURES_DIR).sort()) {
  // Every event definition is named ...Event, and nothing else is.
  if (!anchor.endsWith("Event")) continue;
  const dir = join(FIXTURES_DIR, anchor, "valid");
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".json") || file.endsWith(".expect.json")) continue;
    cases.push({
      name: `${anchor}/${file}`,
      document: JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>,
    });
  }
}

/**
 * Schema-valid documents the handwritten models reject (a required-ness
 * divergence RECONCILIATION.md records: handwritten RunAgentInput requires
 * tools and context). The binary transport cannot tell an absent array from
 * an empty one, so decode materialises the input arrays as present-and-empty
 * — the one form every layer accepts. The JSON path still rejects the raw
 * document; over binary the stream normalises and validates.
 *
 * A further recorded divergence, invisible to these assertions: the
 * handwritten schemas strip Interrupt.subagentRunId (it lands with #2350), so
 * the JSON path and the binary path both lose it today even though the wire
 * carries field 8 for it. The byte fixtures therefore do not exercise that
 * slot yet.
 */
const BINARY_NORMALISED: Record<
  string,
  ((document: Record<string, unknown>) => unknown) | undefined
> = {
  "RunStartedEvent/with-input.json": (document) => ({
    ...document,
    input: {
      ...(document.input as Record<string, unknown>),
      tools: [],
      context: [],
      resume: [],
    },
  }),
};

/** No own key anywhere may hold undefined: absent means absent. */
function expectNoUndefinedKeys(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => expectNoUndefinedKeys(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    expect(entry, `${path}.${key} is an undefined-valued key`).not.toBe(undefined);
    expectNoUndefinedKeys(entry, `${path}.${key}`);
  }
}

/** What the JSON path materialises: validated where the SDK knows the type. */
function materialise(document: Record<string, unknown>): unknown {
  return KNOWN_TO_CORE.has(document.type as string) ? EventSchemas.parse(document) : document;
}

describe("every valid event fixture round-trips over the binary transport", () => {
  it("covers all 31 event types", () => {
    // A deleted fixture directory must not silently shrink the corpus.
    const covered = new Set(cases.map((entry) => entry.document.type));
    const declared = Object.values(EventType).filter(
      (value) => !String(value).startsWith("THINKING"),
    );
    expect(declared.filter((value) => !covered.has(value))).toEqual([]);
    expect(covered.size).toBe(31);
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))("%s", (name, entry) => {
    const normalise = BINARY_NORMALISED[name];
    if (normalise) {
      expect(() => materialise(entry.document)).toThrow();
      const decoded = decode(encode(entry.document as never));
      expect(decoded).toEqual(normalise(entry.document));
      return;
    }
    const expected = materialise(entry.document);
    const decoded = decode(encode(expected as never));
    expect(decoded).toEqual(expected);
    // toEqual cannot see undefined-valued keys, so absent-stays-absent gets
    // its own gate.
    expectNoUndefinedKeys(decoded);
  });
});

describe("byte fixtures", () => {
  // Committed bytes are the cross-runtime target: the .NET runtime proves
  // itself by reading bytes TypeScript wrote (and vice versa). Regenerate
  // with WRITE_PROTO_BYTE_FIXTURES=1 when the wire deliberately changes.
  const write = process.env.WRITE_PROTO_BYTE_FIXTURES === "1";

  const byteCases = cases;

  it.each(byteCases.map((entry) => [entry.name, entry] as const))(
    "%s matches its committed bytes",
    (name, entry) => {
      const normalise = BINARY_NORMALISED[name];
      const encodeInput = normalise ? entry.document : materialise(entry.document);
      const expected = normalise ? normalise(entry.document) : encodeInput;
      const bytes = encode(encodeInput as never);
      const path = join(BYTES_DIR, `${entry.name.replace(/[/]/g, "__")}.bin`);
      if (write) {
        mkdirSync(BYTES_DIR, { recursive: true });
        writeFileSync(path, bytes);
        return;
      }
      expect(existsSync(path), `${path} missing — run with WRITE_PROTO_BYTE_FIXTURES=1`).toBe(true);
      const committed = new Uint8Array(readFileSync(path));
      expect(Buffer.from(bytes).equals(Buffer.from(committed))).toBe(true);
      expect(decode(committed)).toEqual(expected);
    },
  );

  it("has no stale byte fixtures", () => {
    if (write || !existsSync(BYTES_DIR)) return;
    const expected = new Set(byteCases.map((entry) => `${entry.name.replace(/[/]/g, "__")}.bin`));
    const stale = readdirSync(BYTES_DIR).filter((file) => !expected.has(file));
    expect(stale).toEqual([]);
  });
});

describe("the wire code drift gate", () => {
  it("src/generated matches what protoc emits from the committed .proto files", () => {
    // The .proto files are generated by the spec generator (its own diff gate
    // covers them); this closes the second stage — a .proto change without a
    // matching protoc run, or a hand edit to the wire code, fails here.
    const packageDir = join(HERE, "..");
    const out = mkdtempSync(join(tmpdir(), "ag-ui-proto-gate-"));
    execFileSync(process.execPath, [join(packageDir, "scripts", "generate.mjs")], {
      cwd: packageDir,
      env: { ...process.env, PROTO_GENERATED_DIR: out },
      stdio: "pipe",
    });
    const walk = (dir: string, prefix = ""): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(join(dir, entry.name), `${prefix}${entry.name}/`)
          : [`${prefix}${entry.name}`],
      );
    const committedDir = join(packageDir, "src", "generated");
    const fresh = walk(out).sort();
    expect(walk(committedDir).sort()).toEqual(fresh);
    for (const file of fresh) {
      expect(
        readFileSync(join(committedDir, file), "utf8"),
        `${file} is stale — run: pnpm --filter @ag-ui/proto generate`,
      ).toBe(readFileSync(join(out, file), "utf8"));
    }
  }, 30000);
});
