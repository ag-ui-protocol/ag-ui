/**
 * The C# model emitter: protocol model in, the AGUI.Abstractions types out.
 *
 * Emits the public .NET protocol types — events, messages, content parts and
 * the run/interrupt types — in the SDK's established idiom: mutable sealed
 * classes with System.Text.Json attributes, camelCase wire names behind
 * PascalCase properties, computed discriminators referencing the const
 * classes, JsonElement for arbitrary JSON, and context-wide omission for
 * optionals. C# has no export-aliasing, so unlike TypeScript and Python the
 * emitter owns the historic name map (Message -> AGUIMessage, ResumeEntry ->
 * AGUIResume, ...) and the generated types carry the public names directly.
 *
 * Representation shims stay hand-written and are referenced, not emitted:
 * the JSON converters, AGUIUserContent (the string|parts union struct), the
 * serializer context, and non-protocol helpers.
 */

import type {
  Definition,
  Field,
  ObjectDefinition,
  ProtocolModel,
  TypeExpr,
} from "./ir";
import { NULLABLE_REQUIRED_STRINGS, PROP_NAME } from "./dotnet-idioms";
import { assertTableKeys } from "./tables";

/* ------------------------------------------------------------------ */
/* .NET idiom tables                                                    */
/* ------------------------------------------------------------------ */

/** Definition -> public C# type name, where they differ. */
const TYPE_NAME: Record<string, string> = {
  Message: "AGUIMessage",
  DeveloperMessage: "AGUIDeveloperMessage",
  SystemMessage: "AGUISystemMessage",
  AssistantMessage: "AGUIAssistantMessage",
  UserMessage: "AGUIUserMessage",
  ToolMessage: "AGUIToolMessage",
  ActivityMessage: "AGUIActivityMessage",
  ReasoningMessage: "AGUIReasoningMessage",
  Tool: "AGUITool",
  Context: "AGUIContext",
  Interrupt: "AGUIInterrupt",
  ResumeEntry: "AGUIResume",
  ToolCall: "AGUIToolCall",
  FunctionCall: "AGUIToolCallFunction",
  // The schema renamed the parts (InputContent -> ContentPart and so on,
  // PNI-427) when tool results started carrying them. The .NET classes keep
  // the names this SDK shipped its converters, tests and docs under; the
  // schema name is the key, the C# name the value, so the rename is visible
  // here rather than silently reverting to a default spelling.
  ContentPart: "AGUIInputContent",
  TextPart: "AGUITextInputContent",
  ImagePart: "AGUIImageInputContent",
  AudioPart: "AGUIAudioInputContent",
  VideoPart: "AGUIVideoInputContent",
  DocumentPart: "AGUIDocumentInputContent",
  PartSource: "AGUIInputContentSource",
  DataSource: "AGUIInputContentDataSource",
  UrlSource: "AGUIInputContentUrlSource",
  FileSource: "AGUIInputContentFileSource",
};

// PROP_NAME and NULLABLE_REQUIRED_STRINGS live in
// dotnet-idioms.ts: this emitter declares those properties and the protobuf
// mapper carries them, so the two have to read one table rather than two
// copies that can drift apart.

/** Non-discriminator const/enum strings with an idiomatic default. */
const STRING_DEFAULT: Record<string, string> = {
  "ResumeEntry.status": "ResumeStatus.Resolved",
};

/**
 * Ordinary JsonSerializer.Serialize has no context-wide omission setting.
 * Retain the existing input/tool defaults, and cover fields newly made
 * optional or introduced by the generated models. BaseEvent's three optional
 * fields are shared by the new chunk events, so their omission lives there.
 */
const DEFAULT_OMISSION_FIELDS = new Set([
  "RunAgentInput.parentRunId",
  "RunAgentInput.state",
  "RunAgentInput.tools",
  "RunAgentInput.context",
  "RunAgentInput.forwardedProps",
  "RunAgentInput.resume",
  "Tool.parameters",
  "RunAgentInput.protocolVersion",
  "RunStartedEvent.protocolVersion",
  "TextMessageStartEvent.role",
  "BaseEvent.timestamp",
  "BaseEvent.rawEvent",
  "BaseEvent.metadata",
]);

const DEFAULT_OMISSION_TYPES = new Set([
  "TextMessageChunkEvent",
  "ToolCallChunkEvent",
]);

/**
 * Fields whose representation is a hand-written shim; emitted verbatim.
 * AGUIContent owns the string|parts wire union. The user message's JSON is
 * written by AGUIMessageJsonConverter rather than by an attribute; the tool
 * message and the event that mints one are attribute-serialised, so theirs
 * goes through AGUIContentJsonConverter.
 */
const BESPOKE_PROPERTY: Record<string, string[]> = {
  "UserMessage.content": [
    "    // Wire format (string | ContentPart[]) is owned by AGUIMessageJsonConverter.",
    "    [JsonIgnore]",
    "    public AGUIContent Content { get; set; }",
  ],
  "ToolMessage.content": [
    "    // Wire format (string | ContentPart[]): a string, or an ordered list of parts.",
    '    [JsonPropertyName("content")]',
    "    [JsonConverter(typeof(AGUIContentJsonConverter))]",
    "    public AGUIContent Content { get; set; }",
  ],
  "ToolCallResultEvent.content": [
    "    // Wire format (string | ContentPart[]), exactly as on the tool message this event mints.",
    '    [JsonPropertyName("content")]',
    "    [JsonConverter(typeof(AGUIContentJsonConverter))]",
    "    public AGUIContent Content { get; set; }",
  ],
};

/** Base classes every union member inherits, and the abstract base emission. */
const UNION_BASES: Record<
  string,
  { discriminator: string; constClass: string }
> = {
  Message: { discriminator: "role", constClass: "AGUIRoles" },
  ContentPart: { discriminator: "type", constClass: "AGUIInputContentTypes" },
  PartSource: {
    discriminator: "type",
    constClass: "AGUIInputContentSourceTypes",
  },
  RunFinishedOutcome: {
    discriminator: "type",
    constClass: "RunFinishedOutcomeTypes",
  },
  SubagentFinishedOutcome: {
    discriminator: "type",
    constClass: "SubagentFinishedOutcomeTypes",
  },
};

/**
 * The unions this emitter does not model as a C# base class: Event has its own
 * hand-rolled hierarchy above, and JsonPatch rides as opaque JSON. Any other
 * union must have a UNION_BASES entry, or the emitted C# would name a class
 * nothing declares — see assertUnionsAreModelled.
 */
const UNMODELLED_UNIONS = new Set(["Event", "JsonPatchOperation"]);

/**
 * Definitions a field names but this emitter deliberately carries as opaque
 * JSON rather than as a C# type of their own. A reference to one is not a
 * dangling reference.
 */
const OPAQUE_REFS = new Set(["JsonPatch"]);

/**
 * Whether a type is one of the opaque references, or an alias that leads to
 * one. Both the property emitter and the reference-closure check ask this, so
 * neither can start seeing through an alias the other stops at.
 */
function namesAnOpaqueRef(
  defs: Map<string, Definition>,
  type: TypeExpr,
): boolean {
  if (type.kind !== "ref") return false;
  if (OPAQUE_REFS.has(type.name)) return true;
  const target = defs.get(type.name);
  return target?.kind === "alias" ? namesAnOpaqueRef(defs, target.type) : false;
}

/**
 * A union the schema gains without an entry above would otherwise emit a
 * reference to a class this emitter never writes, and the drift gate — which
 * only compares the generator against its own committed output — would accept
 * it. Fail at generation time instead, where the message can say what to add.
 */
function assertUnionsAreModelled(defs: Map<string, Definition>): void {
  const unmodelled = [...defs.values()]
    .filter(
      (definition) =>
        definition.kind === "union" &&
        !UNMODELLED_UNIONS.has(definition.name) &&
        UNION_BASES[definition.name] === undefined,
    )
    .map((definition) => definition.name);
  if (unmodelled.length > 0) {
    throw new Error(
      `no .NET union base for ${unmodelled.join(", ")} — add an entry to UNION_BASES ` +
        "(discriminator plus the const class its members' values live in), and emit that " +
        "const class alongside the others",
    );
  }
}

/**
 * The SDK's extra base between AGUIInputContent and the four media parts,
 * carrying the shared source/metadata pair. An idiom, not a schema shape.
 */
const MEDIA_PARTS = new Set([
  "ImagePart",
  "AudioPart",
  "VideoPart",
  "DocumentPart",
]);

/**
 * The fields AGUIMessage hoists out of the roles. Unlike BaseEvent, whose own
 * fields come from a mixin the schema declares (and are read from it), this
 * base is an SDK idiom: the schema's Message is a bare union.
 * assertMessageBaseFields keeps the set honest.
 */
const MESSAGE_BASE_FIELDS = new Set(["id", "metadata", "subagentRunId"]);

/**
 * A class this emitter writes may name another by reference, and a definition
 * nobody emits leaves that reference dangling: generation still succeeds, the
 * drift gate — which compares the generator only against its own output — still
 * passes, and the C# does not compile. Walk the emitted definitions' references
 * and insist every object among them is emitted too.
 */
function assertEveryReferencedObjectIsEmitted(
  defs: Map<string, Definition>,
  emitted: string[],
  emittedUnions: string[],
  extraShapes: ObjectDefinition[],
): void {
  const written = new Set(emitted);
  const writtenUnions = new Set(emittedUnions);
  const missing = new Set<string>();
  const visit = (type: TypeExpr, from: string): void => {
    if (type.kind === "array") return visit(type.items, from);
    if (type.kind !== "ref") return;
    if (namesAnOpaqueRef(defs, type)) return;
    const target = defs.get(type.name);
    if (target === undefined) return;
    if (target.kind === "alias") return visit(target.type, from);
    if (target.kind === "union") {
      // A union is emitted as its base plus its members, and only the union
      // families this emitter actually writes count: Event has its own
      // hierarchy above, and JsonPatch rides as opaque JSON, so a field
      // pointing at either names a class nothing declares.
      if (!writtenUnions.has(type.name)) {
        missing.add(`${from} -> ${type.name}`);
      }
      return;
    }
    // Enums ride as plain strings and have no class.
    if (target.kind !== "object") return;
    if (!written.has(type.name)) missing.add(`${from} -> ${type.name}`);
  };
  const shapes = [
    ...emitted
      .map((name) => defs.get(name))
      .filter(
        (definition): definition is ObjectDefinition =>
          definition?.kind === "object",
      ),
    // The bases this emitter writes itself, whose fields reference the schema
    // just as a member's do.
    ...extraShapes,
  ];
  for (const definition of shapes) {
    for (const field of definition.fields) visit(field.type, definition.name);
  }
  if (missing.size > 0) {
    throw new Error(
      `the .NET models reference objects this emitter does not write: ${[...missing].join(", ")} — ` +
        "add them to the plain types (or to whichever union family they belong to)",
    );
  }
}

/**
 * What a field's type is, for comparing two declarations of the same field: the
 * alias-resolved kind, or the definition a reference lands on, so narrowing an
 * inherited field to a different type does not pass for unchanged.
 */
function typeSignature(defs: Map<string, Definition>, type: TypeExpr): string {
  const resolved = resolveAlias(defs, type);
  if (resolved.kind === "array") {
    return `${typeSignature(defs, resolved.items)}[]`;
  }
  return resolved.kind === "ref" ? resolved.name : resolved.kind;
}

/**
 * Every event class inherits BaseEvent and skips the fields the base declares.
 * An event that composes something else, or that says something different about
 * an inherited field, would be emitted with the base's shape rather than its
 * own — in C# that still compiles.
 */
function assertEventsComposeBaseEvent(
  defs: Map<string, Definition>,
  baseEventShape: ObjectDefinition,
  events: ObjectDefinition[],
): void {
  for (const event of events) {
    if (!event.composedMixins.includes("BaseEvent")) {
      throw new Error(
        `${event.name} does not compose BaseEvent, which every emitted event class inherits`,
      );
    }
    for (const base of baseEventShape.fields) {
      // Each event narrows type to its own literal; that is the point of it.
      if (base.name === "type") continue;
      const own = event.fields.find((field) => field.name === base.name);
      if (own === undefined) {
        throw new Error(
          `${event.name} does not declare ${base.name}, which BaseEvent carries for it`,
        );
      }
      if (
        own.required !== base.required ||
        typeSignature(defs, own.type) !== typeSignature(defs, base.type)
      ) {
        throw new Error(
          `${event.name}.${base.name} is not the shape BaseEvent declares, so inheriting ` +
            "the base property would say something the schema does not",
        );
      }
    }
  }
}

/**
 * AGUIMediaInputContent hoists source and metadata out of the four media parts.
 * A member that declares either differently — a required metadata, a source
 * pointing somewhere else — would be flattened into a base that no longer
 * describes it, in C# that still compiles.
 */
function assertMediaPartsShareTheirBase(members: ObjectDefinition[]): void {
  for (const member of members) {
    const source = member.fields.find((field) => field.name === "source");
    if (
      source?.required !== true ||
      source.type.kind !== "ref" ||
      source.type.name !== "PartSource"
    ) {
      throw new Error(
        `${member.name}.source is not the required PartSource ref that ` +
          "AGUIMediaInputContent hoists — update the base or stop hoisting it",
      );
    }
    const metadata = member.fields.find((field) => field.name === "metadata");
    if (
      metadata === undefined ||
      metadata.required ||
      metadata.type.kind !== "any"
    ) {
      throw new Error(
        `${member.name}.metadata is not the optional any-JSON field that ` +
          "AGUIMediaInputContent hoists — update the base or stop hoisting it",
      );
    }
  }
}

/**
 * A field this base claims but some role does not declare would be hoisted out
 * of nothing, and the role would lose it. Fail at generation time rather than
 * emitting that.
 */
function assertMessageBaseFields(
  defs: Map<string, Definition>,
  members: ObjectDefinition[],
): void {
  // What the hand-written properties on AGUIMessage say, so a role that starts
  // saying something else about a hoisted field cannot be flattened into them.
  const expected: Record<string, { required: boolean; kind: string }> = {
    id: { required: true, kind: "string" },
    metadata: { required: false, kind: "openMap" },
    subagentRunId: { required: false, kind: "string" },
  };
  for (const name of MESSAGE_BASE_FIELDS) {
    const shape = expected[name];
    if (shape === undefined) {
      throw new Error(`AGUIMessage hoists ${name} with no expected shape`);
    }
    for (const member of members) {
      const field = member.fields.find((candidate) => candidate.name === name);
      if (field === undefined) {
        throw new Error(
          `AGUIMessage hoists ${name}, which ${member.name} does not declare — ` +
            "remove it from MESSAGE_BASE_FIELDS or give the base a shape every role shares",
        );
      }
      const kind = resolveAlias(defs, field.type).kind;
      if (field.required !== shape.required || kind !== shape.kind) {
        throw new Error(
          `${member.name}.${name} is ${field.required ? "required" : "optional"} ${kind}, ` +
            `which the ${shape.required ? "required" : "optional"} ${shape.kind} property on ` +
            "AGUIMessage does not express",
        );
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function pascal(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * A C# member name for a schema vocabulary value. The values are lower-case
 * words the schema separates however it likes (TEXT_MESSAGE_START, tool-call),
 * and a separator carried into the identifier would not compile, so each
 * segment is capitalised and joined.
 */
function csMember(value: string): string {
  const member = value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => pascal(segment))
    .join("");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(member)) {
    throw new Error(
      `the schema value "${value}" has no C# member name — name it explicitly ` +
        "rather than deriving one",
    );
  }
  return member;
}

function csName(definition: string): string {
  return TYPE_NAME[definition] ?? definition;
}

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Wraps a schema description as an XML doc comment. */
function doc(description: string, indent: string): string[] {
  if (description === "") return [];
  const words = xmlEscape(description).split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line !== "" && line.length + word.length + 1 > 76 - indent.length) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") lines.push(line);
  return [
    `${indent}/// <summary>`,
    ...lines.map((entry) => `${indent}/// ${entry}`),
    `${indent}/// </summary>`,
  ];
}

function banner(schemaId: string): string {
  return [
    "// <auto-generated />",
    "// @generated by spec/generator — DO NOT EDIT.",
    `// Source: ${schemaId}`,
    "// Regenerate: pnpm --filter @ag-ui/spec generate",
    "#nullable enable",
  ].join("\n");
}

function resolveAlias(defs: Map<string, Definition>, type: TypeExpr): TypeExpr {
  while (type.kind === "ref") {
    const target = defs.get(type.name);
    if (target?.kind !== "alias") return type;
    type = target.type;
  }
  return type;
}

/* ------------------------------------------------------------------ */
/* Property emission                                                    */
/* ------------------------------------------------------------------ */

interface EmitContext {
  defs: Map<string, Definition>;
  /** Union member -> the union it belongs to (for discriminators). */
  memberOf: Map<string, string>;
}

/** A whole optional JSON null is absent; nulls inside a value are untouched. */
function optionalJsonProperty(name: string): string[] {
  return [
    `    public JsonElement? ${name}`,
    "    {",
    "        get;",
    "        set => field = value is { ValueKind: JsonValueKind.Null or JsonValueKind.Undefined } ? null : value;",
    "    }",
  ];
}

/**
 * The schema constraints a property rejects on assignment.
 *
 * A JSON-Schema keyword nobody emits is a rule the .NET SDK simply does not
 * have: `-5` deserialises into a TokenUsage count with a `minimum: 0`, an empty
 * interrupt list satisfies `minItems: 1`, and a delta that is not a patch at
 * all lands in a bare JsonElement. The check rides on the SETTER rather than in
 * a converter so it holds on every path a value can arrive by — JSON, the
 * protobuf decoders, and a caller assigning the property — instead of only the
 * one the converters see.
 *
 * It throws JsonException because that is what the rest of this SDK throws for
 * a value the wire contract rejects (see BaseEventJsonConverter), and because
 * these properties exist to carry wire values: a caller assigning one out of
 * range has built an event that cannot be sent.
 */
function constraintChecks(
  context: EmitContext,
  definition: ObjectDefinition,
  field: Field,
): string[] {
  const where = `"${definition.name}", "${field.name}"`;
  // Patches ride as opaque JSON here, so nothing else would ever look at their
  // structure: processing.mdx makes a malformed known value fatal, and
  // state.mdx says a structurally malformed patch is exactly that.
  if (namesAnOpaqueRef(context.defs, field.type)) {
    return [`AGUIWireValidation.JsonPatch(${where}, value);`];
  }
  const resolved = resolveAlias(context.defs, field.type);
  if (resolved.kind === "integer") {
    if (resolved.minimum === undefined && resolved.maximum === undefined) {
      return [];
    }
    const min = resolved.minimum === undefined ? "long.MinValue" : `${resolved.minimum}L`;
    const max = resolved.maximum === undefined ? "long.MaxValue" : `${resolved.maximum}L`;
    return [`AGUIWireValidation.Range(${where}, value, ${min}, ${max});`];
  }
  if (resolved.kind === "string" && resolved.pattern !== undefined) {
    return [
      `AGUIWireValidation.Pattern(${where}, value, ${JSON.stringify(resolved.pattern)});`,
    ];
  }
  if (resolved.kind === "array" && resolved.minItems !== undefined) {
    return [`AGUIWireValidation.MinItems(${where}, value, ${resolved.minItems});`];
  }
  return [];
}

function csProperty(
  context: EmitContext,
  definition: ObjectDefinition,
  field: Field,
): string[] {
  const key = `${definition.name}.${field.name}`;
  const bespoke = BESPOKE_PROPERTY[key];
  if (bespoke) return bespoke;

  const propName = PROP_NAME[key] ?? pascal(field.name);
  const checks = constraintChecks(context, definition, field);
  /** The property body, with the schema's constraints on the way in. */
  const declare = (type: string, init = ""): string[] =>
    checks.length === 0
      ? [`    public ${type} ${propName} { get; set; }${init}`]
      : [
          `    public ${type} ${propName}`,
          "    {",
          "        get;",
          "        set",
          "        {",
          ...checks.map((check) => `            ${check}`),
          "            field = value;",
          "        }",
          `    }${init}`,
        ];
  const lines = doc(field.description, "    ");
  const attr = (name: string) => lines.push(`    ${name}`);
  attr(`[JsonPropertyName("${field.name}")]`);
  if (
    !field.required &&
    (DEFAULT_OMISSION_FIELDS.has(key) ||
      DEFAULT_OMISSION_TYPES.has(definition.name))
  ) {
    attr("[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]");
  }

  // Patches ride as raw JSON in this SDK; the protobuf mappers own the
  // structured form. Aliases are followed but not seen through: resolving the
  // JsonPatch alias would reach its array shape and emit a list of a class
  // this emitter never writes.
  if (namesAnOpaqueRef(context.defs, field.type)) {
    if (!field.required) {
      // Both patch fields are required today. An optional one would need the
      // null-means-absent setter AND the structural check in one body, which
      // this emitter does not write.
      throw new Error(
        `${key} is an optional opaque-JSON field — the .NET emitter writes the ` +
          "null-means-absent setter and the structural check as alternatives, " +
          "not as one body; teach csProperty to combine them",
      );
    }
    lines.push(...declare("JsonElement"));
    return lines;
  }

  const resolved = resolveAlias(context.defs, field.type);
  const union = context.memberOf.get(definition.name);

  // Discriminators are computed overrides referencing the const classes.
  if (union !== undefined && resolved.kind === "literal") {
    const base = UNION_BASES[union];
    if (base !== undefined && field.name === base.discriminator) {
      // The same derivation the const class declares its members with, so the
      // two cannot name the value differently.
      lines.push(
        `    public override string ${pascal(field.name)} => ${base.constClass}.${csMember(resolved.value)};`,
      );
      return lines;
    }
  }
  if (
    field.name === "type" &&
    resolved.kind === "literal" &&
    context.memberOf.get(definition.name) === "Event"
  ) {
    lines.push(
      `    public override string Type => AGUIEventTypes.${csMember(resolved.value)};`,
    );
    return lines;
  }

  // No per-property [JsonIgnore(WhenWritingNull)]: the omission rule lives once,
  // on the serializer context's DefaultIgnoreCondition, and a per-property
  // spelling would make a green omission sweep stop proving that setting works.
  const prop = (type: string, init = "") => lines.push(...declare(type, init));

  switch (resolved.kind) {
    case "string":
    case "literal":
    case "stringEnum": {
      const value =
        resolved.kind === "literal" ? `"${resolved.value}"` : undefined;
      const defaulted =
        STRING_DEFAULT[key] ?? (field.required ? value : undefined);
      if (field.required && !NULLABLE_REQUIRED_STRINGS.has(key)) {
        prop("string", ` = ${defaulted ?? "string.Empty"};`);
      } else {
        prop("string?");
      }
      return lines;
    }
    case "integer":
      if (field.required) {
        prop("long");
        return lines;
      }
      prop("long?");
      return lines;
    case "boolean":
      if (field.required) {
        prop("bool");
        return lines;
      }
      prop("bool?");
      return lines;
    case "any":
      if (field.required) {
        // Required, and JSON null is one of its legal values, so nullness
        // cannot stand for absence: the property is a bare JsonElement whose
        // default ValueKind, Undefined, is what "the producer never sent it"
        // looks like. AGUIWireGuard rejects that on the way in and
        // RequirePayload on the way out; a null the producer did send is held
        // as a Null-kind element and re-serialises as null.
        prop("JsonElement");
        return lines;
      }
      lines.push(...optionalJsonProperty(propName));
      return lines;
    case "openMap":
      if (field.required) {
        prop("JsonElement");
        return lines;
      }
      lines.push(...optionalJsonProperty(propName));
      return lines;
    case "array": {
      const items = resolveAlias(context.defs, resolved.items);
      const element = arrayElementType(context, key, items);
      if (field.required) {
        prop(`IList<${element}>`, " = [];");
      } else {
        prop(`IList<${element}>?`);
      }
      return lines;
    }
    case "ref": {
      const target = context.defs.get(resolved.name);
      if (target?.kind === "enum") {
        // Enums ride as plain strings in this SDK.
        if (field.required) {
          prop("string", ` = ${STRING_DEFAULT[key] ?? "string.Empty"};`);
        } else {
          prop("string?");
        }
        return lines;
      }
      if (field.required) {
        // A required object ref is a value the sender must have supplied, so the
        // property is non-nullable. Union bases are abstract and cannot be
        // constructed, so they lean on the deserializer to fill the slot.
        const isUnionBase = target?.kind === "union";
        prop(csName(resolved.name), isUnionBase ? " = null!;" : " = new();");
        return lines;
      }
      prop(`${csName(resolved.name)}?`);
      return lines;
    }
    default:
      throw new Error(`no .NET model mapping for ${key} (${resolved.kind})`);
  }
}

/**
 * The C# element type for an array field. Only the element kinds the protocol
 * uses today are mapped: anything else would otherwise land as JsonElement,
 * which compiles while quietly exposing the wrong shape, or name an enum class
 * this emitter does not write (enums ride as plain strings here).
 */
function arrayElementType(
  context: EmitContext,
  key: string,
  items: TypeExpr,
): string {
  if (items.kind === "ref") {
    const target = context.defs.get(items.name);
    if (target?.kind === "enum") return "string";
    return csName(items.name);
  }
  if (items.kind === "string" || items.kind === "stringEnum") return "string";
  if (items.kind === "any" || items.kind === "openMap") return "JsonElement";
  throw new Error(
    `no .NET element type for the ${items.kind} items of ${key} — add one to arrayElementType`,
  );
}
/* ------------------------------------------------------------------ */
/* Class and file emission                                              */
/* ------------------------------------------------------------------ */

function emitClass(
  context: EmitContext,
  definition: ObjectDefinition,
  options: { base?: string; sealed?: boolean; skip?: Set<string> },
): string {
  const name = csName(definition.name);
  const lines = doc(definition.description, "");
  const modifier = options.sealed === false ? "" : "sealed ";
  const base = options.base ? ` : ${options.base}` : "";
  lines.push(`public ${modifier}class ${name}${base}`);
  lines.push("{");
  const bodies: string[][] = [];
  for (const field of definition.fields) {
    if (options.skip?.has(field.name)) continue;
    bodies.push(csProperty(context, definition, field));
  }
  lines.push(bodies.map((body) => body.join("\n")).join("\n\n"));
  lines.push("}");
  return lines.join("\n");
}

/** An abstract union base with a computed discriminator. */
function emitUnionBase(
  name: string,
  description: string,
  discriminator: string,
  converter: string | undefined,
  extraFields: string[] = [],
): string {
  const lines = doc(description, "");
  if (converter) lines.push(`[JsonConverter(typeof(${converter}))]`);
  lines.push(`public abstract class ${csName(name)}`);
  lines.push("{");
  const body = [
    `    [JsonPropertyName("${discriminator}")]`,
    `    public abstract string ${pascal(discriminator)} { get; }`,
  ];
  lines.push([...extraFields, body.join("\n")].join("\n\n"));
  lines.push("}");
  return lines.join("\n");
}

function emitConstClass(
  name: string,
  description: string,
  entries: Array<[string, string]>,
): string {
  // Two schema values that differ only in case or separators derive the same
  // member name, which would emit the same constant twice.
  const seen = new Map<string, string>();
  for (const [member, value] of entries) {
    const first = seen.get(member);
    if (first !== undefined) {
      throw new Error(
        `${name}.${member} would be declared twice, for "${first}" and "${value}" — ` +
          "name one of them explicitly rather than deriving it",
      );
    }
    seen.set(member, value);
  }

  const lines = doc(description, "");
  lines.push(`public static class ${name}`);
  lines.push("{");
  lines.push(
    entries
      .map(
        ([member, value]) => `    public const string ${member} = "${value}";`,
      )
      .join("\n"),
  );
  lines.push("}");
  return lines.join("\n");
}


/* ------------------------------------------------------------------ */
/* Wire shapes                                                          */
/* ------------------------------------------------------------------ */

/**
 * The unions that own a JSON converter of their own.
 *
 * AGUIWireGuard walks the raw JSON a converter just read. Descending into a
 * value one of THESE unions covers would walk it twice, because System.Text.Json
 * invokes their converters for the nested value and each of those calls the
 * guard for itself. So they are the guard's entry points, never its children.
 */
const CONVERTER_OWNED_UNIONS = new Set([
  "Event",
  "Message",
  "ContentPart",
  "PartSource",
  "RunFinishedOutcome",
  "SubagentFinishedOutcome",
]);

/** A C# string literal. */
function csString(value: string): string {
  return JSON.stringify(value);
}

/**
 * The shape a field's value carries, for the guard's descent: the definition
 * name, or undefined when the field is a scalar, opaque JSON, or covered by a
 * converter of its own.
 */
function childShape(
  context: EmitContext,
  emitted: Set<string>,
  type: TypeExpr,
): string | undefined {
  if (type.kind === "array") return childShape(context, emitted, type.items);
  if (type.kind !== "ref") return undefined;
  if (namesAnOpaqueRef(context.defs, type)) return undefined;
  const target = context.defs.get(type.name);
  if (target?.kind === "alias") {
    return childShape(context, emitted, target.type);
  }
  if (target?.kind === "union") {
    return CONVERTER_OWNED_UNIONS.has(type.name) ? undefined : type.name;
  }
  if (target?.kind !== "object") return undefined;
  return emitted.has(type.name) ? type.name : undefined;
}

/** Whether a field is emitted as a bare JsonElement, whose default is absence. */
function isBarePayload(context: EmitContext, field: Field): boolean {
  if (!field.required) return false;
  if (namesAnOpaqueRef(context.defs, field.type)) return true;
  const resolved = resolveAlias(context.defs, field.type);
  return resolved.kind === "any" || resolved.kind === "openMap";
}

/**
 * The switch bodies AGUIWireGuard reads, emitted from the schema so a field the
 * schema gains is covered without anybody remembering to list it.
 *
 * Three questions, one per method, all keyed by DEFINITION name — the same
 * spelling the schema uses, not the C# class name, because the guard is
 * reasoning about the wire document and not about the objects it becomes.
 */
function emitWireShapes(
  context: EmitContext,
  shapes: ObjectDefinition[],
  emitted: Set<string>,
): string {
  /* ---- optional fields ---- */
  const optional: string[] = [];
  for (const shape of shapes) {
    const names = shape.fields
      .filter((field) => !field.required)
      .map((field) => csString(field.name));
    if (names.length === 0) continue;
    optional.push(
      `        ${csString(shape.name)} => field is ${names.join(" or ")},`,
    );
  }

  /* ---- children ---- */
  const children: string[] = [];
  for (const shape of shapes) {
    const arms = shape.fields
      .map((field): [string, string | undefined] => [
        field.name,
        childShape(context, emitted, field.type),
      ])
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([name, child]) => `${csString(name)} => ${csString(child)}`);
    if (arms.length === 0) continue;
    children.push(
      `        ${csString(shape.name)} => field switch`,
      "        {",
      ...arms.map((entry) => `            ${entry},`),
      "            _ => null,",
      "        },",
    );
  }

  /* ---- required arbitrary-JSON payloads ---- */
  const payloads: string[] = [];
  for (const shape of shapes) {
    const names = shape.fields
      .filter((field) => isBarePayload(context, field))
      .map((field) => field.name);
    if (names.length === 0) continue;
    payloads.push(`            case ${csString(shape.name)}:`);
    for (const name of names) {
      payloads.push(
        `                Require(json, ${csString(shape.name)}, ${csString(name)});`,
      );
    }
    payloads.push("                break;");
  }

  /* ---- union members ---- */
  const unions: string[] = [];
  for (const name of CONVERTER_OWNED_UNIONS) {
    const definition = context.defs.get(name);
    if (definition?.kind !== "union") {
      throw new Error(`${name} is not a union, so the wire guard has no members for it`);
    }
    const discriminator = definition.discriminator;
    if (discriminator === undefined) {
      throw new Error(
        `${name} has no discriminator, so AGUIWireGuard cannot tell its members apart`,
      );
    }
    const members = definition.members.map((member) => {
      const definitionOf = context.defs.get(member);
      if (definitionOf?.kind !== "object") {
        throw new Error(`${name} member ${member} is not an object`);
      }
      const field = definitionOf.fields.find(
        (candidate) => candidate.name === discriminator,
      );
      if (field?.type.kind !== "literal") {
        throw new Error(
          `${member}.${discriminator} is not a literal, so the wire guard cannot ` +
            `map a ${name} document onto it`,
        );
      }
      return `${csString(field.type.value)} => ${csString(member)}`;
    });
    unions.push(
      `        ${csString(name)} => Discriminated(json, ${csString(discriminator)}) switch`,
      "        {",
      ...members.map((entry) => `            ${entry},`),
      "            _ => null,",
      "        },",
    );
  }

  /* ---- JSON Patch operations ---- */
  const patchUnion = context.defs.get("JsonPatchOperation");
  if (patchUnion?.kind !== "union") {
    throw new Error("JsonPatchOperation is not a union");
  }
  const pointerAlias = context.defs.get("JsonPointer");
  if (pointerAlias?.kind !== "alias" || pointerAlias.type.kind !== "string") {
    throw new Error("JsonPointer is not a string alias");
  }
  const pointerPattern = pointerAlias.type.pattern;
  if (pointerPattern === undefined) {
    throw new Error("JsonPointer carries no pattern, so no pointer can be judged");
  }
  const patchArms: string[] = [];
  for (const member of patchUnion.members) {
    const definition = context.defs.get(member);
    if (definition?.kind !== "object") {
      throw new Error(`JsonPatchOperation member ${member} is not an object`);
    }
    const op = definition.fields.find((field) => field.name === "op");
    if (op?.type.kind !== "literal") {
      throw new Error(`${member}.op is not a literal`);
    }
    patchArms.push(`            case ${csString(op.type.value)}:`);
    for (const field of definition.fields) {
      if (!field.required || field.name === "op") continue;
      const resolved = resolveAlias(context.defs, field.type);
      if (resolved.kind === "string") {
        patchArms.push(
          `                AGUIWireValidation.RequirePointer(owner, name, operation, ${csString(field.name)});`,
        );
        continue;
      }
      if (resolved.kind === "any") {
        patchArms.push(
          `                AGUIWireValidation.RequireMember(owner, name, operation, ${csString(field.name)});`,
        );
        continue;
      }
      throw new Error(
        `${member}.${field.name} is a required ${resolved.kind}, which the .NET patch ` +
          "check has no rule for — teach emitWireShapes what to assert about it",
      );
    }
    patchArms.push("                break;");
  }

  return [
    "/// <summary>",
    "/// What the wire document for each schema definition looks like, as the three",
    "/// questions <c>AGUIWireGuard</c> asks while it walks one: which of a shape's",
    "/// fields are optional, which of its fields carry another shape, and which of",
    "/// its arbitrary-JSON payloads the schema requires. Keyed by the SCHEMA's own",
    "/// definition names, because the guard reasons about the document rather than",
    "/// about the classes it becomes.",
    "/// </summary>",
    "internal static class AGUIWireShapes",
    "{",
    "    /// <summary>The RFC 6901 pointer pattern, as the schema states it.</summary>",
    `    internal const string JsonPointerPattern = ${csString(pointerPattern)};`,
    "",
    "    /// <summary>Whether the schema declares <paramref name=\"field\"/> optional on <paramref name=\"shape\"/>.</summary>",
    "    internal static bool IsOptional(string shape, string field) => shape switch",
    "    {",
    ...optional,
    "        _ => false,",
    "    };",
    "",
    "    /// <summary>The shape the guard descends into, or null where it stops.</summary>",
    "    internal static string? Child(string shape, string field) => shape switch",
    "    {",
    ...children,
    "        _ => null,",
    "    };",
    "",
    "    /// <summary>The member a union document selects, or null when it names none.</summary>",
    "    internal static string? Member(string shape, JsonElement json) => shape switch",
    "    {",
    ...unions,
    "        _ => null,",
    "    };",
    "",
    "    /// <summary>",
    "    /// Rejects a document missing an arbitrary-JSON field the schema requires.",
    "    /// These properties are bare JsonElements: an absent one and an explicit",
    "    /// null both read as no value once deserialised, and only the first is",
    "    /// invalid, so presence has to be judged here on the document itself.",
    "    /// </summary>",
    "    internal static void RequirePayloads(string shape, JsonElement json)",
    "    {",
    "        switch (shape)",
    "        {",
    ...payloads,
    "            default:",
    "                break;",
    "        }",
    "    }",
    "",
    "    /// <summary>",
    "    /// Rejects one RFC 6902 operation that is not the shape its op names.",
    "    /// Open on purpose: RFC 6902 section 4 requires members an operation does",
    "    /// not define to be ignored rather than rejected.",
    "    /// </summary>",
    "    internal static void ValidatePatchOperation(string owner, string name, JsonElement operation)",
    "    {",
    "        var op = AGUIWireValidation.RequireOp(owner, name, operation);",
    "        switch (op)",
    "        {",
    ...patchArms,
    "            default:",
    "                // An op RFC 6902 does not define is an unrecognised union",
    "                // member, not a malformed known one: TypeScript's strip stage",
    "                // drops the operation and applies the rest of the patch",
    "                // (conformance stream state-delta-unknown-op-dropped), so",
    "                // rejecting the whole event here would be stricter than the",
    "                // protocol. This SDK carries the patch as opaque JSON and has",
    "                // no reducer to drop it from, so it passes it along unjudged.",
    "                break;",
    "        }",
    "    }",
    "",
    "    private static void Require(JsonElement json, string shape, string field)",
    "    {",
    "        if (json.ValueKind == JsonValueKind.Object && !json.TryGetProperty(field, out _))",
    "        {",
    "            throw new JsonException(",
    "                $\"Invalid {shape}: '{field}' is required, and the document does not carry it.\");",
    "        }",
    "    }",
    "",
    "    private static string? Discriminated(JsonElement json, string discriminator) =>",
    "        json.ValueKind == JsonValueKind.Object",
    "        && json.TryGetProperty(discriminator, out var value)",
    "        && value.ValueKind == JsonValueKind.String",
    "            ? value.GetString()",
    "            : null;",
    "}",
  ].join("\n");
}

const FILE_USINGS = [
  "using System.Collections.Generic;",
  "using System.Text.Json;",
  "using System.Text.Json.Serialization;",
  "",
  "namespace AGUI.Abstractions;",
].join("\n");

export interface GeneratedDotnetModelFile {
  name: string;
  content: string;
}

/**
 * Definitions this emitter deliberately writes no C# class for, each with the
 * reason. Everything else the schema declares as an object or a union has to be
 * emitted: the class list below is written by hand, so a definition the schema
 * gains and nobody adds to it is simply absent from .NET — while TypeScript and
 * Python emit it, and the drift gate, which compares the generator only against
 * its own output, stays green.
 */
const NOT_IN_DOTNET = new Set([
  // JSON Patch rides as opaque JsonElement in this SDK (see OPAQUE_REFS): the
  // operations have no C# classes, so neither does the union over them.
  "JsonPatchOperation",
  "AddOperation",
  "RemoveOperation",
  "ReplaceOperation",
  "MoveOperation",
  "CopyOperation",
  "TestOperation",
]);

/** Every object and union either becomes a C# class or says why it does not. */
function assertEveryDefinitionIsEmitted(
  model: ProtocolModel,
  emitted: Iterable<string>,
): void {
  const written = new Set(emitted);
  const missing = model.definitions
    .filter(
      (definition) =>
        (definition.kind === "object" || definition.kind === "union") &&
        !written.has(definition.name) &&
        !NOT_IN_DOTNET.has(definition.name),
    )
    .map((definition) => definition.name);
  if (missing.length > 0) {
    throw new Error(
      `the .NET models write no class for ${missing.join(", ")} — the class list is written ` +
        "by hand, so a definition nobody adds to it silently has no .NET representation at " +
        "all; add it to the plain types (or to whichever union family it belongs to), or to " +
        "NOT_IN_DOTNET with the reason it has none",
    );
  }
}

export function emitDotnetModels(
  model: ProtocolModel,
): GeneratedDotnetModelFile[] {
  assertTableKeys("TYPE_NAME", Object.keys(TYPE_NAME), model);
  assertTableKeys("PROP_NAME", Object.keys(PROP_NAME), model);
  assertTableKeys("STRING_DEFAULT", Object.keys(STRING_DEFAULT), model);
  assertTableKeys("DEFAULT_OMISSION_FIELDS", DEFAULT_OMISSION_FIELDS, model);
  assertTableKeys("DEFAULT_OMISSION_TYPES", DEFAULT_OMISSION_TYPES, model);
  assertTableKeys("BESPOKE_PROPERTY", Object.keys(BESPOKE_PROPERTY), model);
  assertTableKeys(
    "NULLABLE_REQUIRED_STRINGS",
    NULLABLE_REQUIRED_STRINGS,
    model,
  );
  const defs = new Map(model.definitions.map((d) => [d.name, d]));
  const memberOf = new Map<string, string>();
  for (const definition of model.definitions) {
    if (definition.kind !== "union") continue;
    for (const member of definition.members) {
      memberOf.set(member, definition.name);
    }
  }
  assertUnionsAreModelled(defs);
  const context: EmitContext = { defs, memberOf };
  const objectDef = (name: string): ObjectDefinition => {
    const definition = defs.get(name);
    if (definition?.kind !== "object")
      throw new Error(`${name} is not an object`);
    return definition;
  };
  const enumDef = (name: string) => {
    const definition = defs.get(name);
    if (definition?.kind !== "enum") throw new Error(`${name} is not an enum`);
    return definition;
  };
  const unionDef = (name: string) => {
    const definition = defs.get(name);
    if (definition?.kind !== "union") throw new Error(`${name} is not a union`);
    return definition;
  };
  const file = (
    name: string,
    ...sections: string[]
  ): GeneratedDotnetModelFile => ({
    name,
    content: [banner(model.schemaId), FILE_USINGS, ...sections, ""].join(
      "\n\n",
    ),
  });

  /**
   * The members of a union's discriminator const class, read from the members
   * themselves: adding a role, a content type or an outcome to the schema adds
   * its constant here rather than leaving the emitted C# naming one that does
   * not exist.
   */
  const unionConstMembers = (unionName: string): Array<[string, string]> => {
    const { discriminator } = UNION_BASES[unionName];
    return unionDef(unionName).members.map((member) => {
      const field = objectDef(member).fields.find(
        (candidate) => candidate.name === discriminator,
      );
      if (field?.type.kind !== "literal") {
        throw new Error(
          `${member}.${discriminator} is not a literal, so the .NET const class ` +
            `for the ${unionName} union cannot be derived from the schema`,
        );
      }
      return [csMember(field.type.value), field.type.value];
    });
  };

  /* ---- const classes ---- */
  const eventTypes = emitConstClass(
    "AGUIEventTypes",
    enumDef("EventType").description,
    enumDef("EventType").values.map((value) => [csMember(value), value]),
  );
  const roles = emitConstClass(
    "AGUIRoles",
    "Constants for AG-UI message role discriminators.",
    unionConstMembers("Message"),
  );
  const resumeStatus = emitConstClass(
    "ResumeStatus",
    "Constants for the resume entry status discriminator.",
    // An inline enum on the field rather than a named definition, so its values
    // are read from there.
    (() => {
      const status = objectDef("ResumeEntry").fields.find(
        (field) => field.name === "status",
      );
      if (status?.type.kind !== "stringEnum") {
        throw new Error("ResumeEntry.status is not a string enum");
      }
      return status.type.values.map((value): [string, string] => [
        csMember(value),
        value,
      ]);
    })(),
  );
  const outcomeTypes = emitConstClass(
    "RunFinishedOutcomeTypes",
    unionDef("RunFinishedOutcome").description,
    unionConstMembers("RunFinishedOutcome"),
  );
  const subagentOutcomeTypes = emitConstClass(
    "SubagentFinishedOutcomeTypes",
    unionDef("SubagentFinishedOutcome").description,
    unionConstMembers("SubagentFinishedOutcome"),
  );
  const inputContentTypes = emitConstClass(
    "AGUIInputContentTypes",
    unionDef("ContentPart").description,
    unionConstMembers("ContentPart"),
  );
  const sourceTypes = emitConstClass(
    "AGUIInputContentSourceTypes",
    unionDef("PartSource").description,
    unionConstMembers("PartSource"),
  );

  /* ---- events ---- */
  const baseEventShape = model.mixinShapes.find((s) => s.name === "BaseEvent");
  if (!baseEventShape) throw new Error("BaseEvent mixin missing");
  const baseEvent = [
    ...doc(baseEventShape.description, ""),
    "[JsonConverter(typeof(BaseEventJsonConverter))]",
    "public abstract class BaseEvent",
    "{",
    [
      [
        '    [JsonPropertyName("type")]',
        "    public abstract string Type { get; }",
      ].join("\n"),
      ...baseEventShape.fields
        .filter((field) => field.name !== "type")
        .map((field) => csProperty(context, baseEventShape, field).join("\n")),
    ].join("\n\n"),
    "}",
  ].join("\n");

  // BaseEvent is emitted from the schema's mixin, so the fields its events must
  // not redeclare are exactly that mixin's. subagentRunId is not among them:
  // the schema composes it from Attributable, which the run-scoped events omit
  // and the three subagent lifecycle events require, so it rides per event.
  const eventBaseFields = new Set(
    baseEventShape.fields
      .map((field) => field.name)
      .filter((name) => name !== "type"),
  );

  assertEventsComposeBaseEvent(
    defs,
    baseEventShape,
    unionDef("Event").members.map(objectDef),
  );

  const eventClasses = unionDef("Event").members.map((member) =>
    emitClass(context, objectDef(member), {
      base: "BaseEvent",
      skip: eventBaseFields,
    }),
  );

  /* ---- messages ---- */
  const baseMessage = [
    ...doc("Any message in a conversation. Discriminated by role.", ""),
    "[JsonConverter(typeof(AGUIMessageJsonConverter))]",
    "public abstract class AGUIMessage",
    "{",
    [
      [
        ...doc(
          "Identifies this message. Every role requires it, so the property is non-nullable: an empty id is schema-valid and rides as empty, but an absent one is not a message the protocol describes.",
          "    ",
        ),
        '    [JsonPropertyName("id")]',
        "    public string Id { get; set; } = string.Empty;",
      ].join("\n"),
      [
        '    [JsonPropertyName("role")]',
        "    public abstract string Role { get; }",
      ].join("\n"),
      [
        ...doc(
          "Extra information attached to this message, open by key. Any JSON value is allowed under a key, including null. The object itself is absent or an object, never null. The ag-ui key is reserved for AG-UI's own use; see AGUIMetadata.ReservedKey.",
          "    ",
        ),
        '    [JsonPropertyName("metadata")]',
        ...optionalJsonProperty("Metadata"),
      ].join("\n"),
      [
        ...doc(
          "The subagent run this message is attributed to, when a subagent produced it on behalf of the main run.",
          "    ",
        ),
        '    [JsonPropertyName("subagentRunId")]',
        "    public string? SubagentRunId { get; set; }",
      ].join("\n"),
    ].join("\n\n"),
    "}",
  ].join("\n");

  assertMessageBaseFields(defs, unionDef("Message").members.map(objectDef));

  const messageClasses = unionDef("Message").members.map((member) =>
    emitClass(context, objectDef(member), {
      base: "AGUIMessage",
      skip: MESSAGE_BASE_FIELDS,
    }),
  );

  /* ---- input content ---- */
  const inputContentBase = emitUnionBase(
    "ContentPart",
    unionDef("ContentPart").description,
    "type",
    "AGUIInputContentJsonConverter",
  );
  // The base above is an SDK idiom, not a schema shape: it exists so the four
  // media parts share one source/metadata pair. If a member stops matching that
  // pair, hoisting it would change what the member says.
  assertMediaPartsShareTheirBase([...MEDIA_PARTS].map(objectDef));

  const mediaBase = [
    ...doc(
      "The shared shape of the four media parts: where the bytes come from, and open extra information about the part.",
      "",
    ),
    "public abstract class AGUIMediaInputContent : AGUIInputContent",
    "{",
    [
      [
        '    [JsonPropertyName("source")]',
        "    public AGUIInputContentSource Source { get; set; } = null!;",
      ].join("\n"),
      [
        '    [JsonPropertyName("metadata")]',
        ...optionalJsonProperty("Metadata"),
      ].join("\n"),
    ].join("\n\n"),
    "}",
  ].join("\n");
  const contentClasses = unionDef("ContentPart").members.map((member) =>
    emitClass(context, objectDef(member), {
      base: MEDIA_PARTS.has(member)
        ? "AGUIMediaInputContent"
        : "AGUIInputContent",
      skip: MEDIA_PARTS.has(member)
        ? new Set(["source", "metadata"])
        : undefined,
    }),
  );
  const sourceBase = emitUnionBase(
    "PartSource",
    unionDef("PartSource").description,
    "type",
    "AGUIInputContentSourceJsonConverter",
  );
  const sourceClasses = unionDef("PartSource").members.map((member) =>
    emitClass(context, objectDef(member), { base: "AGUIInputContentSource" }),
  );

  /* ---- outcomes ---- */
  const outcomeBase = emitUnionBase(
    "RunFinishedOutcome",
    unionDef("RunFinishedOutcome").description,
    "type",
    "RunFinishedOutcomeJsonConverter",
    ["    internal RunFinishedOutcome() { }"],
  );
  const outcomeClasses = unionDef("RunFinishedOutcome").members.map((member) =>
    emitClass(context, objectDef(member), { base: "RunFinishedOutcome" }),
  );
  const subagentOutcomeBase = emitUnionBase(
    "SubagentFinishedOutcome",
    unionDef("SubagentFinishedOutcome").description,
    "type",
    "SubagentFinishedOutcomeJsonConverter",
    ["    internal SubagentFinishedOutcome() { }"],
  );
  const subagentOutcomeClasses = unionDef(
    "SubagentFinishedOutcome",
  ).members.map((member) =>
    emitClass(context, objectDef(member), { base: "SubagentFinishedOutcome" }),
  );

  /* ---- plain types ---- */
  const plainNames = [
    "FunctionCall",
    "ToolCall",
    "Tool",
    "Context",
    "Interrupt",
    "ResumeEntry",
    "TokenUsage",
    "RunAgentInput",
    // The capability model. Listed after the run types because a capabilities
    // snapshot describes the agent rather than a run, and in schema order so
    // the emitted file reads the way the schema declares them.
    "SubagentInfo",
    "IdentityCapabilities",
    "TransportCapabilities",
    "ToolsCapabilities",
    "OutputCapabilities",
    "StateCapabilities",
    "MultiAgentCapabilities",
    "ReasoningCapabilities",
    "MultimodalInputCapabilities",
    "MultimodalOutputCapabilities",
    "MultimodalCapabilities",
    "ExecutionCapabilities",
    "HumanInTheLoopCapabilities",
    "AgentCapabilities",
  ];
  const plain = plainNames.map((name) =>
    emitClass(context, objectDef(name), {}),
  );

  const emittedUnions = [
    "Event",
    "Message",
    "ContentPart",
    "PartSource",
    "RunFinishedOutcome",
    "SubagentFinishedOutcome",
  ];
  const emittedObjects = [
    ...emittedUnions.flatMap((name) => unionDef(name).members),
    ...plainNames,
  ];

  assertEveryReferencedObjectIsEmitted(
    defs,
    emittedObjects,
    // The union families emitted above, base and members alike. Event is among
    // them: BaseEvent and its event classes are written here too.
    emittedUnions,
    [baseEventShape],
  );
  // The check above walks outwards from what is written and insists every
  // reference lands somewhere. This one walks the other way: from the schema,
  // insisting nothing it declares is left out — a definition nothing references
  // yet is invisible to a reference walk.
  assertEveryDefinitionIsEmitted(model, [...emittedObjects, ...emittedUnions]);

  const wireShapes = emitWireShapes(
    context,
    emittedObjects.map(objectDef),
    new Set(emittedObjects),
  );

  return [
    file("AGUIEventTypes.g.cs", eventTypes),
    file("AGUIRoles.g.cs", roles),
    file(
      "AGUIConstants.g.cs",
      resumeStatus,
      outcomeTypes,
      subagentOutcomeTypes,
      inputContentTypes,
      sourceTypes,
    ),
    file("BaseEvent.g.cs", baseEvent),
    file("AGUIWireShapes.g.cs", wireShapes),
    file("AGUIEvents.g.cs", ...eventClasses),
    file(
      "AGUIMessages.g.cs",
      baseMessage,
      ...messageClasses,
      inputContentBase,
      mediaBase,
      ...contentClasses,
      sourceBase,
      ...sourceClasses,
    ),
    file(
      "AGUITypes.g.cs",
      ...plain,
      outcomeBase,
      ...outcomeClasses,
      subagentOutcomeBase,
      ...subagentOutcomeClasses,
    ),
  ];
}
