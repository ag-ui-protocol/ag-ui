using System.Diagnostics.CodeAnalysis;
using AGUI.Abstractions;
using AGUI.Server;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

namespace AGUIDojoServer.GenerativeUI;

/// <summary>
/// Reads the client's context from <see cref="RunAgentInput.Context"/> and prepends it to the
/// conversation. CopilotKit sends its generative UI guide and component schema as context, so the
/// model can answer with <c>```a2ui</c> fences or call the <c>render_ui</c> frontend tool.
/// </summary>
[SuppressMessage("Performance", "CA1812:Avoid uninstantiated internal classes", Justification = "Instantiated by ChatClientAgentFactory.CreateGenerativeUI")]
internal sealed class GenerativeUIAgent(AIAgent innerAgent) : DelegatingAIAgent(innerAgent)
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
            agentInput.Context is { Count: > 0 } context)
        {
            var entries = context
                .Where(item => !string.IsNullOrEmpty(item.Value))
                .Select(item => $"{item.Description}:\n{item.Value}");
            ChatMessage contextMessage = new(
                ChatRole.System,
                "## Context from the application\n\n" + string.Join("\n\n", entries));
            messages = [contextMessage, .. messages];
        }

        return this.InnerAgent.RunStreamingAsync(messages, session, options, cancellationToken);
    }
}
