using System;
using System.Text.Json;
using Microsoft.Extensions.AI;

namespace AGUI.Abstractions;

/// <summary>
/// Helpers for configuring System.Text.Json to (de)serialize AG-UI interrupt content types.
/// </summary>
public static class AGUIJsonUtilities
{
    /// <summary>
    /// Registers the AG-UI interrupt content types (<see cref="InterruptRequestContent"/> and
    /// <see cref="InterruptResponseContent"/>) with the specified <see cref="JsonSerializerOptions"/>
    /// so they round-trip as polymorphic <see cref="AIContent"/>.
    /// </summary>
    /// <param name="options">The JSON serializer options to configure.</param>
    public static void RegisterInterruptContentTypes(JsonSerializerOptions options)
    {
#if NET7_0_OR_GREATER
        ArgumentNullException.ThrowIfNull(options);
#else
        if (options is null)
        {
            throw new ArgumentNullException(nameof(options));
        }
#endif

        options.AddAIContentType<InterruptRequestContent>("interruptRequest");
        options.AddAIContentType<InterruptResponseContent>("interruptResponse");
    }
}
