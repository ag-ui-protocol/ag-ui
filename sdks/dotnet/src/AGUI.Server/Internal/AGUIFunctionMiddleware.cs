using System;
using System.Collections.Generic;
using System.Threading;
using AGUI.Abstractions;

namespace AGUI.Server;

internal sealed class AGUIFunctionMiddleware : AGUIMiddleware
{
    private readonly Func<RunAgentInput, AGUIRunDelegate, CancellationToken, IAsyncEnumerable<BaseEvent>> _run;

    public AGUIFunctionMiddleware(Func<RunAgentInput, AGUIRunDelegate, CancellationToken, IAsyncEnumerable<BaseEvent>> run)
    {
        _run = run;
    }

    public override IAsyncEnumerable<BaseEvent> RunAsync(
        RunAgentInput input,
        AGUIRunDelegate next,
        CancellationToken cancellationToken) => _run(input, next, cancellationToken);
}
