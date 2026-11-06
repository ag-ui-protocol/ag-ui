using System.Text.Json;
using Microsoft.Extensions.AI;

namespace AGUI.Server;

/// <summary>
/// Extension methods for running an <see cref="IChatClient"/> as an AG-UI agent.
/// </summary>
public static class ChatClientAGUIExtensions
{
    /// <summary>
    /// Wraps <paramref name="chatClient"/> as an <see cref="AGUIRunDelegate"/> that adapts the run
    /// input with <see cref="RunAgentInputExtensions.ToChatRequestContext"/>, streams the chat
    /// client's response, and converts it with
    /// <see cref="ChatResponseUpdateAGUIExtensions.AsAGUIEventStreamAsync"/>.
    /// </summary>
    /// <remarks>
    /// Call the delegate directly, or pass it to <see cref="AGUIMiddlewarePipeline.Build"/> as the
    /// terminal stage. Each call adapts the input it receives, so a middleware that rewrites the
    /// input changes what the model sees. To change the request in other ways, such as adding
    /// server tools for one endpoint, write the terminal stage yourself.
    /// <code>
    /// var run = new AGUIMiddlewarePipeline()
    ///     .Use(new AuditMiddleware())
    ///     .Build(chatClient.AsAGUIRunDelegate(jsonSerializerOptions));
    ///
    /// var events = run(input, cancellationToken);
    /// </code>
    /// </remarks>
    /// <param name="chatClient">The chat client that runs the agent.</param>
    /// <param name="jsonSerializerOptions">The JSON serializer options passed to <see cref="RunAgentInputExtensions.ToChatRequestContext"/>.</param>
    /// <param name="streamOptions">Optional stream-converter configuration passed to <see cref="RunAgentInputExtensions.ToChatRequestContext"/>.</param>
    /// <returns>A delegate that runs one AG-UI run against <paramref name="chatClient"/>.</returns>
    public static AGUIRunDelegate AsAGUIRunDelegate(
        this IChatClient chatClient,
        JsonSerializerOptions jsonSerializerOptions,
        AGUIStreamOptions? streamOptions = null)
    {
        ArgumentNullException.ThrowIfNull(chatClient);
        ArgumentNullException.ThrowIfNull(jsonSerializerOptions);

        return (input, cancellationToken) =>
        {
            var ctx = input.ToChatRequestContext(jsonSerializerOptions, streamOptions);
            return chatClient.GetStreamingResponseAsync(ctx.Messages, ctx.ChatOptions, cancellationToken)
                .AsAGUIEventStreamAsync(ctx, cancellationToken);
        };
    }
}
