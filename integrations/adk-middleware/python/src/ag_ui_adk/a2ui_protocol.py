"""Protocol 1.0 defaults and validation until the shared toolkit supports it.

The published toolkit's builders and 0.9 recovery remain unchanged. This local
loop keeps its error/attempt contract while validating native 1.0 directives.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Optional

from a2ui.core import A2uiError, Catalog
from a2ui.utils import validate_payload
from ag_ui_a2ui_toolkit import (
    DEFAULT_DESIGN_GUIDELINES,
    DEFAULT_GENERATION_GUIDELINES,
    MAX_A2UI_ATTEMPTS,
    A2UIGenerationError,
    augment_prompt_with_validation_errors,
    validate_a2ui_components,
)


def v1_guidelines(guidelines: Optional[dict], *, direct_json: bool) -> dict:
    """Change only unset defaults; host-provided prose remains verbatim."""
    result = dict(guidelines or {})
    if direct_json and result.get("generation_guidelines") is None:
        result["generation_guidelines"] = (
            DEFAULT_GENERATION_GUIDELINES.replace(
                "Generate A2UI v0.9 JSON.", "Generate A2UI 1.0 JSON."
            ).replace('"path"', '"@path"')
            + "\nUse only components, properties and functions defined by the supplied "
            'catalog. A function call uses {"@call": "functionName", "args": {...}}, '
            'without returnType. Literal objects may contain a "path" key; '
            'only "@path" denotes a data binding in 1.0.\n'
        )
    if result.get("design_guidelines") is None:
        result["design_guidelines"] = DEFAULT_DESIGN_GUIDELINES.replace(
            '"path"', '"@path"'
        )
    return result


def _path_resolves(path: str, data: Any) -> bool:
    if path == "/":
        return True
    cursor = data
    for raw_segment in path[1:].split("/"):
        segment = raw_segment.replace("~1", "/").replace("~0", "~")
        if isinstance(cursor, dict) and segment in cursor:
            cursor = cursor[segment]
        elif (
            isinstance(cursor, list)
            and segment.isdigit()
            and int(segment) < len(cursor)
        ):
            cursor = cursor[int(segment)]
        else:
            return False
    return True


def validate_v1_components(
    *,
    components: Any,
    data: Optional[dict] = None,
    catalog: Optional[dict] = None,
    validate_schema: bool = True,
) -> dict:
    """Reuse structural checks, then the SDK schema and native binding rules."""
    result = validate_a2ui_components(
        components=components, data=data, catalog=catalog, validate_bindings=False
    )
    if not result["valid"]:
        return result
    if validate_schema and catalog is not None:
        try:
            validate_payload(
                [Catalog.from_json(catalog)],
                {
                    "version": "1.0",
                    "createSurface": {
                        "surfaceId": "validation",
                        "catalogId": catalog["catalogId"],
                        "components": components,
                        "dataModel": data or {},
                    },
                },
            )
        except A2uiError as error:
            return {
                "valid": False,
                "errors": [
                    {
                        "code": "a2ui_validation_error",
                        "path": "components",
                        "message": str(error),
                    }
                ],
            }

    errors = []

    def bindings(node: Any, location: str) -> None:
        if isinstance(node, list):
            for index, value in enumerate(node):
                bindings(value, f"{location}[{index}]")
        elif isinstance(node, dict):
            path = node.get("@path")
            if (
                isinstance(path, str)
                and path.startswith("/")
                and not _path_resolves(path, data)
            ):
                errors.append(
                    {
                        "code": "unresolved_binding",
                        "path": location,
                        "message": (
                            f"Binding path '{path}' does not resolve in the data model"
                        ),
                    }
                )
            for key, value in node.items():
                bindings(value, f"{location}.{key}")

    bindings(components, "components")
    return {"valid": not errors, "errors": errors}


def run_v1_generation_with_recovery(
    *,
    base_prompt: str,
    invoke_subagent: Callable[[str, int], Optional[dict[str, Any]]],
    build_envelope: Callable[[dict[str, Any]], str],
    catalog: Optional[dict[str, Any]] = None,
    config: Optional[dict[str, Any]] = None,
    on_attempt: Optional[Callable[[dict[str, Any]], None]] = None,
    validate_schema: bool = True,
) -> dict[str, Any]:
    """Toolkit 0.0.6's bounded recovery contract with 1.0 validation.

    The toolkit does not expose a validator callback. Keep the same diagnostics,
    callback order and exhausted envelope here; transport/cancellation exceptions
    propagate as before, while only A2UIGenerationError enters recovery.
    """
    max_attempts = (config or {}).get("maxAttempts", MAX_A2UI_ATTEMPTS)
    attempts: list[dict[str, Any]] = []
    last_errors: list[dict[str, str]] = []
    for attempt in range(1, max_attempts + 1):
        prompt = augment_prompt_with_validation_errors(base_prompt, last_errors)
        result: dict[str, Any]
        try:
            args = invoke_subagent(prompt, attempt)
            if not args:
                result = {
                    "valid": False,
                    "errors": [
                        {
                            "code": "empty_components",
                            "path": "components",
                            "message": "Sub-agent did not call render_a2ui",
                        }
                    ],
                }
            else:
                raw_components, raw_data = args.get("components"), args.get("data")
                result = validate_v1_components(
                    components=(
                        raw_components if isinstance(raw_components, list) else []
                    ),
                    data=raw_data if isinstance(raw_data, dict) else {},
                    catalog=catalog,
                    validate_schema=validate_schema,
                )
        except A2UIGenerationError as error:
            result = {"valid": False, "errors": error.errors}
        record = {"attempt": attempt, "ok": result["valid"], "errors": result["errors"]}
        attempts.append(record)
        if on_attempt:
            on_attempt(record)
        if result["valid"]:
            assert args is not None
            return {"envelope": build_envelope(args), "attempts": attempts, "ok": True}
        last_errors = result["errors"]
    return {
        "envelope": json.dumps(
            {
                "error": (
                    f"Failed to generate valid A2UI after {max_attempts} attempt(s)"
                ),
                "code": "a2ui_recovery_exhausted",
                "attempts": attempts,
            }
        ),
        "attempts": attempts,
        "ok": False,
    }
