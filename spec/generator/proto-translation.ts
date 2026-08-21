/**
 * Emits the TypeScript translation layer between AG-UI JSON events and the
 * protobuf wire messages: sdks/typescript/packages/proto/src/proto.ts.
 *
 * The translation is mechanical — ts-proto's camelCase field names equal the
 * JSON wire names for every field that maps one-to-one, so the generic path
 * is a spread, and only the wire-shape deviations (the merged Message, the
 * flattened outcomes, the tagged patch operations, repeated fields that are
 * optional in JSON) get generated code, derived from the same wire model that
 * emitted the .proto files. The one block that is not schema-derived is the
 * legacy "binary" content-part mapping, kept verbatim as documented
 * compatibility behaviour.
 */

import type { Definition, Field, ObjectDefinition, TypeExpr } from "./ir";
import type { WireModel } from "./protobuf";

function resolveAlias(defs: Map<string, Definition>, type: TypeExpr): TypeExpr {
  while (type.kind === "ref") {
    const target = defs.get(type.name);
    if (target?.kind !== "alias") return type;
    type = target.type;
  }
  return type;
}

/** The event's EventType value, from its narrowed `type` field. */
function eventTypeOf(definition: ObjectDefinition): string {
  const typeField = definition.fields.find((field) => field.name === "type");
  if (typeField?.type.kind !== "literal") {
    throw new Error(`${definition.name} has no literal type`);
  }
  return typeField.type.value;
}

export function emitProtoTranslation(wire: WireModel): string {
  const { defs, model } = wire;
  const objectDef = (name: string): ObjectDefinition => {
    const definition = defs.get(name);
    if (definition?.kind !== "object")
      throw new Error(`${name} is not an object`);
    return definition;
  };
  const eventUnion = defs.get("Event");
  if (eventUnion?.kind !== "union") throw new Error("Event union missing");
  const events = eventUnion.members.map(objectDef);
  const baseNames = new Set(wire.baseFieldNames);

  /* ---------------- content parts ---------------- */

  const contentUnion = defs.get("InputContent");
  if (contentUnion?.kind !== "union") throw new Error("InputContent missing");
  const partEntries = contentUnion.members.map((memberName) => {
    const member = objectDef(memberName);
    const discriminator = member.fields.find(
      (field) => field.name === contentUnion.discriminator,
    );
    if (discriminator?.type.kind !== "literal")
      throw new Error("part discriminator");
    const payload = member.fields.filter(
      (field) => field.name !== contentUnion.discriminator,
    );
    return { entry: discriminator.type.value, payload };
  });

  const sourceUnion = defs.get("InputContentSource");
  if (sourceUnion?.kind !== "union")
    throw new Error("InputContentSource missing");
  const sourceEntries = sourceUnion.members.map((memberName) => {
    const member = objectDef(memberName);
    const discriminator = member.fields.find(
      (field) => field.name === sourceUnion.discriminator,
    );
    if (discriminator?.type.kind !== "literal")
      throw new Error("source discriminator");
    const payload = member.fields
      .filter((field) => field.name !== sourceUnion.discriminator)
      .map((field) => field.name);
    return { entry: discriminator.type.value, payload };
  });

  const toPartCase = (entry: { entry: string; payload: Field[] }): string => {
    const fields = entry.payload
      .map((field) => {
        const resolved = resolveAlias(defs, field.type);
        if (resolved.kind === "ref" && resolved.name === "InputContentSource") {
          return `${field.name}: toProtoSource(rec.${field.name})`;
        }
        return `${field.name}: rec.${field.name}`;
      })
      .join(", ");
    return `    case ${JSON.stringify(entry.entry)}:\n      return { ${entry.entry}: { ${fields} } };`;
  };

  const fromPartCase = (entry: { entry: string; payload: Field[] }): string => {
    const fields = entry.payload
      .map((field) => {
        const resolved = resolveAlias(defs, field.type);
        if (resolved.kind === "ref" && resolved.name === "InputContentSource") {
          return `${field.name}: fromProtoSource(part.${field.name})`;
        }
        return `${field.name}: part.${field.name}`;
      })
      .join(", ");
    return `  if (rec.${entry.entry}) {\n    const part = rec.${entry.entry} as LooseRecord;\n    return { type: ${JSON.stringify(entry.entry)}, ${fields} };\n  }`;
  };

  /* ---------------- merged Message ---------------- */

  const messageUnion = defs.get("Message");
  if (messageUnion?.kind !== "union") throw new Error("Message union missing");
  // role value -> how its content field rides the wire
  const contentModes = messageUnion.members.map((memberName) => {
    const member = objectDef(memberName);
    const role = member.fields.find(
      (field) => field.name === messageUnion.discriminator,
    );
    if (role?.type.kind !== "literal") throw new Error("message discriminator");
    const content = member.fields.find((field) => field.name === "content");
    const mode =
      content === undefined
        ? "none"
        : content.type.kind === "union"
          ? "stringOrParts"
          : content.type.kind === "openMap"
            ? "map"
            : "string";
    return { role: role.type.value, mode };
  });
  const mapModeRoles = contentModes
    .filter((entry) => entry.mode === "map")
    .map((entry) => entry.role);
  const partsModeRoles = contentModes
    .filter((entry) => entry.mode === "stringOrParts")
    .map((entry) => entry.role);

  /* ---------------- per-event wire deviations ---------------- */

  interface FlattenSpec {
    eventType: string;
    jsonField: string;
    cases: Array<{ value: string; payload: Field[] }>;
  }
  const flattenSpecs: FlattenSpec[] = [];
  const patchFields: Array<{ eventType: string; jsonField: string }> = [];
  const optionalArrays: Array<{ eventType: string; jsonField: string }> = [];
  const nestedInputs: Array<{
    eventType: string;
    jsonField: string;
    def: string;
  }> = [];

  for (const event of events) {
    const type = eventTypeOf(event);
    for (const field of event.fields) {
      if (baseNames.has(field.name)) continue;
      const resolved =
        field.type.kind === "ref" ? defs.get(field.type.name) : undefined;
      if (resolved?.kind === "union") {
        flattenSpecs.push({
          eventType: type,
          jsonField: field.name,
          cases: resolved.members.map((memberName) => {
            const member = objectDef(memberName);
            const discriminator = member.fields.find(
              (entry) => entry.name === resolved.discriminator,
            );
            if (discriminator?.type.kind !== "literal") {
              throw new Error(`${memberName} discriminator`);
            }
            return {
              value: discriminator.type.value,
              payload: member.fields.filter(
                (entry) => entry.name !== resolved.discriminator,
              ),
            };
          }),
        });
        continue;
      }
      const aliased = resolveAlias(defs, field.type);
      const arrayType =
        field.type.kind === "array"
          ? field.type
          : aliased.kind === "array"
            ? aliased
            : field.type.kind === "ref" &&
                defs.get(field.type.name)?.kind === "alias" &&
                (defs.get(field.type.name) as { type: TypeExpr }).type.kind ===
                  "array"
              ? ((defs.get(field.type.name) as { type: TypeExpr })
                  .type as TypeExpr & {
                  kind: "array";
                })
              : undefined;
      if (arrayType && arrayType.kind === "array") {
        const items = arrayType.items;
        const itemsDef =
          items.kind === "ref" ? defs.get(items.name) : undefined;
        if (itemsDef?.name === "JsonPatchOperation") {
          patchFields.push({ eventType: type, jsonField: field.name });
        }
        if (!field.required) {
          optionalArrays.push({ eventType: type, jsonField: field.name });
        }
        continue;
      }
      if (
        resolved?.kind === "object" &&
        !["Interrupt", "TokenUsage"].includes(resolved.name) &&
        resolved.fields.some((entry) => {
          const inner = resolveAlias(defs, entry.type);
          return (
            inner.kind === "array" &&
            inner.items.kind === "ref" &&
            defs.get(inner.items.name)?.kind === "union"
          );
        })
      ) {
        nestedInputs.push({
          eventType: type,
          jsonField: field.name,
          def: resolved.name,
        });
      }
    }
  }

  const inputDefs = [...new Set(nestedInputs.map((entry) => entry.def))].map(
    objectDef,
  );

  const inputConverter = (definition: ObjectDefinition): string => {
    const to: string[] = [];
    const from: string[] = [];
    for (const field of definition.fields) {
      const aliased = resolveAlias(defs, field.type);
      if (aliased.kind === "array") {
        const items = aliased.items;
        const itemDef = items.kind === "ref" ? defs.get(items.name) : undefined;
        const mapper =
          itemDef?.kind === "union"
            ? "toWireMessage"
            : itemDef?.kind === "object" &&
                itemDef.fields.some((entry) => entry.name === "metadata")
              ? "normalizeItemMetadata"
              : undefined;
        const encodeExpr = mapper
          ? `asArray(input.${field.name}).map(${mapper})`
          : `asArray(input.${field.name})`;
        to.push(`    ${field.name}: ${encodeExpr},`);
        const decodeMapper =
          itemDef?.kind === "union" ? ".map(fromWireMessage)" : "";
        if (field.required) {
          from.push(
            `  output.${field.name} = asArray(rec.${field.name})${decodeMapper};`,
          );
        } else {
          from.push(
            `  if (asArray(rec.${field.name}).length > 0) {\n    output.${field.name} = asArray(rec.${field.name})${decodeMapper};\n  }`,
          );
        }
        continue;
      }
      to.push(`    ${field.name}: input.${field.name},`);
      from.push(
        `  if (rec.${field.name} !== undefined) output.${field.name} = rec.${field.name};`,
      );
    }
    return `
const toWire${definition.name} = (value: unknown): LooseRecord | undefined => {
  const input = asRecord(value);
  if (!input) return undefined;
  return {
${to.join("\n")}
  };
};

const fromWire${definition.name} = (value: unknown): LooseRecord | undefined => {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const output: LooseRecord = {};
${from.join("\n")}
  return output;
};
`;
  };

  /* ---------------- encode/decode special-case blocks ---------------- */

  const messagesSnapshotType = events.find((event) =>
    event.fields.some((field) => {
      const aliased = resolveAlias(defs, field.type);
      return (
        aliased.kind === "array" &&
        aliased.items.kind === "ref" &&
        aliased.items.name === "Message"
      );
    }),
  );

  const encodeCases: string[] = [];
  const decodeCases: string[] = [];

  if (messagesSnapshotType) {
    const type = eventTypeOf(messagesSnapshotType);
    encodeCases.push(`  if (type === ${JSON.stringify(type)} && Array.isArray(rest.messages)) {
    rest.messages = rest.messages.map(toWireMessage);
  }`);
    decodeCases.push(`  if (decoded.type === ${JSON.stringify(type)} && Array.isArray(decoded.messages)) {
    decoded.messages = (decoded.messages as unknown[]).map(fromWireMessage);
  }`);
  }

  for (const spec of flattenSpecs) {
    const payloadNames = [
      ...new Set(
        spec.cases.flatMap((entry) => entry.payload.map((f) => f.name)),
      ),
    ];
    const clear = payloadNames
      .map((name) => `    rest.${name} = [];`)
      .join("\n");
    const branches = spec.cases
      .map((entry) => {
        const assign = entry.payload
          .map(
            (field) =>
              `      rest.${field.name} = asArray(outcomeRecord?.${field.name});`,
          )
          .join("\n");
        return `    } else if (outcomeRecord?.type === ${JSON.stringify(entry.value)}) {
      rest.${spec.jsonField} = ${JSON.stringify(entry.value)};
${assign}`;
      })
      .join("\n");
    encodeCases.push(`  if (type === ${JSON.stringify(spec.eventType)}) {
    const outcomeRecord = asRecord(rest.${spec.jsonField});
${clear}
    if (rest.${spec.jsonField} === undefined) {
      rest.${spec.jsonField} = "";
${branches}
    } else {
      rest.${spec.jsonField} =
        typeof outcomeRecord?.type === "string" ? outcomeRecord.type : "";
    }
  }`);

    const rebuild = spec.cases
      .map((entry) => {
        const pairs = entry.payload
          .map((field) =>
            field.required
              ? `, ${field.name}: asArray(payload.${field.name})`
              : `, ...(asArray(payload.${field.name}).length > 0 ? { ${field.name}: payload.${field.name} } : {})`,
          )
          .join("");
        return `    if (wireOutcome === ${JSON.stringify(entry.value)}) {
      record.${spec.jsonField} = { type: ${JSON.stringify(entry.value)}${pairs} };
    }`;
      })
      .join("\n");
    decodeCases.push(`  if (decoded.type === ${JSON.stringify(spec.eventType)}) {
    const record = decoded as LooseRecord;
    const wireOutcome =
      typeof record.${spec.jsonField} === "string" && record.${spec.jsonField} !== ""
        ? (record.${spec.jsonField} as string)
        : undefined;
    const payload: LooseRecord = {};
${payloadNames.map((name) => `    payload.${name} = record.${name};\n    delete record.${name};`).join("\n")}
    delete record.${spec.jsonField};
${rebuild}
  }`);
  }

  for (const entry of patchFields) {
    encodeCases.push(`  if (type === ${JSON.stringify(entry.eventType)} && Array.isArray(rest.${entry.jsonField})) {
    rest.${entry.jsonField} = (rest.${entry.jsonField} as LooseRecord[]).map((operation) => ({
      ...operation,
      // Cast, not coercion: String(op) would turn malformed values such as
      // ["add"] into a valid enum member, where this throws instead.
      op: protoPatch.JsonPatchOperationType[
        (operation.op as string).toUpperCase() as keyof typeof protoPatch.JsonPatchOperationType
      ],
    }));
  }`);
    decodeCases.push(`  if (decoded.type === ${JSON.stringify(entry.eventType)} && Array.isArray(decoded.${entry.jsonField})) {
    for (const operation of decoded.${entry.jsonField} as LooseRecord[]) {
      operation.op =
        protoPatch.JsonPatchOperationType[
          operation.op as protoPatch.JsonPatchOperationType
        ].toLowerCase();
      Object.keys(operation).forEach((key) => {
        if (operation[key] === undefined) {
          delete operation[key];
        }
      });
    }
  }`);
  }

  const flattenedFields = new Set(
    flattenSpecs.map((spec) => `${spec.eventType}.${spec.jsonField}`),
  );
  const arrayNormalizations = optionalArrays.filter(
    (entry) => !flattenedFields.has(`${entry.eventType}.${entry.jsonField}`),
  );
  for (const entry of arrayNormalizations) {
    encodeCases.push(`  if (type === ${JSON.stringify(entry.eventType)}) {
    rest.${entry.jsonField} = asArray(rest.${entry.jsonField});
  }`);
    decodeCases.push(`  if (decoded.type === ${JSON.stringify(entry.eventType)}) {
    if (Array.isArray(decoded.${entry.jsonField}) && decoded.${entry.jsonField}.length === 0) {
      delete decoded.${entry.jsonField};
    }
  }`);
  }

  for (const entry of nestedInputs) {
    encodeCases.push(`  if (type === ${JSON.stringify(entry.eventType)} && rest.${entry.jsonField} !== undefined) {
    rest.${entry.jsonField} = toWire${entry.def}(rest.${entry.jsonField});
  }`);
    decodeCases.push(`  if (decoded.type === ${JSON.stringify(entry.eventType)} && decoded.${entry.jsonField} !== undefined) {
    decoded.${entry.jsonField} = fromWire${entry.def}(decoded.${entry.jsonField});
  }`);
  }

  /* ---------------- the file ---------------- */

  return `// @generated by spec/generator — DO NOT EDIT.
// Source: ${model.schemaId}
// Regenerate: pnpm --filter @ag-ui/spec generate

import { BaseEvent, AGUIEvent, EventSchemas, EventType } from "@ag-ui/core";
import * as protoEvents from "./generated/events";
import * as protoPatch from "./generated/patch";

/**
 * These converters run against values that have crossed a wire boundary, so
 * they accept \`unknown\` and narrow once rather than trusting a static type.
 */
type LooseRecord = Record<string, unknown>;

const asRecord = (value: unknown): LooseRecord | undefined =>
  value && typeof value === "object" ? (value as LooseRecord) : undefined;

const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

function toCamelCase(str: string): string {
  return str.toLowerCase().replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * The event types the handwritten SDK models know. The schema — and this
 * generated wire layer — can be ahead of them; an event outside this set is
 * carried structurally and validated once the SDK catches up.
 */
const KNOWN_TO_CORE = new Set<string>(Object.values(EventType));

/**
 * Narrows metadata to the object the wire format declares, or nothing.
 *
 * On the validated path the schema has already guaranteed this. On the fallback
 * path below the event is unvalidated, and the generated \`Struct.wrap\` would
 * quietly mangle anything else — an array becomes \`{"0": …}\`, a string becomes
 * per-character keys, a number becomes \`{}\`. Dropping the value is the honest
 * outcome for a shim whose contract is to warn and encode best-effort; the
 * caller already gets a loud warning naming the validation failure.
 */
const normalizeMetadata = (metadata: unknown): LooseRecord | undefined =>
  typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
    ? (metadata as LooseRecord)
    : undefined;

const toProtoSource = (source: unknown): unknown => {
  const rec = asRecord(source);
  if (!rec) return undefined;
${sourceEntries
  .map(
    (entry) => `  if (rec.type === ${JSON.stringify(entry.entry)}) {
    return { ${entry.entry}: { ${entry.payload.map((name) => `${name}: rec.${name}`).join(", ")} } };
  }`,
  )
  .join("\n")}
  return undefined;
};

const fromProtoSource = (source: unknown): unknown => {
  const rec = asRecord(source);
  if (!rec) return undefined;
${sourceEntries
  .map(
    (entry) => `  if (rec.${entry.entry}) {
    const wire = rec.${entry.entry} as LooseRecord;
    return { type: ${JSON.stringify(entry.entry)}, ${entry.payload.map((name) => `${name}: wire.${name}`).join(", ")} };
  }`,
  )
  .join("\n")}
  return undefined;
};

const toProtoContentPart = (part: unknown): unknown => {
  const rec = asRecord(part);
  if (!rec) return undefined;

  switch (rec.type) {
${partEntries.map(toPartCase).join("\n")}
    // Legacy compatibility, predating the schema: the retired "binary" part
    // rides as a document part with marker metadata. Behavioural rule of this
    // layer, not a schema fact.
    case "binary": {
      const source = rec.data
        ? { data: { value: rec.data, mimeType: rec.mimeType } }
        : rec.url
          ? { url: { value: rec.url, mimeType: rec.mimeType } }
          : rec.id
            ? { url: { value: rec.id, mimeType: rec.mimeType } }
            : undefined;
      if (!source) return undefined;
      return {
        document: {
          source,
          metadata: { legacyBinary: true, filename: rec.filename, id: rec.id },
        },
      };
    }
    default:
      return undefined;
  }
};

const fromProtoContentPart = (part: unknown): unknown => {
  const rec = asRecord(part);
  if (!rec) return undefined;
${partEntries.map(fromPartCase).join("\n")}
  return undefined;
};

/**
 * The wire's one Message carries the union of every role's fields; which
 * field feeds \`content\` depends on the role.
 */
const MAP_CONTENT_ROLES = new Set<string>(${JSON.stringify(mapModeRoles)});
const PARTS_CONTENT_ROLES = new Set<string>(${JSON.stringify(partsModeRoles)});

const toWireMessage = (value: unknown): LooseRecord => {
  const message = asRecord(value) ?? {};
  const wire: LooseRecord = { ...message, contentParts: [] };
  wire.metadata = normalizeMetadata(message.metadata);
  wire.toolCalls = asArray(message.toolCalls).map((toolCall: unknown) => ({
    ...(toolCall as LooseRecord),
    metadata: normalizeMetadata(asRecord(toolCall)?.metadata),
  }));
  if (Array.isArray(message.content)) {
    wire.contentParts = message.content
      .map((part: unknown) => toProtoContentPart(part))
      .filter((part: unknown) => part !== undefined);
    wire.content = undefined;
  } else if (
    typeof message.role === "string" &&
    MAP_CONTENT_ROLES.has(message.role)
  ) {
    wire.activityContent = normalizeMetadata(message.content) ?? {};
    wire.content = undefined;
  }
  return wire;
};

const fromWireMessage = (value: unknown): LooseRecord => {
  const wire = asRecord(value) ?? {};
  const message: LooseRecord = { ...wire };
  const role = typeof wire.role === "string" ? wire.role : "";
  if (PARTS_CONTENT_ROLES.has(role) && wire.content === undefined) {
    // String content rides the content field; anything else is the parts
    // array — including an empty one, which is valid content of its own.
    message.content = asArray(wire.contentParts)
      .map((part: unknown) => fromProtoContentPart(part))
      .filter((part: unknown) => part !== undefined);
  }
  if (MAP_CONTENT_ROLES.has(role) && wire.activityContent !== undefined) {
    message.content = wire.activityContent;
  }
  delete message.activityContent;
  delete message.contentParts;
  if (asArray(wire.toolCalls).length === 0) {
    delete message.toolCalls;
  }
  Object.keys(message).forEach((key) => {
    if (message[key] === undefined) delete message[key];
  });
  return message;
};

const normalizeItemMetadata = (value: unknown): LooseRecord => ({
  ...(asRecord(value) ?? {}),
  metadata: normalizeMetadata(asRecord(value)?.metadata),
});
${inputDefs.map(inputConverter).join("\n")}
/**
 * Encodes an event to the protobuf wire format.
 */
export function encode(event: BaseEvent): Uint8Array {
  // Events the handwritten SDK knows are validated, with a warning and a
  // best-effort fallback for malformed ones — existing clients encoding
  // invalid events keep working, loudly. Events the SDK does not know yet
  // (the schema can be ahead of it) are carried structurally.
  let validatedEvent: AGUIEvent | BaseEvent = event;
  if (KNOWN_TO_CORE.has(event.type as string)) {
    try {
      validatedEvent = EventSchemas.parse(event) as AGUIEvent;
    } catch (err) {
      console.warn(
        "[ag-ui][proto.encode] Malformed event detected, falling back to unvalidated event",
        err,
        event,
      );
      validatedEvent = event;
    }
  }
  const oneofField = toCamelCase(validatedEvent.type as string);
  const { type, timestamp, rawEvent, metadata, ...rest } =
    validatedEvent as unknown as LooseRecord;

${encodeCases.join("\n")}

  const eventMessage = {
    [oneofField]: {
      baseEvent: {
        type: protoEvents.EventType[event.type as keyof typeof protoEvents.EventType],
        timestamp,
        rawEvent,
        metadata: normalizeMetadata(metadata),
      },
      ...rest,
    },
  };
  return protoEvents.Event.encode(eventMessage).finish();
}

/**
 * Decodes the protobuf wire format to an event.
 */
export function decode(data: Uint8Array): BaseEvent {
  const envelope = protoEvents.Event.decode(data);
  const found = Object.values(envelope).find((value) => value !== undefined);
  if (!found) {
    throw new Error("Invalid event");
  }
  const decoded = found as LooseRecord;
  const base = asRecord(decoded.baseEvent) ?? {};
  decoded.type = protoEvents.EventType[base.type as number];
  decoded.timestamp = base.timestamp;
  decoded.rawEvent = base.rawEvent;
  // Struct decodes an absent object to undefined, so an event that carried no
  // metadata stays without the key rather than gaining an empty one.
  if (base.metadata !== undefined) {
    decoded.metadata = base.metadata;
  }
  delete decoded.baseEvent;

${decodeCases.join("\n")}

  Object.keys(decoded).forEach((key) => {
    if (decoded[key] === undefined) {
      delete decoded[key];
    }
  });

  // Same gate as encode: validate what the SDK knows, carry the rest.
  if (KNOWN_TO_CORE.has(decoded.type as string)) {
    return EventSchemas.parse(decoded) as BaseEvent;
  }
  return decoded as unknown as BaseEvent;
}
`;
}
