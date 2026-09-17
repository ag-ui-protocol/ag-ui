using System;
using System.Diagnostics;
using System.Text.Json;

namespace AGUI.Abstractions;

/// <summary>
/// The pass over a wire document that only the document can answer: which
/// required arbitrary-JSON payloads are missing, and which optional fields
/// arrived as an explicit <c>null</c>.
/// </summary>
/// <remarks>
/// <para>
/// Both questions die at deserialization. A required <c>CUSTOM.value</c> is a
/// bare <see cref="JsonElement"/> whose default kind is <c>Undefined</c>, and an
/// optional field that arrived as <c>null</c> is indistinguishable from one that
/// never arrived once it is a C# <see langword="null"/> — which is exactly the
/// tolerance the SDK grants, so the warning has to be raised while the JSON is
/// still in hand.
/// </para>
/// <para>
/// The shapes come from <see cref="AGUIWireShapes"/>, generated from the schema,
/// so a field the protocol gains is covered without anybody listing it here.
/// The walk stops wherever a nested value has a converter of its own — messages,
/// content parts, part sources, both outcome unions — because that converter
/// calls this guard for itself; descending would warn twice.
/// </para>
/// </remarks>
internal static class AGUIWireGuard
{
    /// <summary>The union entry points the converters name when they call in.</summary>
    internal const string EventShape = "Event";
    internal const string MessageShape = "Message";
    internal const string ContentPartShape = "ContentPart";
    internal const string PartSourceShape = "PartSource";
    internal const string RunFinishedOutcomeShape = "RunFinishedOutcome";
    internal const string SubagentFinishedOutcomeShape = "SubagentFinishedOutcome";

    /// <summary>
    /// Judges <paramref name="json"/> as a document of <paramref name="shape"/>:
    /// throws when a required arbitrary-JSON payload is absent, and warns for
    /// every optional field carrying an explicit <c>null</c>.
    /// </summary>
    internal static void Inspect(JsonElement json, string shape)
    {
        if (json.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        // A union document names its own member; anything else is already the
        // shape it claims to be.
        var member = AGUIWireShapes.Member(shape, json);
        if (member is not null)
        {
            shape = member;
        }

        AGUIWireShapes.RequirePayloads(shape, json);

        foreach (var property in json.EnumerateObject())
        {
            if (property.Value.ValueKind == JsonValueKind.Null)
            {
                if (AGUIWireShapes.IsOptional(shape, property.Name))
                {
                    WarnLegacyNull(shape, property.Name);
                }

                continue;
            }

            var child = AGUIWireShapes.Child(shape, property.Name);
            if (child is null)
            {
                continue;
            }

            if (property.Value.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in property.Value.EnumerateArray())
                {
                    Inspect(item, child);
                }
            }
            else
            {
                Inspect(property.Value, child);
            }
        }
    }

    /// <summary>
    /// The pre-1.0 shape this SDK still accepts: a whole optional field written
    /// as <c>null</c> instead of left out.
    /// </summary>
    /// <remarks>
    /// Accepting it silently is what made the deviation invisible. TypeScript's
    /// <c>CompatibilityBoundary</c> converts it and says so once per occurrence;
    /// this is the same conversion (the models read the null as absent) with the
    /// same announcement, under the same rows of the repo-root DEPRECATIONS.md
    /// and the same <c>SUPPRESS_TRANSFORMATION_WARNINGS</c> opt-out. A null
    /// UNDER an open key — a metadata value, a JSON Patch <c>add</c> of null,
    /// <c>CUSTOM.value</c> — is data, never a deviation, and never reaches here:
    /// the walk only ever looks at the declared optional fields of a known shape.
    /// </remarks>
    private static void WarnLegacyNull(string shape, string field)
    {
        if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("SUPPRESS_TRANSFORMATION_WARNINGS")))
        {
            return;
        }

        Trace.TraceWarning(
            "[ag-ui][compat] Converting deprecated {0}.{1}: null to an absent field. " +
            "The old shape leaves the protocol after its shim window — see the repo-root DEPRECATIONS.md. " +
            "Set SUPPRESS_TRANSFORMATION_WARNINGS=true to silence.",
            shape,
            field);
    }
}
