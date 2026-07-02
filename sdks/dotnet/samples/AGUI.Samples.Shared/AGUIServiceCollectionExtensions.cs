using System;
using System.Text.Json;
using AGUI.Abstractions;
using AGUI.Formatting;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Microsoft.Extensions.DependencyInjection;

/// <summary>
/// Extension methods for <see cref="IServiceCollection"/> to configure AG-UI ASP.NET Core hosting.
/// </summary>
public static class AGUIServiceCollectionExtensions
{
    /// <summary>
    /// Adds AG-UI services to the specified <see cref="IServiceCollection"/>: the built-in
    /// Server-Sent Events formatter and the AG-UI JSON serialization configuration.
    /// </summary>
    /// <param name="services">The <see cref="IServiceCollection"/> to configure.</param>
    /// <returns>The <see cref="IServiceCollection"/> for method chaining.</returns>
    public static IServiceCollection AddAGUI(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        services.TryAddEnumerable(
            ServiceDescriptor.Singleton<IAGUIEventStreamFormatter, SseEventStreamFormatter>());

        services.Configure<JsonOptions>(options =>
        {
            options.SerializerOptions.TypeInfoResolverChain.Add(AIJsonUtilities.DefaultOptions.TypeInfoResolver!);
            options.SerializerOptions.TypeInfoResolverChain.Add(AGUIJsonSerializerContext.Default);
            AGUIJsonUtilities.RegisterInterruptContentTypes(options.SerializerOptions);
        });

        return services;
    }
}
