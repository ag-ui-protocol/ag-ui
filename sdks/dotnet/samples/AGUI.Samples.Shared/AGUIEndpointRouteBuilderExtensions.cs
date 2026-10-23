using AGUI.Abstractions;
using AGUI.Server;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Options;

using JsonOptions = Microsoft.AspNetCore.Http.Json.JsonOptions;

namespace AGUI.Samples.Shared;

/// <summary>
/// Endpoint routing extensions that map the canonical AG-UI endpoint shared by the
/// GettingStarted samples.
/// </summary>
public static class AGUIEndpointRouteBuilderExtensions
{
    /// <summary>
    /// Maps an AG-UI <c>POST</c> endpoint at <paramref name="pattern"/> that adapts the incoming
    /// <see cref="RunAgentInput"/> to Microsoft.Extensions.AI, streams the response from the
    /// registered <see cref="IChatClient"/>, and negotiates the wire transport (SSE or protobuf)
    /// via <see cref="AGUIResults.Events"/>.
    /// </summary>
    /// <param name="endpoints">The endpoint route builder.</param>
    /// <param name="pattern">The route pattern to map.</param>
    /// <returns>An <see cref="IEndpointConventionBuilder"/> for further endpoint configuration.</returns>
    public static IEndpointConventionBuilder MapAGUI(
        this IEndpointRouteBuilder endpoints,
        string pattern) =>
        endpoints.MapAGUI(pattern, static _ => { });

    /// <summary>
    /// Maps an AG-UI <c>POST</c> endpoint at <paramref name="pattern"/> whose runs pass through the
    /// <see cref="AGUIMiddleware"/> registered by <paramref name="configureMiddleware"/> before the
    /// events reach the wire. The first middleware registered is the outermost.
    /// </summary>
    /// <example>
    /// <code>
    /// app.MapAGUI("/", middleware => middleware
    ///     .Use(new AuditMiddleware()));
    /// </code>
    /// </example>
    /// <param name="endpoints">The endpoint route builder.</param>
    /// <param name="pattern">The route pattern to map.</param>
    /// <param name="configureMiddleware">Registers the middleware every run on this endpoint goes through.</param>
    /// <returns>An <see cref="IEndpointConventionBuilder"/> for further endpoint configuration.</returns>
    public static IEndpointConventionBuilder MapAGUI(
        this IEndpointRouteBuilder endpoints,
        string pattern,
        Action<AGUIMiddlewarePipeline> configureMiddleware)
    {
        ArgumentNullException.ThrowIfNull(configureMiddleware);

        var pipeline = new AGUIMiddlewarePipeline();
        configureMiddleware(pipeline);

        return endpoints.MapPost(pattern, (
            [FromBody] RunAgentInput input,
            [FromServices] IChatClient chatClient,
            [FromServices] IOptions<JsonOptions> jsonOptions,
            HttpContext httpContext,
            CancellationToken cancellationToken) =>
        {
            var run = pipeline.Build(chatClient.AsAGUIRunDelegate(jsonOptions.Value.SerializerOptions));

            return AGUIResults.Events(run(input, cancellationToken), httpContext, cancellationToken);
        });
    }
}
