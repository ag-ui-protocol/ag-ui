"""Unit tests for ag_ui_a2ui_toolkit.validate.

Mirrors the TypeScript ``a2ui-toolkit/src/__tests__/validate.test.ts`` so both
languages stay aligned on what counts as a valid A2UI surface (OSS-162).
"""

from __future__ import annotations

import unittest

from ag_ui_a2ui_toolkit import validate_a2ui_components

CATALOG = {
    "components": {
        "Row": {"type": "object", "required": ["children"]},
        "HotelCard": {
            "type": "object",
            "required": ["name", "location", "rating", "pricePerNight"],
        },
    }
}


def valid_components():
    return [
        {"id": "root", "component": "Row", "children": {"componentId": "card", "path": "/items"}},
        {
            "id": "card",
            "component": "HotelCard",
            "name": {"path": "name"},
            "location": {"path": "location"},
            "rating": {"path": "rating"},
            "pricePerNight": {"path": "pricePerNight"},
        },
    ]


VALID_DATA = {"items": [{"name": "Ritz", "location": "NYC", "rating": 4.8, "pricePerNight": "$450"}]}


def codes(result):
    return {e["code"] for e in result["errors"]}


class TestHappyPath(unittest.TestCase):
    def test_accepts_well_formed_surface(self):
        r = validate_a2ui_components(components=valid_components(), data=VALID_DATA, catalog=CATALOG)
        self.assertTrue(r["valid"])
        self.assertEqual(r["errors"], [])


class TestStructural(unittest.TestCase):
    def test_missing_root(self):
        comps = [{**c, "id": "container"} if c["id"] == "root" else c for c in valid_components()]
        r = validate_a2ui_components(components=comps, data=VALID_DATA, catalog=CATALOG)
        self.assertFalse(r["valid"])
        self.assertIn("no_root", codes(r))

    def test_missing_id(self):
        r = validate_a2ui_components(components=[{"component": "Row", "children": []}])
        self.assertIn("missing_id", codes(r))

    def test_missing_component_type(self):
        r = validate_a2ui_components(components=[{"id": "root"}])
        self.assertIn("missing_component_type", codes(r))

    def test_duplicate_id(self):
        comps = [
            {"id": "root", "component": "Row", "children": ["x"]},
            {"id": "x", "component": "Row", "children": []},
            {"id": "x", "component": "Row", "children": []},
        ]
        self.assertIn("duplicate_id", codes(validate_a2ui_components(components=comps)))

    def test_empty_or_non_list_fails_loud(self):
        self.assertFalse(validate_a2ui_components(components=[])["valid"])
        self.assertFalse(validate_a2ui_components(components=None)["valid"])


class TestCatalogSemantics(unittest.TestCase):
    def test_unknown_component(self):
        comps = [{**c, "component": "MysteryCard"} if c["id"] == "card" else c for c in valid_components()]
        r = validate_a2ui_components(components=comps, data=VALID_DATA, catalog=CATALOG)
        self.assertIn("unknown_component", codes(r))

    def test_missing_required_prop(self):
        comps = []
        for c in valid_components():
            if c["id"] == "card":
                c = {k: v for k, v in c.items() if k != "pricePerNight"}
            comps.append(c)
        r = validate_a2ui_components(components=comps, data=VALID_DATA, catalog=CATALOG)
        self.assertTrue(any(e["code"] == "missing_required_prop" and "pricePerNight" in e["message"] for e in r["errors"]))

    def test_structural_only_without_catalog(self):
        comps = [{**c, "component": "MysteryCard"} if c["id"] == "card" else c for c in valid_components()]
        r = validate_a2ui_components(components=comps, data=VALID_DATA)
        self.assertNotIn("unknown_component", codes(r))
        self.assertTrue(r["valid"])


class TestChildRefs(unittest.TestCase):
    def test_structural_child_unresolved(self):
        comps = [{"id": "root", "component": "Row", "children": {"componentId": "ghost", "path": "/items"}}]
        r = validate_a2ui_components(components=comps, data=VALID_DATA, catalog=CATALOG)
        self.assertTrue(any(e["code"] == "unresolved_child" and "ghost" in e["message"] for e in r["errors"]))

    def test_array_child_unresolved(self):
        comps = [{"id": "root", "component": "Row", "children": ["missing-1"]}]
        r = validate_a2ui_components(components=comps)
        self.assertTrue(any(e["code"] == "unresolved_child" and "missing-1" in e["message"] for e in r["errors"]))

    def test_singular_child_unresolved(self):
        # One-child containers (Card/Button) use the singular `child`, which the
        # default generation prompt emits — a dangling ref there must be caught too.
        comps = [{"id": "root", "component": "Card", "child": "ghost"}]
        r = validate_a2ui_components(components=comps)
        self.assertTrue(
            any(e["code"] == "unresolved_child" and e["path"] == "components[0].child" and "ghost" in e["message"] for e in r["errors"])
        )

    def test_singular_child_resolved(self):
        comps = [
            {"id": "root", "component": "Card", "child": "label"},
            {"id": "label", "component": "Text"},
        ]
        r = validate_a2ui_components(components=comps)
        self.assertNotIn("unresolved_child", codes(r))


class TestChildCycles(unittest.TestCase):
    def test_self_referential_child(self):
        comps = [{"id": "avatar", "component": "Card", "child": "avatar"}]
        r = validate_a2ui_components(components=comps)
        self.assertFalse(r["valid"])
        self.assertTrue(any(e["code"] == "child_cycle" and "avatar -> avatar" in e["message"] for e in r["errors"]))

    def test_multi_component_cycle_reported_once(self):
        comps = [
            {"id": "root", "component": "Row", "children": ["a"]},
            {"id": "a", "component": "Row", "children": ["b"]},
            {"id": "b", "component": "Row", "children": ["a"]},
        ]
        r = validate_a2ui_components(components=comps)
        self.assertEqual(len([e for e in r["errors"] if e["code"] == "child_cycle"]), 1)
        self.assertTrue(any(e["code"] == "child_cycle" and "a -> b -> a" in e["message"] for e in r["errors"]))

    def test_acyclic_graph_not_flagged(self):
        comps = [
            {"id": "root", "component": "Row", "children": ["a", "b"]},
            {"id": "a", "component": "Text"},
            {"id": "b", "component": "Text"},
        ]
        r = validate_a2ui_components(components=comps)
        self.assertNotIn("child_cycle", codes(r))

    def test_deep_chain_no_recursion_error(self):
        # The cycle check runs on untrusted model output; a deep linear chain that
        # would exceed CPython's recursion limit (~1000) must validate iteratively.
        n = 5000
        comps = [{"id": "root", "component": "Row", "children": ["n0"]}]
        comps += [
            {"id": f"n{i}", "component": "Row", "children": ([f"n{i + 1}"] if i + 1 < n else [])}
            for i in range(n)
        ]
        r = validate_a2ui_components(components=comps)
        self.assertNotIn("child_cycle", codes(r))

    def test_deep_chain_closing_cycle_reported_once(self):
        # Same deep chain, but the tail points back at root — one cycle, no overflow.
        n = 5000
        comps = [{"id": "root", "component": "Row", "children": ["n0"]}]
        comps += [
            {"id": f"n{i}", "component": "Row", "children": [f"n{i + 1}" if i + 1 < n else "root"]}
            for i in range(n)
        ]
        r = validate_a2ui_components(components=comps)
        self.assertEqual(len([e for e in r["errors"] if e["code"] == "child_cycle"]), 1)


class TestBindings(unittest.TestCase):
    def test_absolute_binding_unresolved(self):
        r = validate_a2ui_components(components=valid_components(), data={}, catalog=CATALOG)
        self.assertTrue(any(e["code"] == "unresolved_binding" and "/items" in e["message"] for e in r["errors"]))

    def test_relative_bindings_lenient(self):
        r = validate_a2ui_components(components=valid_components(), data=VALID_DATA, catalog=CATALOG)
        self.assertNotIn("unresolved_binding", codes(r))

    def test_defers_bindings_when_validate_bindings_false(self):
        r = validate_a2ui_components(components=valid_components(), data={}, catalog=CATALOG, validate_bindings=False)
        self.assertNotIn("unresolved_binding", codes(r))
        self.assertTrue(r["valid"])


if __name__ == "__main__":
    unittest.main()
