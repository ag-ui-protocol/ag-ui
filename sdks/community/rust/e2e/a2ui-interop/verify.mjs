import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MessageProcessor } from "@a2ui/web_core/v0_9";
import { basicCatalog } from "@a2ui/web_core/v0_9/basic_catalog";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = JSON.parse(execFileSync("cargo", [
  "run", "--locked", "--quiet", "-p", "ag-ui-migration-tests", "--example", "a2ui_wire",
], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));

assert.equal(fixture.version, "v0.9.1");
assert.equal(fixture.catalogId, basicCatalog.id);
const processor = new MessageProcessor([basicCatalog]);
let original;

// A lossless representation for comparing ordinary objects, explicit null and
// JavaScript undefined/sparse slots to the SDK's local snapshot, never wire data.
function modelValue(value) {
  if (value === undefined) return {kind: "undefined"};
  if (value === null) return {kind: "null"};
  if (Array.isArray(value)) return {kind: "array", value: Array.from(value, modelValue)};
  if (typeof value === "object") return {kind: "object", value: Object.fromEntries(
    Object.entries(value).map(([key, value]) => [key, modelValue(value)]),
  )};
  return {kind: typeof value === "boolean" ? "bool" : typeof value, value};
}

for (const { name, messages, sdkData } of fixture.steps) {
  assert(messages.every(message => message.version === fixture.version));
  // Pass the Rust SDK's emitted messages directly to the official processor.
  processor.processMessages(messages);
  const surface = processor.model.getSurface(fixture.surfaceId);
  const data = surface?.dataModel;
  assert.deepEqual(
    surface ? {snapshot_version: 1, root: modelValue(data.get("/"))} : null,
    sdkData,
    `${name}: SDK and official core must agree before later steps overwrite state`,
  );

  switch (name) {
    case "create":
      original = surface;
      assert.equal(surface.catalog.id, fixture.catalogId);
      assert.equal(surface.componentsModel.get("root").type, "Column");
      assert.deepEqual(surface.componentsModel.get("title").properties.text, {path: "/title"});
      assert.equal(data.get("/title"), "Original review");
      assert.equal(data.get("/memo"), null);
      break;
    case "edit":
      assert.equal(data.get("/title"), "Reviewed title");
      assert.equal(data.get("/memo"), null);
      break;
    case "explicit-null":
      assert.equal(data.get("/memo"), null);
      assert(Object.hasOwn(data.get("/"), "memo"));
      assert.deepEqual(data.get("/items"), [1, null, 3]);
      assert.equal(data.get("/discard"), "temporary");
      break;
    case "upsert-missing-array":
      assert(Array.isArray(data.get("/list")));
      assert.deepEqual(data.get("/list"), ["first"]);
      break;
    case "upsert-null-parent":
      assert.deepEqual(data.get("/nullable"), {name: "nested"});
      assert.deepEqual(data.get("/nullableArray"), ["first"]);
      assert.equal(data.get("/memo"), null);
      break;
    case "upsert-sparse-array":
      assert.equal(data.get("/list").length, 6);
      assert.deepEqual(Array.from(data.get("/list")), ["first", undefined, undefined, "fourth", undefined, undefined]);
      assert.equal(data.get("/sparse").length, 3);
      assert.deepEqual(Array.from(data.get("/sparse")), [undefined, undefined, "third"]);
      assert.equal(Object.hasOwn(messages[2].updateDataModel, "value"), false);
      break;
    case "upsert-nested-array":
      assert(Array.isArray(data.get("/matrix")));
      assert.equal(data.get("/matrix").length, 1);
      assert(Array.isArray(data.get("/matrix/0")));
      assert.deepEqual(Array.from(data.get("/matrix/0")), [undefined, "inner"]);
      break;
    case "remove-object-key":
      assert.equal(Object.hasOwn(messages[0].updateDataModel, "value"), false);
      assert.equal(Object.hasOwn(data.get("/"), "discard"), false);
      assert.equal(data.get("/discard"), undefined);
      assert.equal(data.get("/memo"), null);
      break;
    case "remove-array-slot":
      assert.equal(Object.hasOwn(messages[0].updateDataModel, "value"), false);
      assert.equal(data.get("/items").length, 3);
      assert.equal(data.get("/items/0"), 1);
      assert.equal(data.get("/items/1"), undefined);
      assert.equal(data.get("/items/2"), 3);
      break;
    case "replace-component":
      assert.equal(surface.componentsModel.get("title").properties.text, "Replacement text");
      assert.equal([...surface.componentsModel.entries].length, 2);
      break;
    case "upsert-null-root":
      assert.deepEqual(data.get("/"), {name: "root restored"});
      break;
    case "delete":
      assert.equal(surface, undefined);
      break;
    case "recreate":
      assert.notEqual(surface, original);
      assert.equal(surface.componentsModel.get("root").type, "Text");
      assert.equal(surface.componentsModel.get("title"), undefined);
      assert.equal(data.get("/memo"), undefined);
      assert.deepEqual(data.get("/"), fixture.finalSdkData);
      break;
    default: throw new Error(`unchecked fixture step: ${name}`);
  }
  console.log(`PASS ${name}`);
}
assert.equal(fixture.steps.length, 13);
console.log("PASS @a2ui/web_core@0.11.0 consumed unmodified Rust A2UI v0.9.1 messages");
