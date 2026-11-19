using System.Collections.Generic;
using System.Threading;
using AGUI.Abstractions;

namespace AGUI.Server;

/// <summary>
/// Runs an AG-UI agent for one <see cref="RunAgentInput"/> and returns the resulting event stream.
/// </summary>
/// <remarks>
/// This is the shape every stage of an <see cref="AGUIMiddlewarePipeline"/> shares: the terminal
/// stage adapts the input, calls the model and converts its output (typically
/// <see cref="ChatClientAGUIExtensions.AsAGUIRunDelegate"/>), and each
/// <see cref="AGUIMiddleware"/> wraps the stage after it. It mirrors the <c>run(input)</c> method
/// the TypeScript SDK's middleware chains over.
/// </remarks>
/// <param name="input">The run input.</param>
/// <param name="cancellationToken">The cancellation token.</param>
/// <returns>The run's AG-UI events.</returns>
public delegate IAsyncEnumerable<BaseEvent> AGUIRunDelegate(RunAgentInput input, CancellationToken cancellationToken);
