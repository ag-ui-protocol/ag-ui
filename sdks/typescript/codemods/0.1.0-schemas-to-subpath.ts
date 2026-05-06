/**
 * jscodeshift codemod: @ag-ui/core 0.0.x → 0.1.0
 *
 * Moves every `*Schema` import (and `EventSchemas`) from `@ag-ui/core` to the
 * new `@ag-ui/core/schemas` subpath. Type-only imports are preserved. Idempotent.
 *
 * Usage:
 *   npx jscodeshift -t 0.1.0-schemas-to-subpath.ts --parser=tsx --extensions=ts,tsx src/
 */
import type { Transform, ImportSpecifier, ImportNamespaceSpecifier } from "jscodeshift";

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
  // create duplicates. Track by name + whether it's a type-only import.
  const alreadyInSchemas = new Set<string>();
  // Track whether the first existing schemas import is type-only (importKind === "type")
  let existingSchemasIsTypeOnly = false;
  existingSchemasImports.forEach((path) => {
    if (path.node.importKind === "type") {
      existingSchemasIsTypeOnly = true;
    }
    (path.node.specifiers ?? []).forEach((spec) => {
      if (spec.type === "ImportSpecifier") {
        alreadyInSchemas.add((spec as ImportSpecifier).imported.name);
      }
    });
  });

  // Specifiers to move to @ag-ui/core/schemas, accumulated across all @ag-ui/core imports.
  // We separate value specs from type-only specs so we can emit correctly typed declarations.
  const valueSpecsToMove: ImportSpecifier[] = [];
  const typeSpecsToMove: ImportSpecifier[] = [];

  coreImports.forEach((path) => {
    const specifiers = path.node.specifiers ?? [];
    // A whole-declaration `import type { ... }` makes all specifiers type-only.
    const declIsTypeOnly = path.node.importKind === "type";

    // Partition: stay vs. move
    const staySpecs: typeof specifiers = [];
    const moveSpecs: ImportSpecifier[] = [];

    for (const spec of specifiers) {
      if (spec.type !== "ImportSpecifier") {
        // Default or namespace imports — always stay on @ag-ui/core
        if (spec.type === "ImportNamespaceSpecifier") {
          console.warn(
            `[codemod 0.1.0-schemas-to-subpath] ${file.path}: namespace import "import * as ${(spec as ImportNamespaceSpecifier).local.name} from "@ag-ui/core"" cannot be automatically migrated. Schema references via ${(spec as ImportNamespaceSpecifier).local.name}.<SchemaName> must be updated manually.`
          );
        }
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

    // Only add to specsToMove if not already present in @ag-ui/core/schemas.
    // Preserve type-only intent: a specifier is type-only if the whole declaration
    // is `import type { ... }` OR if the individual specifier has importKind "type".
    for (const spec of moveSpecs) {
      const importedName = spec.imported.name;
      if (!alreadyInSchemas.has(importedName)) {
        const specIsTypeOnly = declIsTypeOnly || spec.importKind === "type";
        if (specIsTypeOnly) {
          // Clone spec without per-specifier importKind — the declaration itself
          // will be emitted as `import type { ... }`, so the per-specifier marker
          // is redundant and would produce `import type { type Foo }`.
          const cloned = j.importSpecifier(
            j.identifier(importedName),
            j.identifier(spec.local.name),
          );
          typeSpecsToMove.push(cloned);
        } else {
          valueSpecsToMove.push(spec);
        }
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
      // If the declaration was `import type` but we stripped all type-only specs
      // and only non-schema (value) specifiers remain, the importKind stays "type"
      // which is still correct since all remaining specifiers are type imports.
    }
  });

  const specsToMove = [...valueSpecsToMove, ...typeSpecsToMove];

  if (!dirty || specsToMove.length === 0) {
    return dirty ? root.toSource({ quote: "double" }) : file.source;
  }

  // Helper to insert a new import declaration after the last remaining import.
  const insertAfterLastImport = (newImport: ReturnType<typeof j.importDeclaration>) => {
    const allImports = root.find(j.ImportDeclaration);
    if (allImports.length > 0) {
      allImports.at(allImports.length - 1).insertAfter(newImport);
    } else {
      const body = root.find(j.Program).get("body");
      body.value.unshift(newImport);
    }
  };

  if (existingSchemasImports.length > 0) {
    // Merge specifiers that match the existing declaration's type-only mode.
    // If the existing import is a value import, only merge value specs into it.
    // Type specs get a separate `import type` declaration.
    const firstPath = existingSchemasImports.paths()[0];

    if (existingSchemasIsTypeOnly) {
      // Existing is `import type` — merge all (they're all type-only in this context)
      const existing = firstPath.node.specifiers ?? [];
      firstPath.node.specifiers = [...existing, ...specsToMove];
    } else {
      // Existing is a value import — only merge value specs
      if (valueSpecsToMove.length > 0) {
        const existing = firstPath.node.specifiers ?? [];
        firstPath.node.specifiers = [...existing, ...valueSpecsToMove];
      }
      // Type-only specs need a separate declaration
      if (typeSpecsToMove.length > 0) {
        const typeImport = j.importDeclaration(typeSpecsToMove, j.stringLiteral(SCHEMAS_SOURCE));
        typeImport.importKind = "type";
        insertAfterLastImport(typeImport);
      }
    }
  } else {
    // No existing @ag-ui/core/schemas import. Emit value and type declarations separately.
    if (valueSpecsToMove.length > 0) {
      const newImport = j.importDeclaration(valueSpecsToMove, j.stringLiteral(SCHEMAS_SOURCE));
      insertAfterLastImport(newImport);
    }
    if (typeSpecsToMove.length > 0) {
      const typeImport = j.importDeclaration(typeSpecsToMove, j.stringLiteral(SCHEMAS_SOURCE));
      typeImport.importKind = "type";
      insertAfterLastImport(typeImport);
    }
  }

  return root.toSource({ quote: "double" });
};

export default transform;
export const parser = "tsx";
