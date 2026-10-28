using System;
using System.Collections.Generic;
using System.Threading;
using AGUI.Abstractions;

namespace AGUI.Server;

/// <summary>
/// An ordered list of <see cref="AGUIMiddleware"/> that wraps a terminal <see cref="AGUIRunDelegate"/>.
/// </summary>
/// <remarks>
/// The first middleware registered is the outermost: it sees the input first and the events last,
/// matching <c>agent.use(...)</c> in the TypeScript SDK and ASP.NET Core's request pipeline.
/// <code>
/// var run = new AGUIMiddlewarePipeline()
///     .Use(new AuditMiddleware())
///     .Build(chatClient.AsAGUIRunDelegate(jsonSerializerOptions));
///
/// var events = run(input, cancellationToken);
/// </code>
/// </remarks>
public sealed class AGUIMiddlewarePipeline
{
    private readonly List<AGUIMiddleware> _middlewares = [];

    /// <summary>
    /// Gets the registered middleware, outermost first.
    /// </summary>
    public IReadOnlyList<AGUIMiddleware> Middlewares => _middlewares;

    /// <summary>
    /// Appends a middleware. It runs inside every middleware registered before it.
    /// </summary>
    /// <param name="middleware">The middleware to append.</param>
    /// <returns>This instance for fluent chaining.</returns>
    public AGUIMiddlewarePipeline Use(AGUIMiddleware middleware)
    {
        ArgumentNullThrowHelper.ThrowIfNull(middleware);
        _middlewares.Add(middleware);
        return this;
    }

    /// <summary>
    /// Appends a middleware written as a function of the input, the next stage and the
    /// cancellation token.
    /// </summary>
    /// <param name="middleware">The middleware function to append.</param>
    /// <returns>This instance for fluent chaining.</returns>
    public AGUIMiddlewarePipeline Use(
        Func<RunAgentInput, AGUIRunDelegate, CancellationToken, IAsyncEnumerable<BaseEvent>> middleware)
    {
        ArgumentNullThrowHelper.ThrowIfNull(middleware);
        _middlewares.Add(new AGUIFunctionMiddleware(middleware));
        return this;
    }

    /// <summary>
    /// Composes the registered middleware around <paramref name="terminal"/>.
    /// </summary>
    /// <remarks>
    /// The returned delegate captures the middleware registered at the time of the call; later
    /// <see cref="Use(AGUIMiddleware)"/> calls do not affect it. With no middleware registered,
    /// <paramref name="terminal"/> itself is returned.
    /// </remarks>
    /// <param name="terminal">The innermost stage, which runs the agent.</param>
    /// <returns>A delegate that runs the whole pipeline.</returns>
    public AGUIRunDelegate Build(AGUIRunDelegate terminal)
    {
        ArgumentNullThrowHelper.ThrowIfNull(terminal);

        var next = terminal;
        for (var i = _middlewares.Count - 1; i >= 0; i--)
        {
            var middleware = _middlewares[i];
            var inner = next;
            next = (input, cancellationToken) => middleware.RunAsync(input, inner, cancellationToken);
        }

        return next;
    }
}
