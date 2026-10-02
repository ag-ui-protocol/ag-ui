using System.Diagnostics.CodeAnalysis;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

namespace AGUIDojoServer.AgenticUI;

[SuppressMessage("Performance", "CA1812:Avoid uninstantiated internal classes", Justification = "Instantiated by ChatClientAgentFactory.CreateAgenticUI")]
internal sealed class AgenticUIAgent : DelegatingAIAgent
{
    private readonly JsonSerializerOptions _jsonSerializerOptions;

    public AgenticUIAgent(AIAgent innerAgent, JsonSerializerOptions jsonSerializerOptions)
        : base(innerAgent)
    {
        this._jsonSerializerOptions = jsonSerializerOptions;
    }

    protected override Task<AgentResponse> RunCoreAsync(IEnumerable<ChatMessage> messages, AgentSession? session = null, AgentRunOptions? options = null, CancellationToken cancellationToken = default)
    {
        return this.RunCoreStreamingAsync(messages, session, options, cancellationToken).ToAgentResponseAsync(cancellationToken);
    }

    protected override async IAsyncEnumerable<AgentResponseUpdate> RunCoreStreamingAsync(
        IEnumerable<ChatMessage> messages,
        AgentSession? session = null,
        AgentRunOptions? options = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        // Track function calls that should trigger state events
        var trackedFunctionCalls = new Dictionary<string, FunctionCallContent>();

        await foreach (var update in this.InnerAgent.RunStreamingAsync(messages, session, options, cancellationToken).ConfigureAwait(false))
        {
            // Process contents: track function calls and emit state events for results
            List<AIContent> stateEventsToEmit = new();
            foreach (var content in update.Contents)
            {
                if (content is FunctionCallContent callContent)
                {
                    if (callContent.Name == "create_plan" || callContent.Name == "update_plan_step")
                    {
                        trackedFunctionCalls[callContent.CallId] = callContent;
                        break;
                    }
                }
                else if (content is FunctionResultContent resultContent)
                {
                    // Check if this result matches a tracked function call
                    if (trackedFunctionCalls.TryGetValue(resultContent.CallId, out var matchedCall))
                    {
                        var bytes = JsonSerializer.SerializeToUtf8Bytes((JsonElement)resultContent.Result!, this._jsonSerializerOptions);

                        // Determine event type based on the function name
                        if (matchedCall.Name == "create_plan")
                        {
                            stateEventsToEmit.Add(new DataContent(bytes, "application/json"));
                        }
                        else if (matchedCall.Name == "update_plan_step")
                        {
                            stateEventsToEmit.Add(new DataContent(bytes, "application/json-patch+json"));
                        }
                    }
                }
            }

            yield return update;

            yield return new AgentResponseUpdate(
                new ChatResponseUpdate(role: ChatRole.System, stateEventsToEmit)
                {
                    MessageId = "delta_" + Guid.NewGuid().ToString("N"),
                    CreatedAt = update.CreatedAt,
                    ResponseId = update.ResponseId,
                    AuthorName = update.AuthorName,
                    Role = update.Role,
                    ContinuationToken = update.ContinuationToken,
                    AdditionalProperties = update.AdditionalProperties,
                })
            {
                AgentId = update.AgentId
            };
        }
    }
}
