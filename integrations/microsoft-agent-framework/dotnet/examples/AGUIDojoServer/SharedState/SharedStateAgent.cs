using System.Diagnostics.CodeAnalysis;
using System.Text.Json;
using AGUI.Abstractions;
using AGUI.Server;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

namespace AGUIDojoServer.SharedState;

/// <summary>
/// Reads the client's current recipe from <see cref="RunAgentInput.State"/> and prepends it to the
/// conversation, so the model edits the existing recipe instead of starting over. This is the input
/// side of shared state only. The output side is declarative: the endpoint maps the
/// <c>generate_recipe</c> tool result to a <c>STATE_SNAPSHOT</c> with
/// <c>AGUIStreamOptions.MapResultAsStateSnapshot</c> (see Program.cs).
/// </summary>
[SuppressMessage("Performance", "CA1812:Avoid uninstantiated internal classes", Justification = "Instantiated by ChatClientAgentFactory.CreateSharedState")]
internal sealed class SharedStateAgent(AIAgent innerAgent) : DelegatingAIAgent(innerAgent)
{
    protected override Task<AgentResponse> RunCoreAsync(IEnumerable<ChatMessage> messages, AgentSession? session = null, AgentRunOptions? options = null, CancellationToken cancellationToken = default)
    {
        return this.RunCoreStreamingAsync(messages, session, options, cancellationToken).ToAgentResponseAsync(cancellationToken);
    }

    protected override IAsyncEnumerable<AgentResponseUpdate> RunCoreStreamingAsync(
        IEnumerable<ChatMessage> messages,
        AgentSession? session = null,
        AgentRunOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        if (options is ChatClientAgentRunOptions { ChatOptions: { } chatOptions } &&
            chatOptions.TryGetRunAgentInput(out RunAgentInput? agentInput) &&
            agentInput.State is { ValueKind: JsonValueKind.Object } state)
        {
            ChatMessage stateMessage = new(
                ChatRole.System,
                $"The user's current recipe state is:\n{state.GetRawText()}");
            messages = [stateMessage, .. messages];
        }

        return this.InnerAgent.RunStreamingAsync(messages, session, options, cancellationToken);
    }
}
