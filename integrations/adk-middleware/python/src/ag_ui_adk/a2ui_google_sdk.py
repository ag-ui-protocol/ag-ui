"""Official A2UI SDK reuse for ADK inference.

The default Direct JSON path reuses released prompt rendering and JSON healing,
with the existing lenient toolkit validation for client catalogs. Express uses
an isolated temporary upstream Agent SDK/core snapshot for its official prompt,
compiler, progressive stream and strict renderer validation. See ``_vendor`` for
revision, license, reproducibility manifest and removal condition.

Imports remain framework-independent: no ``a2ui.a2a``, ``a2ui.adk`` or ``a2a``.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

from a2ui.core import Catalog
from a2ui.core.common import to_protocol_version
from a2ui.core.schema import ProtocolVersion
from a2ui.inference_formats.direct_json import DirectJsonFormatFactory
from a2ui.parser.payload_fixer import parse_and_fix
from a2ui.processor import A2uiRequestProcessor

logger = logging.getLogger("ag_ui_adk")

# Prompt messages matching the toolkit's create/update operations (no delete).
# The SDK prunes v0.8 by wire key and v0.9 by schema definition name.
_PROMPT_ALLOWED_MESSAGES: dict[ProtocolVersion, tuple[str, ...]] = {
    ProtocolVersion.V0_8: ("beginRendering", "surfaceUpdate", "dataModelUpdate"),
    ProtocolVersion.V0_9: (
        "CreateSurfaceMessage",
        "UpdateComponentsMessage",
        "UpdateDataModelMessage",
    ),
}

_DEFAULT_JSON_SCHEMA = "https://json-schema.org/draft/2020-12/schema"


def normalize_catalog_dict(
    source: Any, *, default_catalog_id: Optional[str]
) -> Optional[dict[str, Any]]:
    """Coerce a host-supplied catalog into the inline catalog dict shape
    ``{"catalogId": str, "components": {name: json-schema}}``.

    Accepts a dict carrying ``components``; a JSON string of one; or the legacy
    middleware ``A2UIComponentSchema[]`` list ``[{name, props/properties}]``.
    ``catalogId`` is filled from ``default_catalog_id`` when absent. Returns
    ``None`` for anything unusable (empty components, wrong types, unparseable
    string).
    """
    if isinstance(source, str):
        try:
            source = json.loads(source)
        except (ValueError, TypeError):
            return None

    if isinstance(source, dict):
        components = source.get("components")
        if not isinstance(components, dict) or not components:
            return None
        catalog_id = source.get("catalogId") or default_catalog_id
        if not catalog_id:
            return None
        out = dict(source)
        out["catalogId"] = catalog_id
        out.setdefault("$schema", _DEFAULT_JSON_SCHEMA)
        return out

    if isinstance(source, list):
        components = {}
        for item in source:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            if not isinstance(name, str) or not name:
                continue
            comp = item.get("properties") or item.get("props") or {}
            components[name] = comp if isinstance(comp, dict) else {}
        if not components or not default_catalog_id:
            return None
        return {
            "$schema": _DEFAULT_JSON_SCHEMA,
            "catalogId": default_catalog_id,
            "components": components,
        }

    return None


# Building the processor + rendering is non-trivial and the same catalog recurs
# across every run; memoize by normalized catalog (including id and version).
_RENDER_CACHE: dict[Any, Optional[str]] = {}


def render_catalog_instructions(
    source: Any, *, default_catalog_id: Optional[str]
) -> Optional[str]:
    """Render a host-supplied catalog into a prompt schema block via Google's
    Direct JSON catalog instructions (agent-to-renderer envelope + common-types
    definitions + catalog components).

    This is render-only: it never resolves ``$ref``\\s, so it tolerates the client's
    non-conformant zod-extracted catalog. Returns the rendered text, or ``None`` if
    the catalog can't be normalized/built (the caller then falls back to the raw
    catalog text — today's behavior).
    """
    normalized = normalize_catalog_dict(source, default_catalog_id=default_catalog_id)
    if normalized is None:
        return None
    try:
        key = json.dumps(normalized, sort_keys=True)
    except (TypeError, ValueError):
        key = None
    if key is not None and key in _RENDER_CACHE:
        return _RENDER_CACHE[key]

    try:
        # from_json retains the client's schema without strict $ref resolution.
        # Its protocol defaults to 0.9 when protocolVersion is absent.
        catalog = Catalog.from_json(normalized)
        version = to_protocol_version(catalog.protocol_version)
        processor = A2uiRequestProcessor(
            catalogs=[catalog],
            format_factory=DirectJsonFormatFactory(
                allowed_messages=_PROMPT_ALLOWED_MESSAGES[version]
            ),
        )
        # prompt_snippet also adds workflow/tag-delivery rules, which conflict
        # with our forced render_a2ui tool. Reuse only the schema prompt method.
        instructions = processor.format.prompt_generator.generate_catalog_instructions()
    except Exception as e:  # noqa: BLE001 — render is best-effort; degrade to raw
        logger.warning(
            "Could not render the A2UI catalog via the SDK; falling back to the "
            "raw catalog text in the prompt: %s",
            e,
        )
        instructions = None

    if key is not None:
        _RENDER_CACHE[key] = instructions
    return instructions


def heal_json_arg(value: str, *, expect: str) -> Any:
    """Heal + parse Gemini's free-form JSON-string ``components``/``data`` arg via
    the SDK's ``parse_and_fix`` (smart quotes, trailing commas, single-object→list
    wrap).

    ``expect="list"`` returns the healed list; ``expect="dict"`` unwraps
    ``parse_and_fix``'s single-element list back to the object it wrapped. Raises
    ``ValueError`` on a hard parse failure or when ``expect="dict"`` but the payload
    isn't a single JSON object.
    """
    parsed = parse_and_fix(value)  # always a list (single objects are wrapped)
    if expect == "list":
        return parsed
    if isinstance(parsed, list) and len(parsed) == 1 and isinstance(parsed[0], dict):
        return parsed[0]
    if isinstance(parsed, dict):  # defensive — parse_and_fix returns a list
        return parsed
    raise ValueError("expected a single JSON object")


def _catalog_for_express(source: Any, *, default_catalog_id: str) -> dict[str, Any]:
    """Retain the client's schema and relocate valid component-local refs.

    Some schema exporters root ``#/properties/...`` at an individual component.
    The inline catalog adds a containing document. Relocate only refs that do
    not resolve there but do resolve in that original component; never guess a
    missing type or discard constraints. The copied dict preserves field order.
    """
    import copy

    normalized = normalize_catalog_dict(source, default_catalog_id=default_catalog_id)
    if normalized is None:
        if source is not None:
            raise ValueError("Express requires a usable inline A2UI catalog")
        from ._vendor.a2ui.core.basic_catalog import BasicCatalog

        normalized = BasicCatalog("v0.9").to_json()
        normalized["catalogId"] = default_catalog_id
    normalized = copy.deepcopy(normalized)

    # The web SDK exports function definitions as a list. The Express schema
    # helper consumes the equivalent v0.9 function-call schema mapping. Retain
    # declaration and argument order: Express positional arguments depend on it.
    functions = normalized.get("functions")
    if isinstance(functions, list):
        converted: dict[str, Any] = {}
        for entry in functions:
            if not isinstance(entry, dict):
                raise ValueError("A catalog function must be an object")
            name = entry.get("name")
            parameters = entry.get("parameters")
            if not isinstance(name, str) or not name or name in converted:
                raise ValueError("Catalog function names must be non-empty and unique")
            if not isinstance(parameters, dict):
                raise ValueError(
                    f"Catalog function {name!r} parameters must be a schema object"
                )
            definition = {
                key: value
                for key, value in entry.items()
                if key not in {"name", "parameters", "returnType"}
            }
            properties = {"call": {"const": name}, "args": parameters}
            if "returnType" in entry:
                properties["returnType"] = {"const": entry["returnType"]}
            definition.update(
                {
                    "type": "object",
                    "properties": properties,
                    "required": ["call", "args"],
                    "unevaluatedProperties": False,
                }
            )
            converted[name] = definition
        normalized["functions"] = converted

    def resolves(document: Any, reference: str) -> bool:
        try:
            for key in reference[2:].split("/"):
                document = document[key.replace("~1", "/").replace("~0", "~")]
            return True
        except (KeyError, TypeError, IndexError):
            return False

    def relocate(node: Any, original: dict, name: str) -> None:
        if isinstance(node, list):
            for item in node:
                relocate(item, original, name)
        elif isinstance(node, dict):
            ref = node.get("$ref")
            if (
                isinstance(ref, str)
                and ref.startswith("#/")
                and not resolves(normalized, ref)
                and resolves(original, ref)
            ):
                escaped = name.replace("~", "~0").replace("/", "~1")
                node["$ref"] = f"#/components/{escaped}/{ref[2:]}"
            for value in node.values():
                relocate(value, original, name)

    for name, component in normalized["components"].items():
        relocate(component, copy.deepcopy(component), name)
    return normalized


def create_express_processor(
    source: Any, *, default_catalog_id: str, surface_id: str
) -> Any:
    """Create the official upstream streaming processor for one A2UI v0.9 surface.

    This uses the isolated temporary SDK snapshot documented in ``_vendor``.
    Released Direct JSON and JSON healing imports above remain unchanged.
    """
    from ._vendor.a2ui.core import Catalog as ExpressCatalog
    from ._vendor.a2ui.core.common import to_protocol_version as express_version
    from ._vendor.a2ui.core.schema import ProtocolVersion as ExpressVersion
    from ._vendor.a2ui.inference_formats.express import ExpressFormatFactory
    from ._vendor.a2ui.processor import A2uiRequestProcessor as ExpressProcessor

    catalog = ExpressCatalog.from_json(
        _catalog_for_express(source, default_catalog_id=default_catalog_id)
    )
    if express_version(catalog.protocol_version) != ExpressVersion.V0_9:
        raise ValueError("ADK Express currently requires an A2UI v0.9 catalog")
    return ExpressProcessor(
        catalogs=[catalog],
        format_factory=ExpressFormatFactory(surface_id=surface_id, version="v0.9"),
    )


def compile_a2ui_express(
    source: str,
    *,
    catalog: Any = None,
    surface_id: str = "default",
    default_catalog_id: str = "https://a2ui.org/specification/v0_9/basic_catalog.json",
) -> list[dict[str, Any]]:
    """Compile a fixed Express template into validated standard A2UI messages.

    ``source`` is raw Express, without sentinel tags. Compilation, schema and
    reference validation are all supplied by the official A2UI SDK. This helper
    makes the same compiler available to backend-owned fixed-layout tools.
    """
    from ._vendor.a2ui.core import A2uiError
    from ._vendor.a2ui.parser import A2uiPart
    from ._vendor.a2ui.parser.messages import to_message_dicts

    processor = create_express_processor(
        catalog, default_catalog_id=default_catalog_id, surface_id=surface_id
    )
    try:
        return [
            message
            for part in processor.parse_response(source, wrapped=False)
            if isinstance(part, A2uiPart)
            for message in to_message_dicts(part.a2ui)
        ]
    except A2uiError as error:
        raise ValueError(str(error)) from error
