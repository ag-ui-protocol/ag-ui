import { describe, it, expect } from "vitest";
import { validateA2UIComponents } from "../validate";

// A minimal inline JSON-Schema catalog mirroring the middleware's
// A2UIInlineCatalogSchema: components keyed by name, each a JSON Schema whose
// `required` lists mandatory props.
const CATALOG = {
  components: {
    Row: {
      type: "object",
      properties: { gap: { type: "number" }, children: {} },
      required: ["children"],
    },
    HotelCard: {
      type: "object",
      properties: {
        name: {},
        location: {},
        rating: {},
        pricePerNight: {},
        action: {},
      },
      required: ["name", "location", "rating", "pricePerNight"],
    },
  },
};

// A well-formed dynamic surface: Row root repeating a HotelCard over /items.
function validComponents() {
  return [
    {
      id: "root",
      component: "Row",
      children: { componentId: "card", path: "/items" },
    },
    {
      id: "card",
      component: "HotelCard",
      name: { path: "name" },
      location: { path: "location" },
      rating: { path: "rating" },
      pricePerNight: { path: "pricePerNight" },
    },
  ];
}
const VALID_DATA = { items: [{ name: "Ritz", location: "NYC", rating: 4.8, pricePerNight: "$450" }] };

describe("validateA2UIComponents — happy path", () => {
  it("accepts a well-formed surface against its catalog", () => {
    const r = validateA2UIComponents({ components: validComponents(), data: VALID_DATA, catalog: CATALOG });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });
});

describe("validateA2UIComponents — structural (no catalog needed)", () => {
  it("flags a missing root component", () => {
    const comps = validComponents().map((c) => (c.id === "root" ? { ...c, id: "container" } : c));
    const r = validateA2UIComponents({ components: comps, data: VALID_DATA, catalog: CATALOG });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.code === "no_root")).toBe(true);
  });

  it("flags a component missing a string id", () => {
    const comps: Array<Record<string, unknown>> = [{ component: "Row", children: [] }];
    const r = validateA2UIComponents({ components: comps });
    expect(r.errors.some((e) => e.code === "missing_id" && e.path === "components[0].id")).toBe(true);
  });

  it("flags a component missing a string component type", () => {
    const comps: Array<Record<string, unknown>> = [{ id: "root" }];
    const r = validateA2UIComponents({ components: comps });
    expect(r.errors.some((e) => e.code === "missing_component_type")).toBe(true);
  });

  it("flags duplicate ids", () => {
    const comps = [
      { id: "root", component: "Row", children: ["x"] },
      { id: "x", component: "Row", children: [] },
      { id: "x", component: "Row", children: [] },
    ];
    const r = validateA2UIComponents({ components: comps });
    expect(r.errors.some((e) => e.code === "duplicate_id")).toBe(true);
  });

  it("fails loud on a non-array / empty components payload", () => {
    expect(validateA2UIComponents({ components: [] }).valid).toBe(false);
    // @ts-expect-error — exercising the untrusted-input guard
    expect(validateA2UIComponents({ components: null }).valid).toBe(false);
  });
});

describe("validateA2UIComponents — catalog semantics (only when a catalog is supplied)", () => {
  it("flags a component type not in the catalog", () => {
    const comps = validComponents().map((c) => (c.id === "card" ? { ...c, component: "MysteryCard" } : c));
    const r = validateA2UIComponents({ components: comps, data: VALID_DATA, catalog: CATALOG });
    expect(r.errors.some((e) => e.code === "unknown_component" && e.path === "components[1].component")).toBe(true);
  });

  it("flags a missing required prop per the catalog schema", () => {
    const comps = validComponents().map((c) => {
      if (c.id !== "card") return c;
      const { pricePerNight, ...rest } = c as Record<string, unknown>;
      return rest;
    });
    const r = validateA2UIComponents({ components: comps, data: VALID_DATA, catalog: CATALOG });
    expect(r.errors.some((e) => e.code === "missing_required_prop" && /pricePerNight/.test(e.message))).toBe(true);
  });

  it("skips catalog checks entirely when no catalog is supplied (structural-only)", () => {
    const comps = validComponents().map((c) => (c.id === "card" ? { ...c, component: "MysteryCard" } : c));
    const r = validateA2UIComponents({ components: comps, data: VALID_DATA });
    expect(r.errors.some((e) => e.code === "unknown_component")).toBe(false);
    expect(r.valid).toBe(true);
  });
});

describe("validateA2UIComponents — child references", () => {
  it("flags a structural child referencing a non-existent component id", () => {
    const comps = [
      { id: "root", component: "Row", children: { componentId: "ghost", path: "/items" } },
    ];
    const r = validateA2UIComponents({ components: comps, data: VALID_DATA, catalog: CATALOG });
    expect(r.errors.some((e) => e.code === "unresolved_child" && /ghost/.test(e.message))).toBe(true);
  });

  it("flags an array child id that does not resolve", () => {
    const comps = [
      { id: "root", component: "Row", children: ["missing-1"] },
    ];
    const r = validateA2UIComponents({ components: comps });
    expect(r.errors.some((e) => e.code === "unresolved_child" && /missing-1/.test(e.message))).toBe(true);
  });
});

describe("validateA2UIComponents — data bindings", () => {
  it("flags an absolute binding path absent from the data model", () => {
    const r = validateA2UIComponents({ components: validComponents(), data: {}, catalog: CATALOG });
    expect(r.errors.some((e) => e.code === "unresolved_binding" && /\/items/.test(e.message))).toBe(true);
  });

  it("does not flag relative template bindings (resolved per-item, lenient)", () => {
    // `name`/`location`/... are relative paths inside the repeated card template.
    const r = validateA2UIComponents({ components: validComponents(), data: VALID_DATA, catalog: CATALOG });
    expect(r.errors.some((e) => e.code === "unresolved_binding")).toBe(false);
  });

  it("defers binding checks when validateBindings is false (streaming component-close boundary)", () => {
    // At the streaming boundary the components array has closed but the data
    // model has not streamed yet — binding resolution would false-positive.
    const r = validateA2UIComponents({
      components: validComponents(),
      data: {},
      catalog: CATALOG,
      validateBindings: false,
    });
    expect(r.errors.some((e) => e.code === "unresolved_binding")).toBe(false);
    expect(r.valid).toBe(true);
  });
});
