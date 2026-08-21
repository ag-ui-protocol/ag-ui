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
import * as protoEvents from "../src/generated/events";
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
 * handwritten schemas strip subagentRunId from nested interrupts and messages
 * (it lands with #2350), so the JSON path and the binary path both lose it
 * today even though the wire carries Interrupt field 8 and Message field 10.
 * The byte fixtures therefore do not exercise those slots yet.
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
      expectNoUndefinedKeys(decoded);
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

describe("malformed wire input", () => {
  // The decode guards, each pinned: whatever a hostile or broken producer
  // sends, decode answers with an error, never with a different event than
  // another runtime would surface.
  const wrap = (payload: Record<string, unknown>): Uint8Array =>
    protoEvents.Event.encode(payload as never).finish();

  it("rejects an envelope with no populated entry", () => {
    expect(() => decode(wrap({}))).toThrow();
  });

  it("rejects a payload without a base event", () => {
    expect(() => decode(wrap({ toolCallEnd: { toolCallId: "c1" } }))).toThrow();
  });

  it("rejects an unmappable base event type", () => {
    expect(() =>
      decode(wrap({ toolCallEnd: { baseEvent: { type: 99 }, toolCallId: "c1" } })),
    ).toThrow();
  });

  it("rejects the synthetic UNRECOGNIZED type", () => {
    expect(() =>
      decode(wrap({ toolCallEnd: { baseEvent: { type: -1 }, toolCallId: "c1" } })),
    ).toThrow();
  });

  it("rejects a base event type that disagrees with the envelope entry", () => {
    expect(() =>
      decode(
        wrap({
          stepStarted: {
            baseEvent: { type: protoEvents.EventType.STEP_FINISHED },
            stepName: "plan",
          },
        }),
      ),
    ).toThrow(/envelope carries STEP_STARTED/);
  });

  it("rejects an envelope with more than one populated entry", () => {
    const first = encode({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m1",
    } as never);
    const second = encode({
      type: EventType.STEP_FINISHED,
      stepName: "plan",
    } as never);
    const concatenated = new Uint8Array([...first, ...second]);
    expect(() => decode(concatenated)).toThrow();
  });
});

describe("content part guards", () => {
  it("rejects a content part with no recognisable arm", () => {
    const bytes = protoEvents.Event.encode({
      messagesSnapshot: {
        baseEvent: { type: protoEvents.EventType.MESSAGES_SNAPSHOT },
        messages: [
          {
            id: "u1",
            role: "user",
            toolCalls: [],
            contentParts: [{}],
          },
        ],
      },
    } as never).finish();
    expect(() => decode(bytes)).toThrow(/unreadable content part/);
  });
});

describe("content part guards (exclusivity)", () => {
  const message = (fields: Record<string, unknown>): Uint8Array =>
    protoEvents.Event.encode({
      messagesSnapshot: {
        baseEvent: { type: protoEvents.EventType.MESSAGES_SNAPSHOT },
        messages: [{ id: "u1", role: "user", toolCalls: [], ...fields }],
      },
    } as never).finish();

  it("rejects string content alongside content parts", () => {
    expect(() =>
      decode(message({ content: "ok", contentParts: [{ text: { text: "hi" } }] })),
    ).toThrow(/both string content and content parts/);
  });

  it("rejects a part carrying more than one arm", () => {
    expect(() =>
      decode(
        message({
          contentParts: [
            {
              text: { text: "hi" },
              image: { source: { url: { value: "u" } } },
            },
          ],
        }),
      ),
    ).toThrow(/more than one arm/);
  });

  it("rejects a source carrying more than one arm", () => {
    expect(() =>
      decode(
        message({
          contentParts: [
            {
              image: {
                source: {
                  url: { value: "u" },
                  data: { value: "d", mimeType: "image/png" },
                },
              },
            },
          ],
        }),
      ),
    ).toThrow(/more than one arm/);
  });
});

describe("flattened outcome guards", () => {
  const wrap = (payload: Record<string, unknown>): Uint8Array =>
    protoEvents.Event.encode(payload as never).finish();
  const base = { type: protoEvents.EventType.RUN_FINISHED };

  it("rejects an unknown outcome value", () => {
    expect(() =>
      decode(
        wrap({
          runFinished: {
            baseEvent: base,
            threadId: "t1",
            runId: "r1",
            outcome: "cancelled",
            interrupts: [],
            usage: [],
          },
        }),
      ),
    ).toThrow(/unknown outcome/);
  });

  it("rejects a success outcome carrying interrupts", () => {
    expect(() =>
      decode(
        wrap({
          runFinished: {
            baseEvent: base,
            threadId: "t1",
            runId: "r1",
            outcome: "success",
            interrupts: [{ id: "i1", reason: "r" }],
            usage: [],
          },
        }),
      ),
    ).toThrow(/cannot carry interrupts/);
  });

  it("rejects an absent outcome carrying interrupts", () => {
    expect(() =>
      decode(
        wrap({
          runFinished: {
            baseEvent: base,
            threadId: "t1",
            runId: "r1",
            outcome: "",
            interrupts: [{ id: "i1", reason: "r" }],
            usage: [],
          },
        }),
      ),
    ).toThrow(/cannot carry interrupts/);
  });

  it("rejects an unknown subagent outcome value", () => {
    expect(() =>
      decode(
        wrap({
          subagentFinished: {
            baseEvent: { type: protoEvents.EventType.SUBAGENT_FINISHED },
            subagentRunId: "s1",
            outcome: "cancelled",
            interruptIds: [],
          },
        }),
      ),
    ).toThrow(/unknown outcome/);
  });

  it("rejects an absent subagent outcome carrying interrupt ids", () => {
    expect(() =>
      decode(
        wrap({
          subagentFinished: {
            baseEvent: { type: protoEvents.EventType.SUBAGENT_FINISHED },
            subagentRunId: "s1",
            outcome: "",
            interruptIds: ["i1"],
          },
        }),
      ),
    ).toThrow(/cannot carry interruptIds/);
  });

  it("rejects content parts on a role that has none", () => {
    const bytes = protoEvents.Event.encode({
      messagesSnapshot: {
        baseEvent: { type: protoEvents.EventType.MESSAGES_SNAPSHOT },
        messages: [
          {
            id: "a1",
            role: "assistant",
            content: "hi",
            toolCalls: [],
            contentParts: [{ text: { text: "erased" } }],
          },
        ],
      },
    } as never).finish();
    expect(() => decode(bytes)).toThrow(/role that has none/);
  });

  it("rejects an activity message carrying string content", () => {
    const bytes = protoEvents.Event.encode({
      messagesSnapshot: {
        baseEvent: { type: protoEvents.EventType.MESSAGES_SNAPSHOT },
        messages: [
          {
            id: "a1",
            role: "activity",
            content: "lost",
            activityContent: { progress: 1 },
            toolCalls: [],
            contentParts: [],
          },
        ],
      },
    } as never).finish();
    expect(() => decode(bytes)).toThrow(/other content forms/);
  });

  it("rejects a repeated envelope tag", () => {
    const first = encode({
      type: EventType.STEP_FINISHED,
      stepName: "plan",
    } as never);
    const second = encode({ type: EventType.STEP_FINISHED } as never);
    const concatenated = new Uint8Array([...first, ...second]);
    expect(() => decode(concatenated)).toThrow();
  });

  it("rejects a subagent success carrying interrupt ids", () => {
    expect(() =>
      decode(
        wrap({
          subagentFinished: {
            baseEvent: { type: protoEvents.EventType.SUBAGENT_FINISHED },
            subagentRunId: "s1",
            outcome: "success",
            interruptIds: ["i1"],
          },
        }),
      ),
    ).toThrow(/cannot carry interruptIds/);
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
