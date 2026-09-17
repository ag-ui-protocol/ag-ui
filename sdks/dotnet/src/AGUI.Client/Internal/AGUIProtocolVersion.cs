using System;
using System.Diagnostics;
using System.Globalization;

namespace AGUI.Client;

/// <summary>
/// How a producer's <c>RUN_STARTED.protocolVersion</c> compares with the version this
/// client speaks.
/// </summary>
internal enum ProtocolDeclarationVerdict
{
    /// <summary>The producer sent no declaration: a peer from before the field existed.</summary>
    Absent,

    /// <summary>The producer declared a version this client is at least as new as.</summary>
    NotNewer,

    /// <summary>The producer declared a newer line than this client speaks.</summary>
    Newer,

    /// <summary>The declaration is not a <c>MAJOR.MINOR</c> identifier and cannot be compared.</summary>
    Uninterpretable,
}

/// <summary>
/// The in-band protocol version this client declares and the judgment it passes on the
/// one a producer declares back. Mirrors the TypeScript client's
/// <c>WIRE_PROTOCOL_VERSION</c> / <c>compareDeclaredProtocol</c> pair
/// (<c>sdks/typescript/packages/client/src/agent/agent.ts</c>), so the same exchange is
/// read the same way by both SDKs.
/// </summary>
internal static class AGUIProtocolVersion
{
    /// <summary>
    /// The protocol LINE this client speaks, which is what goes on the wire.
    /// </summary>
    /// <remarks>
    /// Deliberately not the generated <c>PROTOCOL_VERSION</c> constant, which names the
    /// spec revision the models were generated from and currently reads "draft": the wire
    /// value names what the client speaks, and it has to be comparable — "draft" never
    /// could be. At the 1.0 freeze the two collapse into the same string.
    /// </remarks>
    internal const string Wire = "1.0";

    /// <summary>
    /// Whether this client declares its version to a peer whose ceiling is
    /// <paramref name="peerCeiling"/>. A peer pinned below this line predates the field,
    /// and an unrecognised input member is exactly what a strict old parser could reject —
    /// the same gate the TypeScript client applies in <c>prepareRunAgentInput</c>.
    /// </summary>
    /// <remarks>
    /// An absent or unreadable ceiling means "a current peer": silence about the peer is
    /// not evidence that it is old, and refusing to declare on a value this client cannot
    /// read would make the common case — no ceiling configured at all — the downgraded one.
    /// </remarks>
    internal static bool ShouldDeclare(string? peerCeiling)
    {
        if (string.IsNullOrEmpty(peerCeiling) || !TryReadComponents(peerCeiling!, out var ceiling))
        {
            return true;
        }

        TryReadComponents(Wire, out var wire);
        return CompareComponents(ceiling, wire) >= 0;
    }

    /// <summary>
    /// Judges a producer's declaration against <see cref="Wire"/>.
    /// </summary>
    /// <remarks>
    /// The grammar is checked BEFORE any comparison, exactly as TypeScript does it: a
    /// component-wise compare would happily read "1", "1.0.0" or "1.x" as equal to "1.0",
    /// and the specification says a value outside the published grammar is handled like a
    /// newer one rather than silently accepted.
    /// </remarks>
    internal static ProtocolDeclarationVerdict Judge(string? declared)
    {
        if (declared is null)
        {
            return ProtocolDeclarationVerdict.Absent;
        }

        if (string.Equals(declared, Wire, StringComparison.Ordinal))
        {
            return ProtocolDeclarationVerdict.NotNewer;
        }

        if (!IsMajorMinor(declared))
        {
            return ProtocolDeclarationVerdict.Uninterpretable;
        }

        TryReadComponents(declared, out var peer);
        TryReadComponents(Wire, out var wire);
        return CompareComponents(peer, wire) > 0
            ? ProtocolDeclarationVerdict.Newer
            : ProtocolDeclarationVerdict.NotNewer;
    }

    /// <summary>
    /// Warns about a producer declaration this client cannot fully honour. Older or absent
    /// is the downgrade the versioning rules expect a consumer to notice quietly; NEWER
    /// means material this client may be dropping, and that deserves a voice.
    /// </summary>
    internal static void WarnOnProducerDeclaration(string? declared)
    {
        switch (Judge(declared))
        {
            case ProtocolDeclarationVerdict.Uninterpretable:
                Trace.TraceWarning(
                    "[ag-ui] The producer declared protocol version '{0}', which this client cannot interpret.",
                    declared);
                break;
            case ProtocolDeclarationVerdict.Newer:
                Trace.TraceWarning(
                    "[ag-ui] The producer speaks protocol {0}; this client speaks {1}. Unrecognised material will be stripped with warnings.",
                    declared,
                    Wire);
                break;
            default:
                break;
        }
    }

    /// <summary>The published grammar for a protocol version: exactly two numeric components.</summary>
    private static bool IsMajorMinor(string value)
    {
        var dot = value.IndexOf('.');
        if (dot <= 0 || dot == value.Length - 1)
        {
            return false;
        }

        return IsDigits(value, 0, dot) && IsDigits(value, dot + 1, value.Length);
    }

    private static bool IsDigits(string value, int start, int end)
    {
        for (var index = start; index < end; index++)
        {
            if (value[index] < '0' || value[index] > '9')
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Reads a dotted numeric version into its components. Lenient on purpose: this is
    /// also used for a peer CEILING, which is a library version ("0.0.57") rather than a
    /// protocol line, so it must accept more than the two-component protocol grammar.
    /// </summary>
    private static bool TryReadComponents(string value, out int[] components)
    {
        var parts = value.Split('.');
        var read = new int[parts.Length];
        for (var index = 0; index < parts.Length; index++)
        {
            if (!int.TryParse(parts[index], NumberStyles.None, CultureInfo.InvariantCulture, out read[index]))
            {
                components = [];
                return false;
            }
        }

        components = read;
        return true;
    }

    /// <summary>Component-wise numeric compare; a missing component reads as zero.</summary>
    private static int CompareComponents(int[] left, int[] right)
    {
        var length = Math.Max(left.Length, right.Length);
        for (var index = 0; index < length; index++)
        {
            var l = index < left.Length ? left[index] : 0;
            var r = index < right.Length ? right[index] : 0;
            if (l != r)
            {
                return l < r ? -1 : 1;
            }
        }

        return 0;
    }
}
