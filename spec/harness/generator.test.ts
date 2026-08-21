import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { buildModel } from "../generator/ir";
import { generateFiles, OUTPUT_DIR, SCHEMA_PATH } from "../generator/generate";
import { schema } from "./validator";

const files = await generateFiles();
const model = buildModel(schema);

describe("the generator", () => {
  it("is deterministic: generating twice produces identical output", async () => {
    expect(await generateFiles()).toEqual(files);
  });

  it("matches the committed output, byte for byte", () => {
    // This is the CI gate: a schema or generator change without a matching
    // regeneration fails here, and so does a hand edit to a generated file.
    const committed = readdirSync(OUTPUT_DIR).sort();
    expect(committed).toEqual(files.map((file) => file.name).sort());
    for (const file of files) {
      expect(
        readFileSync(join(OUTPUT_DIR, file.name), "utf8"),
        `${file.name} is stale — run: pnpm --filter @ag-ui/spec generate`,
      ).toBe(file.content);
    }
  });

  it("emits exactly 31 events", () => {
    const eventType = model.definitions.find(
      (definition) => definition.name === "EventType",
    );
    const eventUnion = model.definitions.find(
      (definition) => definition.name === "Event",
    );
    expect(eventType?.kind).toBe("enum");
    expect(eventUnion?.kind).toBe("union");
    if (eventType?.kind !== "enum" || eventUnion?.kind !== "union") return;
    expect(eventType.values).toHaveLength(31);
    expect(eventUnion.members).toHaveLength(31);
  });

  it("derives the version constant from the schema's own address", () => {
    // The constant is never typed by a human: it is the version segment of the
    // $id, which is also the directory the schema lives in.
    const directory = SCHEMA_PATH.split("/").at(-2);
    expect(model.version).toBe(directory);
    const version = files.find((file) => file.name === "version.ts");
    expect(version?.content).toContain(
      `export const PROTOCOL_VERSION = ${JSON.stringify(model.version)};`,
    );
  });

  it("marks every emitted file as generated", () => {
    for (const file of files) {
      expect(
        file.content.startsWith("// @generated"),
        `${file.name} has no @generated banner`,
      ).toBe(true);
      expect(file.content).toContain("DO NOT EDIT");
      expect(file.content).toContain(model.schemaId);
    }
  });

  it("accounts for every schema definition: emitted, or flattened as a mixin", () => {
    // A definition the reader silently dropped would vanish from every
    // generated SDK. Emitted definitions and mixins must partition $defs.
    const defs = Object.keys(schema.$defs as Record<string, unknown>).sort();
    const emitted = model.definitions.map((definition) => definition.name);
    const covered = [...emitted, ...model.mixins].sort();
    expect(covered).toEqual(defs);
    expect(model.mixins).toEqual(["Attributable", "BaseEvent", "BaseMessage"]);
  });

  it("keeps the generated directory out of the package's reachable surface", () => {
    // index.ts is the only entry, so nothing outside generated/ importing from
    // it means nothing exports it. The existing types keep their import paths.
    const srcDir = join(OUTPUT_DIR, "..");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (path !== OUTPUT_DIR) walk(path);
          continue;
        }
        if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx"))
          continue;
        const source = readFileSync(path, "utf8");
        if (/from\s+["'][^"']*generated[/"']/.test(source)) {
          offenders.push(relative(srcDir, path));
        }
      }
    };
    expect(existsSync(srcDir)).toBe(true);
    walk(srcDir);
    expect(offenders).toEqual([]);
  });
});
