/**
 * A2UI wire-protocol selection for middleware-emitted operations.
 *
 * The catalog the host registers decides the protocol: a catalog that declares
 * `protocolVersion: "1.0"` renders through the native 1.0 processor, anything
 * else keeps the v0.9 default. The streamed `render_a2ui` payload must agree
 * with that declaration — the two protocols spell bindings differently, so a
 * payload relabeled with the wrong version never renders.
 */

export type A2UIProtocolVersion = "v0.9" | "1.0";

/** Canonical v0.9 envelope label. */
export const A2UI_PROTOCOL_V0_9: A2UIProtocolVersion = "v0.9";
/** Canonical 1.0 envelope label (the renderer rejects "v1.0"). */
export const A2UI_PROTOCOL_V1_0: A2UIProtocolVersion = "1.0";

/** The spec's basic catalog for each protocol; the streamed-surface fallback when no host catalog is known. */
export function basicCatalogId(protocol: A2UIProtocolVersion): string {
  return protocol === A2UI_PROTOCOL_V1_0
    ? "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json"
    : "https://a2ui.org/specification/v0_9/basic_catalog.json";
}

// A declared version as the a2ui SDK reads it (the ADK adapter uses the same
// reading): optional "v", major.minor, optional patch, pre-release and build
// metadata ignored — "v0.9", "0.9.1", "1.0", "1.0.0-beta".
const DECLARED_VERSION = /^v?(\d+)\.(\d+)(?:\.\d+)?(?:[-+].*)?$/i;

/** Map a declared version ("0.9", "v0.9", "1.0", "1.0.0") to its wire label. */
export function normalizeProtocolVersion(
  value: unknown,
): A2UIProtocolVersion | undefined {
  if (typeof value !== "string") return undefined;
  const match = DECLARED_VERSION.exec(value.trim());
  if (!match) return undefined;
  const majorMinor = `${Number(match[1])}.${Number(match[2])}`;
  if (majorMinor === "0.9") return A2UI_PROTOCOL_V0_9;
  if (majorMinor === "1.0") return A2UI_PROTOCOL_V1_0;
  return undefined;
}

/**
 * Protocol a catalog declares. Only an explicit `protocolVersion` selects 1.0;
 * an absent or unrecognised declaration keeps the v0.9 default. (The renderer
 * stamps exactly "1.0" on a 1.0 catalog; the ADK adapter accepts the semver
 * spellings above, so both are read here.)
 */
export function catalogProtocolVersion(catalog: unknown): A2UIProtocolVersion {
  if (catalog && typeof catalog === "object" && !Array.isArray(catalog)) {
    return (
      normalizeProtocolVersion(
        (catalog as Record<string, unknown>).protocolVersion,
      ) ?? A2UI_PROTOCOL_V0_9
    );
  }
  return A2UI_PROTOCOL_V0_9;
}

export interface ProtocolMarkers {
  /** Count of v0.9 value bindings / literals: `{path}`, `{literalString}`, … */
  v09: number;
  /** Count of 1.0 directives: `{"@path"}`, `{"@call"}`. */
  v1: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Count protocol-specific binding shapes in a flat component array.
 *
 * - 1.0 binds values with `{"@path": …}` and calls functions with `{"@call": …}`.
 * - v0.9 binds values with `{"path": …}` and spells literals as
 *   `{"literalString" | "literalNumber" | "literalBoolean": …}`.
 * - A repeat template `{componentId, path}` is identical in both protocols and
 *   is not counted.
 */
export function detectProtocolMarkers(
  components: Array<Record<string, unknown>>,
): ProtocolMarkers {
  const markers: ProtocolMarkers = { v09: 0, v1: 0 };
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isRecord(node)) return;
    if ("@path" in node || "@call" in node) {
      markers.v1 += 1;
    } else if (
      typeof node.path === "string" &&
      typeof node.componentId !== "string"
    ) {
      markers.v09 += 1;
    } else if (
      "literalString" in node ||
      "literalNumber" in node ||
      "literalBoolean" in node
    ) {
      markers.v09 += 1;
    }
    for (const value of Object.values(node)) visit(value);
  };
  for (const component of components) {
    if (!isRecord(component)) continue;
    for (const [key, value] of Object.entries(component)) {
      if (key === "id" || key === "component") continue;
      visit(value);
    }
  }
  return markers;
}

export interface ProtocolMismatchError {
  code: "protocol_mismatch";
  path: string;
  message: string;
}

/**
 * Errors for a payload whose bindings contradict the declared catalog
 * protocol. Empty when the payload is protocol-neutral or matches.
 *
 * A `{path}` object is only evidence of v0.9 when the payload carries no 1.0
 * directive at all: `"@path"`/`"@call"` cannot appear in v0.9, so once they do,
 * a `{path}` object is a literal value (1.0 treats it as one).
 */
export function protocolMismatchErrors(
  declared: A2UIProtocolVersion,
  markers: ProtocolMarkers,
): ProtocolMismatchError[] {
  const errors: ProtocolMismatchError[] = [];
  if (declared === A2UI_PROTOCOL_V1_0 && markers.v09 > 0 && markers.v1 === 0) {
    errors.push({
      code: "protocol_mismatch",
      path: "components",
      message:
        'Components use A2UI v0.9 bindings ({"path": ...} or literal* values) but the catalog declares protocol 1.0; bind values with {"@path": ...}',
    });
  }
  if (declared === A2UI_PROTOCOL_V0_9 && markers.v1 > 0) {
    errors.push({
      code: "protocol_mismatch",
      path: "components",
      message:
        'Components use A2UI 1.0 directives ("@path"/"@call") but the catalog declares protocol v0.9; bind values with {"path": ...}',
    });
  }
  return errors;
}
