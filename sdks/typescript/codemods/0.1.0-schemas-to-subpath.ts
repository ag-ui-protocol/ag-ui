/**
 * jscodeshift codemod: @ag-ui/core 0.0.x → 0.1.0
 *
 * Moves every `*Schema` import (and `EventSchemas`) from `@ag-ui/core` to the
 * new `@ag-ui/core/schemas` subpath. Type-only imports are preserved. Idempotent.
 *
 * Usage:
 *   npx jscodeshift -t 0.1.0-schemas-to-subpath.ts --parser=tsx --extensions=ts,tsx src/
 */
import type { Transform, ImportSpecifier, ImportDefaultSpecifier, ImportNamespaceSpecifier } from "jscodeshift";

// ---------------------------------------------------------------------------
// Curated list — the public *Schema exports from 0.0.x.
// The transform also matches anything whose imported name ends with "Schema"
// as a fallback, so this list does not need to be exhaustive. It exists to
// catch `EventSchemas` (the only "Schemas" plural export) and to make the
// intent of the transform explicit.
// Keep in sync with sdks/typescript/packages/core/src/schemas.ts
// ---------------------------------------------------------------------------
const SCHEMA_NAMES = new Set([
  // Discriminated event union
  "EventSchemas",
  // EventType enum schema
  "EventTypeSchema",
  // Base type schemas
  "FunctionCallSchema",
  "ToolCallSchema",
  "TextInputContentSchema",
  "InputContentDataSourceSchema",
  "InputContentUrlSourceSchema",
  "InputContentSourceSchema",
  "ImageInputContentSchema",
  "AudioInputContentSchema",
  "VideoInputContentSchema",
  "DocumentInputContentSchema",
  "ImageInputPartSchema",
  "AudioInputPartSchema",
  "VideoInputPartSchema",
  "DocumentInputPartSchema",
  "BinaryInputContentSchema",
  "InputContentSchema",
  "InputContentPartSchema",
  "DeveloperMessageSchema",
  "SystemMessageSchema",
  "AssistantMessageSchema",
  "UserMessageSchema",
  "ToolMessageSchema",
  "ActivityMessageSchema",
  "ReasoningMessageSchema",
  "MessageSchema",
  "RoleSchema",
  "ContextSchema",
  "ToolSchema",
  "InterruptSchema",
  "ResumeEntrySchema",
  "RunAgentInputSchema",
  "StateSchema",
  // Event schemas
  "BaseEventSchema",
  "TextMessageStartEventSchema",
  "TextMessageContentEventSchema",
  "TextMessageEndEventSchema",
  "TextMessageChunkEventSchema",
  "ThinkingTextMessageStartEventSchema",
  "ThinkingTextMessageContentEventSchema",
  "ThinkingTextMessageEndEventSchema",
  "ToolCallStartEventSchema",
  "ToolCallArgsEventSchema",
  "ToolCallEndEventSchema",
  "ToolCallResultEventSchema",
  "ToolCallChunkEventSchema",
  "ThinkingStartEventSchema",
  "ThinkingEndEventSchema",
  "StateSnapshotEventSchema",
  "StateDeltaEventSchema",
  "MessagesSnapshotEventSchema",
  "ActivitySnapshotEventSchema",
  "ActivityDeltaEventSchema",
  "RawEventSchema",
  "CustomEventSchema",
  "RunStartedEventSchema",
  "RunFinishedSuccessOutcomeSchema",
  "RunFinishedInterruptOutcomeSchema",
  "RunFinishedOutcomeSchema",
  "RunFinishedEventSchema",
  "RunErrorEventSchema",
  "StepStartedEventSchema",
  "StepFinishedEventSchema",
  "ReasoningEncryptedValueSubtypeSchema",
  "ReasoningStartEventSchema",
  "ReasoningMessageStartEventSchema",
  "ReasoningMessageContentEventSchema",
  "ReasoningMessageEndEventSchema",
  "ReasoningMessageChunkEventSchema",
  "ReasoningEndEventSchema",
  "ReasoningEncryptedValueEventSchema",
  // Capability schemas
  "SubAgentInfoSchema",
  "IdentityCapabilitiesSchema",
  "TransportCapabilitiesSchema",
  "ToolsCapabilitiesSchema",
  "OutputCapabilitiesSchema",
  "StateCapabilitiesSchema",
  "MultiAgentCapabilitiesSchema",
  "ReasoningCapabilitiesSchema",
  "MultimodalInputCapabilitiesSchema",
  "MultimodalOutputCapabilitiesSchema",
  "MultimodalCapabilitiesSchema",
  "ExecutionCapabilitiesSchema",
  "HumanInTheLoopCapabilitiesSchema",
  "AgentCapabilitiesSchema",
]);

/** Returns true if this imported name should move to @ag-ui/core/schemas. */
const isSchemaSpecifier = (importedName: string): boolean =>
  importedName.endsWith("Schema") || importedName === "EventSchemas" || SCHEMA_NAMES.has(importedName);

const CORE_SOURCE = "@ag-ui/core";
const SCHEMAS_SOURCE = "@ag-ui/core/schemas";

const transform: Transform = (file, api) => {
  const j = api.jscodeshift;
  const root = j(file.source);

  let dirty = false;

  // Collect all import declarations from @ag-ui/core
  const coreImports = root.find(j.ImportDeclaration, {
    source: { value: CORE_SOURCE },
  });

  if (coreImports.length === 0) {
    return file.source;
  }

  // Collect any existing import from @ag-ui/core/schemas so we can merge into it
  const existingSchemasImports = root.find(j.ImportDeclaration, {
    source: { value: SCHEMAS_SOURCE },
  });

  // We may need to merge schema specifiers into an existing schemas import.
  // Build a set of names already imported from @ag-ui/core/schemas so we don't
  // create duplicates.
  const alreadyInSchemas = new Set<string>();
  existingSchemasImports.forEach((path) => {
    (path.node.specifiers ?? []).forEach((spec) => {
      if (spec.type === "ImportSpecifier") {
        alreadyInSchemas.add((spec as ImportSpecifier).imported.name);
      }
    });
  });

  // Specifiers to move to @ag-ui/core/schemas, accumulated across all @ag-ui/core imports
  const specsToMove: ImportSpecifier[] = [];

  coreImports.forEach((path) => {
    const specifiers = path.node.specifiers ?? [];

    // Partition: stay vs. move
    const staySpecs: typeof specifiers = [];
    const moveSpecs: ImportSpecifier[] = [];

    for (const spec of specifiers) {
      if (spec.type !== "ImportSpecifier") {
        // Default or namespace imports — always stay on @ag-ui/core
        staySpecs.push(spec);
        continue;
      }
      const named = spec as ImportSpecifier;
      const importedName = named.imported.name;

      if (isSchemaSpecifier(importedName)) {
        moveSpecs.push(named);
      } else {
        staySpecs.push(named);
      }
    }

    if (moveSpecs.length === 0) {
      // Nothing to move in this declaration — leave it untouched
      return;
    }

    dirty = true;

    // Only add to specsToMove if not already present in @ag-ui/core/schemas
    for (const spec of moveSpecs) {
      const importedName = spec.imported.name;
      if (!alreadyInSchemas.has(importedName)) {
        specsToMove.push(spec);
        alreadyInSchemas.add(importedName);
      }
    }

    // Update or remove the original @ag-ui/core declaration
    if (staySpecs.length === 0) {
      // Nothing left on @ag-ui/core — remove the declaration entirely
      j(path).remove();
    } else {
      // Mutate the specifier list in-place
      path.node.specifiers = staySpecs;
    }
  });

  if (!dirty || specsToMove.length === 0) {
    return dirty ? root.toSource({ quote: "double" }) : file.source;
  }

  if (existingSchemasImports.length > 0) {
    // Merge into the first existing @ag-ui/core/schemas import
    const firstSchemas = existingSchemasImports.at(0);
    const existing = firstSchemas.node.specifiers ?? [];
    firstSchemas.node.specifiers = [...existing, ...specsToMove];
  } else {
    // Build a new import declaration and insert it after the last @ag-ui/core import
    // (or after the last import in the file if @ag-ui/core imports were removed).
    const newImport = j.importDeclaration(specsToMove, j.stringLiteral(SCHEMAS_SOURCE));

    // Try to insert right after the last @ag-ui/core import that still exists.
    // After removals, we look at all remaining import declarations.
    const allImports = root.find(j.ImportDeclaration);
    if (allImports.length > 0) {
      allImports.at(allImports.length - 1).insertAfter(newImport);
    } else {
      // Edge case: the file had only @ag-ui/core imports and they were all
      // removed. Insert at the top of the file body.
      const body = root.find(j.Program).get("body");
      body.value.unshift(newImport);
    }
  }

  return root.toSource({ quote: "double" });
};

export default transform;
export const parser = "tsx";
