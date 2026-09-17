using System.Collections.Generic;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace AGUI.Abstractions;

/// <summary>
/// The primitives the generated models call from their property setters, one
/// per JSON Schema keyword the contract uses.
/// </summary>
/// <remarks>
/// <para>
/// A constraint the SDK does not check is a rule it does not have: before this,
/// a <c>TokenUsage</c> count with <c>minimum: 0</c> happily held <c>-5</c>, an
/// interrupt outcome with <c>minItems: 1</c> accepted an empty list, and
/// <c>STATE_DELTA.delta</c> — a bare <see cref="JsonElement"/> in this SDK —
/// accepted <c>42</c>. TypeScript and Python reject all three, so a stream that
/// crossed .NET arrived somewhere else as a validation failure instead of being
/// stopped where it was read.
/// </para>
/// <para>
/// The checks hang off the SETTER rather than off a converter so they hold on
/// every path a value can arrive by — JSON, the protobuf decoders, and a caller
/// assigning the property — rather than only the path the converters see;
/// <c>AgentCapabilities</c>, for one, is deserialized with no converter of its
/// own. They throw <see cref="JsonException"/> because that is what the rest of
/// this SDK throws for a value the wire contract rejects, and because these
/// properties exist to carry wire values: a caller assigning one out of range
/// has built a message that cannot be sent.
/// </para>
/// <para>
/// Absence is NOT their business. A <see langword="null"/> optional and an
/// undefined <see cref="JsonElement"/> pass through untouched; presence is
/// judged on the document by <see cref="AGUIWireGuard"/>, which is the only
/// place that can still tell an absent field from an explicit null.
/// </para>
/// </remarks>
internal static class AGUIWireValidation
{
    /// <summary>The one exception shape every check here raises.</summary>
    internal static JsonException Malformed(string owner, string field, string what) =>
        new($"Invalid {owner}: '{field}' {what}.");

    /// <summary>Rejects an integer outside the schema's <c>minimum</c>/<c>maximum</c>.</summary>
    internal static void Range(string owner, string field, long? value, long minimum, long maximum)
    {
        if (value is { } number && (number < minimum || number > maximum))
        {
            throw Malformed(owner, field, $"is {number}, outside the permitted range {minimum}..{maximum}");
        }
    }

    /// <summary>Rejects a list shorter than the schema's <c>minItems</c>.</summary>
    internal static void MinItems<T>(string owner, string field, IList<T>? value, int minimum)
    {
        if (value is { } list && list.Count < minimum)
        {
            throw Malformed(
                owner,
                field,
                $"carries {list.Count} item(s), fewer than the {minimum} the schema requires");
        }
    }

    /// <summary>Rejects a string the schema's <c>pattern</c> does not match.</summary>
    internal static void Pattern(string owner, string field, string? value, string pattern)
    {
        if (value is { } text && !Regex.IsMatch(text, pattern))
        {
            throw Malformed(owner, field, $"is \"{text}\", which does not match {pattern}");
        }
    }

    /// <summary>
    /// Rejects a <c>delta</c>/<c>patch</c> that is not an RFC 6902 document.
    /// </summary>
    /// <remarks>
    /// The patch rides as opaque JSON in this SDK, so nothing downstream would
    /// ever look at its structure. An undefined element is absence, which
    /// <see cref="AGUIWireGuard"/> judges, not malformation.
    /// </remarks>
    internal static void JsonPatch(string owner, string field, JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Undefined)
        {
            return;
        }

        if (value.ValueKind != JsonValueKind.Array)
        {
            throw Malformed(owner, field, $"is a JSON {value.ValueKind}, not an RFC 6902 patch array");
        }

        foreach (var operation in value.EnumerateArray())
        {
            if (operation.ValueKind != JsonValueKind.Object)
            {
                throw Malformed(
                    owner, field, $"carries a JSON {operation.ValueKind} where an RFC 6902 operation belongs");
            }

            AGUIWireShapes.ValidatePatchOperation(owner, field, operation);
        }
    }

    /// <summary>The <c>op</c> of one patch operation, which must be a string.</summary>
    internal static string RequireOp(string owner, string field, JsonElement operation)
    {
        if (!operation.TryGetProperty("op", out var op) || op.ValueKind != JsonValueKind.String)
        {
            throw Malformed(owner, field, "carries an operation with no string 'op'");
        }

        return op.GetString()!;
    }

    /// <summary>A member the operation's <c>op</c> requires to be a JSON Pointer.</summary>
    internal static void RequirePointer(string owner, string field, JsonElement operation, string member)
    {
        if (!operation.TryGetProperty(member, out var value) || value.ValueKind != JsonValueKind.String)
        {
            throw Malformed(owner, field, $"carries an operation with no string '{member}'");
        }

        if (!Regex.IsMatch(value.GetString()!, AGUIWireShapes.JsonPointerPattern))
        {
            throw Malformed(
                owner, field, $"carries an operation whose '{member}' is not an RFC 6901 pointer");
        }
    }

    /// <summary>A member the operation's <c>op</c> requires, of any JSON kind.</summary>
    internal static void RequireMember(string owner, string field, JsonElement operation, string member)
    {
        if (!operation.TryGetProperty(member, out _))
        {
            throw Malformed(owner, field, $"carries an operation with no '{member}'");
        }
    }
}
