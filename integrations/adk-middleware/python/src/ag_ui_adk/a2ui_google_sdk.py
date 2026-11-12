"""Official A2UI SDK reuse for ADK inference.

The default Direct JSON path reuses released prompt rendering and JSON healing,
with the existing lenient toolkit validation for client catalogs. Express uses
the released Agent SDK's official prompt, compiler, progressive stream and
strict renderer validation (incremental Express streaming ships in
``a2ui-agent-sdk`` 0.10.0).

Imports remain framework-independent: no ``a2ui.a2a``, ``a2ui.adk`` or ``a2a``.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional, cast

from a2ui.core import A2uiError, Catalog
from a2ui.core.basic_catalog import BasicCatalog
from a2ui.core.common import to_protocol_version
from a2ui.core.schema import ProtocolVersion
from a2ui.inference_formats.direct_json import (
    DirectJsonFormatFactory,
    DirectJsonPromptGenerator,
)
from a2ui.inference_formats.direct_json.json_reader import read_json
from a2ui.inference_formats.direct_json.schema_prompt import protocol_schema_prompt
from a2ui.inference_formats.express import ExpressFormatFactory
from a2ui.parser import A2uiPart
from a2ui.parser.messages import to_message_dicts
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
    ProtocolVersion.V1_0: (
        "CreateSurfaceMessage",
        "UpdateComponentsMessage",
        "UpdateDataModelMessage",
    ),
}

_DEFAULT_JSON_SCHEMA = "https://json-schema.org/draft/2020-12/schema"


def catalog_protocol_version(source: Any) -> ProtocolVersion:
    """Resolve the declaration before best-effort catalog/prompt normalization.

    Only an absent declaration defaults to 0.9. The SDK itself treats some
    malformed declarations (including null) as absent, so validate their type
    here rather than silently emitting a different protocol.
    """
    if isinstance(source, str):
        try:
            source = json.loads(source)
        except ValueError:
            return ProtocolVersion.V0_9
    if not isinstance(source, dict) or "protocolVersion" not in source:
        return ProtocolVersion.V0_9
    version = source["protocolVersion"]
    if not isinstance(version, str) or not version:
        raise ValueError("Catalog protocolVersion must be a non-empty string")
    return to_protocol_version(version)


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
    # Version errors are configuration errors, never a raw-prompt fallback.
    version = catalog_protocol_version(source)
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
        processor = A2uiRequestProcessor(
            catalogs=[catalog],
            format_factory=DirectJsonFormatFactory(
                allowed_messages=_PROMPT_ALLOWED_MESSAGES[version]
            ),
        )
        # prompt_snippet and generate_base_rules also add workflow/tag-delivery
        # rules, which conflict with our forced render_a2ui tool. Since SDK 0.10
        # the catalog instructions hold only the catalog schema, so prepend the
        # protocol schemas (envelope + common types) as one schema block.
        generator = cast(DirectJsonPromptGenerator, processor.format.prompt_generator)
        instructions = _join_schema_blocks(
            protocol_schema_prompt(
                generator.catalogs, allowed_messages=generator.allowed_messages
            ),
            generator.generate_catalog_instructions(),
        )
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


_SCHEMA_BEGIN = "---BEGIN A2UI JSON SCHEMA---\n\n"
_SCHEMA_END = "\n\n---END A2UI JSON SCHEMA---"


def _join_schema_blocks(first: str, second: str) -> str:
    """Merge two delimited SDK schema blocks into one, keeping their order."""
    if first.endswith(_SCHEMA_END) and second.startswith(_SCHEMA_BEGIN):
        return first[: -len(_SCHEMA_END)] + "\n\n" + second[len(_SCHEMA_BEGIN) :]
    return f"{first}\n\n{second}"


def heal_json_arg(value: str, *, expect: str) -> Any:
    """Heal + parse Gemini's free-form JSON-string ``components``/``data`` arg via
    the SDK's ``read_json`` (curly quotes, trailing commas, raw line breaks in
    strings).

    ``expect="list"`` returns the healed list, wrapping a single object;
    ``expect="dict"`` returns the object, unwrapping a single-element list.
    Raises ``ValueError`` on a hard parse failure or when ``expect="dict"`` but
    the payload isn't a single JSON object.
    """
    parsed = read_json(value)
    if expect == "list":
        return [parsed] if isinstance(parsed, dict) else parsed
    if isinstance(parsed, list) and len(parsed) == 1 and isinstance(parsed[0], dict):
        return parsed[0]
    if isinstance(parsed, dict):
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
    """Create a streaming processor targeting the supplied catalog's protocol."""
    version = catalog_protocol_version(source)
    if version not in (ProtocolVersion.V0_9, ProtocolVersion.V1_0):
        raise ValueError("ADK Express requires an A2UI 0.9 or 1.0 catalog")
    catalog = Catalog.from_json(
        _catalog_for_express(source, default_catalog_id=default_catalog_id)
    )
    return A2uiRequestProcessor(
        catalogs=[catalog],
        format_factory=ExpressFormatFactory(
            surface_id=surface_id, version=version.value
        ),
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
