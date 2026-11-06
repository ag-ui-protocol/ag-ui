using System.Collections.Generic;
using System.Threading;
using AGUI.Abstractions;

namespace AGUI.Server;

/// <summary>
/// A stage that sits between an AG-UI agent and the wire. It receives the run input and the next
/// stage, and returns the event stream that continues toward the client.
/// </summary>
/// <remarks>
/// <para>
/// This mirrors the TypeScript SDK's <c>Middleware</c>. A middleware can change the input before
/// calling <c>next</c>, and it can drop, change or add events on the way out. It operates on AG-UI
/// events after the Microsoft.Extensions.AI stream has been converted, so the model, function
/// invocation and anything persisting the chat history still see the complete, unfiltered stream.
/// To act on <see cref="Microsoft.Extensions.AI.ChatResponseUpdate"/>s instead, write a
/// <see cref="Microsoft.Extensions.AI.DelegatingChatClient"/>.
/// </para>
/// <para>
/// One instance serves every run, so keep per-run state in locals of <see cref="RunAsync"/> (an
/// async iterator gets fresh locals for each enumeration), never in fields.
/// </para>
/// </remarks>
public abstract class AGUIMiddleware
{
    /// <summary>
    /// Runs this stage for one run.
    /// </summary>
    /// <param name="input">The run input.</param>
    /// <param name="next">The next stage. Call it to run the rest of the pipeline.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The events to send onward.</returns>
    public abstract IAsyncEnumerable<BaseEvent> RunAsync(
        RunAgentInput input,
        AGUIRunDelegate next,
        CancellationToken cancellationToken);
}
