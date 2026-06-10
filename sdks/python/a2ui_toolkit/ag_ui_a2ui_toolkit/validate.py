"""Semantic validation of A2UI v0.9 component trees (OSS-162).

Python port of ``a2ui-toolkit/src/validate.ts`` — kept behaviorally identical so
the framework adapters and the middleware agree on what "valid" means. Adds the
semantic checks (catalog membership, required props, child refs, binding
resolution) whose failures otherwise blow up at render time, turning them into
machine-readable errors the recovery loop can feed back to the sub-agent.
"""

from __future__ import annotations

from typing import Any, Optional

# A validation error is a plain dict: {"code", "path", "message"} — JSON-friendly
# so it can ride straight into a prompt / event payload.
A2UIValidationError = dict[str, str]
ValidateA2UIResult = dict[str, Any]  # {"valid": bool, "errors": list[A2UIValidationError]}


def _is_object(v: Any) -> bool:
    return isinstance(v, dict)


def _absolute_path_resolves(path: str, data: Any) -> bool:
    segments = [s for s in path.split("/") if s]
    cursor: Any = data
    for seg in segments:
        if cursor is None or not isinstance(cursor, (dict, list)):
            return False
        if isinstance(cursor, list):
            try:
                idx = int(seg)
            except ValueError:
                return False
            if idx < 0 or idx >= len(cursor):
                return False
            cursor = cursor[idx]
        else:
            if seg not in cursor:
                return False
            cursor = cursor[seg]
    return True


def _collect_child_refs(children: Any) -> list[str]:
    refs: list[str] = []

    def push(v: Any) -> None:
        if isinstance(v, str):
            refs.append(v)
        elif _is_object(v) and isinstance(v.get("componentId"), str):
            refs.append(v["componentId"])

    if isinstance(children, list):
        for v in children:
            push(v)
    elif _is_object(children):
        push(children)
    return refs


def _collect_absolute_binding_paths(node: Any, acc: list[str]) -> list[str]:
    if isinstance(node, list):
        for v in node:
            _collect_absolute_binding_paths(v, acc)
    elif _is_object(node):
        p = node.get("path")
        if isinstance(p, str) and p.startswith("/"):
            acc.append(p)
        for k, v in node.items():
            if k == "path":
                continue
            _collect_absolute_binding_paths(v, acc)
    return acc


def validate_a2ui_components(
    *,
    components: Any,
    data: Optional[dict[str, Any]] = None,
    catalog: Optional[dict[str, Any]] = None,
    validate_bindings: bool = True,
) -> ValidateA2UIResult:
    """Validate a flat A2UI v0.9 component array.

    Structural checks always run. Catalog membership + required-prop checks run
    only when ``catalog`` is supplied. Absolute binding paths (``/foo``) resolve
    against ``data``; relative template paths (``name``) are left alone — they
    resolve per-item inside a repeated template and flagging them would produce
    false positives (and spurious retries).
    """
    errors: list[A2UIValidationError] = []

    # Fail loud on a non-list / empty payload.
    if not isinstance(components, list) or len(components) == 0:
        return {
            "valid": False,
            "errors": [{"code": "empty_components", "path": "components", "message": "A2UI components must be a non-empty array"}],
        }

    ids: set[str] = set()
    seen: set[str] = set()
    for comp in components:
        cid = comp.get("id") if _is_object(comp) else None
        if isinstance(cid, str):
            if cid in seen:
                errors.append({"code": "duplicate_id", "path": f"components[id={cid}]", "message": f"Duplicate component id '{cid}'"})
            seen.add(cid)
            ids.add(cid)

    catalog_components = (catalog or {}).get("components", {}) if catalog else {}

    for i, comp in enumerate(components):
        cid = comp.get("id") if _is_object(comp) else None
        ctype = comp.get("component") if _is_object(comp) else None

        if not isinstance(cid, str) or len(cid) == 0:
            errors.append({"code": "missing_id", "path": f"components[{i}].id", "message": f"Component at index {i} is missing a string 'id'"})
        if not isinstance(ctype, str) or len(ctype) == 0:
            errors.append({"code": "missing_component_type", "path": f"components[{i}].component", "message": f"Component at index {i} is missing a string 'component' type"})

        if catalog and isinstance(ctype, str):
            schema = catalog_components.get(ctype)
            if schema is None:
                errors.append({"code": "unknown_component", "path": f"components[{i}].component", "message": f"Component type '{ctype}' is not in the catalog"})
            else:
                for req in schema.get("required", []) or []:
                    if not _is_object(comp) or req not in comp:
                        errors.append({"code": "missing_required_prop", "path": f"components[{i}].{req}", "message": f"Component '{ctype}' (index {i}) is missing required prop '{req}'"})

        if _is_object(comp):
            for ref in _collect_child_refs(comp.get("children")):
                if ref not in ids:
                    errors.append({"code": "unresolved_child", "path": f"components[{i}].children", "message": f"Child reference '{ref}' does not match any component id"})
            for p in (_collect_absolute_binding_paths(comp, []) if validate_bindings else []):
                if not _absolute_path_resolves(p, data or {}):
                    errors.append({"code": "unresolved_binding", "path": f"components[{i}]", "message": f"Binding path '{p}' does not resolve in the data model"})

    if not any(_is_object(c) and c.get("id") == "root" for c in components):
        errors.append({"code": "no_root", "path": "components", "message": "No component has id 'root'"})

    return {"valid": len(errors) == 0, "errors": errors}
