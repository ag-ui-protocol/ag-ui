/**
 * Semantic validation of A2UI v0.9 component trees (OSS-162).
 *
 * The middleware's streaming path only checks *structural* completeness (array
 * closed, each item has a `component` string). This module adds the *semantic*
 * checks whose failures otherwise blow up at render time in `@a2ui/web_core`
 * ("Component not found", "Catalog not found", unresolved bindings) — turning
 * them into machine-readable errors the recovery loop can feed back to the
 * sub-agent.
 *
 * Used by BOTH the adapter (to decide whether to retry) and the middleware (to
 * decide whether to paint) so the two never disagree on what "valid" means.
 */

/** A single, machine-readable validation failure. */
export interface A2UIValidationError {
  code:
    | "empty_components"
    | "missing_id"
    | "missing_component_type"
    | "duplicate_id"
    | "no_root"
    | "unknown_component"
    | "missing_required_prop"
    | "unresolved_child"
    | "unresolved_binding";
  /** A JSON-pointer-ish locator, e.g. `components[2].component`. */
  path: string;
  /** Human/LLM-readable description (fed back to the sub-agent on retry). */
  message: string;
}

export interface ValidateA2UIResult {
  valid: boolean;
  errors: A2UIValidationError[];
}

/**
 * Inline JSON-Schema catalog (mirrors the middleware's `A2UIInlineCatalogSchema`):
 * component name → JSON Schema whose `required` lists mandatory props.
 */
export interface A2UIValidationCatalog {
  components: Record<string, { required?: string[]; properties?: Record<string, unknown>; [k: string]: unknown }>;
}

export interface ValidateA2UIInput {
  components: Array<Record<string, unknown>>;
  /** The surface's data model; used to resolve absolute binding paths. */
  data?: Record<string, unknown>;
  /** When omitted, catalog-dependent checks (membership, required props) are skipped. */
  catalog?: A2UIValidationCatalog;
  /**
   * Resolve absolute binding paths against `data`. Default `true`. Set `false`
   * at the streaming component-close boundary, where the component tree has
   * closed but the data model has not streamed yet — resolving bindings there
   * would false-positive (and trigger spurious retries). The adapter re-runs
   * full validation (bindings included) once the complete args arrive.
   */
  validateBindings?: boolean;
}

/** Does `path` (absolute, e.g. `/items/0/name`) resolve in `data`? */
function absolutePathResolves(path: string, data: unknown): boolean {
  const segments = path.split("/").filter((s) => s.length > 0);
  let cursor: unknown = data;
  for (const seg of segments) {
    if (cursor == null || typeof cursor !== "object") return false;
    if (Array.isArray(cursor)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) return false;
      cursor = cursor[idx];
    } else {
      if (!(seg in (cursor as Record<string, unknown>))) return false;
      cursor = (cursor as Record<string, unknown>)[seg];
    }
  }
  return true;
}

/** True for a plain (non-array) object. */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate a flat A2UI v0.9 component array.
 *
 * Structural checks always run. Catalog membership + required-prop checks run
 * only when `catalog` is supplied. Absolute binding paths (`/foo`) are resolved
 * against `data`; relative template paths (`name`) are left alone — they resolve
 * per-item inside a repeated template and flagging them would produce false
 * positives (and spurious retries).
 */
export function validateA2UIComponents(input: ValidateA2UIInput): ValidateA2UIResult {
  const { components, data, catalog } = input;
  const validateBindings = input.validateBindings ?? true;
  const errors: A2UIValidationError[] = [];

  // Fail loud on a non-array / empty payload — there is nothing to render and
  // nothing meaningful to feed back, so the caller must not treat it as a
  // recoverable surface silently.
  if (!Array.isArray(components) || components.length === 0) {
    return {
      valid: false,
      errors: [{ code: "empty_components", path: "components", message: "A2UI components must be a non-empty array" }],
    };
  }

  const ids = new Set<string>();
  const seen = new Set<string>();
  for (const comp of components) {
    const id = isObject(comp) ? comp.id : undefined;
    if (typeof id === "string") {
      if (seen.has(id)) {
        errors.push({ code: "duplicate_id", path: `components[id=${id}]`, message: `Duplicate component id '${id}'` });
      }
      seen.add(id);
      ids.add(id);
    }
  }

  components.forEach((comp, i) => {
    const id = isObject(comp) ? comp.id : undefined;
    const type = isObject(comp) ? comp.component : undefined;

    if (typeof id !== "string" || id.length === 0) {
      errors.push({ code: "missing_id", path: `components[${i}].id`, message: `Component at index ${i} is missing a string 'id'` });
    }
    if (typeof type !== "string" || type.length === 0) {
      errors.push({
        code: "missing_component_type",
        path: `components[${i}].component`,
        message: `Component at index ${i} is missing a string 'component' type`,
      });
    }

    // Catalog membership + required props (only when a catalog is supplied).
    if (catalog && typeof type === "string") {
      const schema = catalog.components[type];
      if (!schema) {
        errors.push({
          code: "unknown_component",
          path: `components[${i}].component`,
          message: `Component type '${type}' is not in the catalog`,
        });
      } else {
        for (const req of schema.required ?? []) {
          if (!isObject(comp) || !(req in comp)) {
            errors.push({
              code: "missing_required_prop",
              path: `components[${i}].${req}`,
              message: `Component '${type}' (index ${i}) is missing required prop '${req}'`,
            });
          }
        }
      }
    }

    // Child references must resolve to existing component ids.
    if (isObject(comp)) {
      collectChildRefs(comp.children).forEach((ref) => {
        if (!ids.has(ref)) {
          errors.push({
            code: "unresolved_child",
            path: `components[${i}].children`,
            message: `Child reference '${ref}' does not match any component id`,
          });
        }
      });

      // Absolute binding paths must resolve against the data model (unless
      // deferred — see `validateBindings`).
      if (validateBindings) collectAbsoluteBindingPaths(comp).forEach((p) => {
        if (!absolutePathResolves(p, data ?? {})) {
          errors.push({
            code: "unresolved_binding",
            path: `components[${i}]`,
            message: `Binding path '${p}' does not resolve in the data model`,
          });
        }
      });
    }
  });

  if (!components.some((c) => isObject(c) && c.id === "root")) {
    errors.push({ code: "no_root", path: "components", message: "No component has id 'root'" });
  }

  return { valid: errors.length === 0, errors };
}

/** Pull child-id references out of a `children` value (array of ids or {componentId,...}). */
function collectChildRefs(children: unknown): string[] {
  const refs: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string") refs.push(v);
    else if (isObject(v) && typeof v.componentId === "string") refs.push(v.componentId);
  };
  if (Array.isArray(children)) children.forEach(push);
  else if (isObject(children)) push(children);
  return refs;
}

/** Recursively collect absolute (`/…`) binding paths from a component's props. */
function collectAbsoluteBindingPaths(node: unknown, acc: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((v) => collectAbsoluteBindingPaths(v, acc));
  } else if (isObject(node)) {
    if (typeof node.path === "string" && node.path.startsWith("/")) acc.push(node.path);
    for (const [k, v] of Object.entries(node)) {
      if (k === "path") continue;
      collectAbsoluteBindingPaths(v, acc);
    }
  }
  return acc;
}
