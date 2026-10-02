using System.Diagnostics.CodeAnalysis;
using System.Runtime.CompilerServices;
using System.Text.Json;
using AGUI.Abstractions;
using AGUI.Server;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

namespace AGUIDojoServer.SharedState;

[SuppressMessage("Performance", "CA1812:Avoid uninstantiated internal classes", Justification = "Instantiated by ChatClientAgentFactory.CreateSharedState")]
internal sealed class SharedStateAgent : DelegatingAIAgent
{
    private readonly JsonSerializerOptions _jsonSerializerOptions;

    public SharedStateAgent(AIAgent innerAgent, JsonSerializerOptions jsonSerializerOptions)
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
        if (options is not ChatClientAgentRunOptions { ChatOptions: { } chatOptions } chatRunOptions ||
            !chatOptions.TryGetRunAgentInput(out RunAgentInput? agentInput) ||
            agentInput.State is not { ValueKind: not JsonValueKind.Undefined } state)
        {
            await foreach (var update in this.InnerAgent.RunStreamingAsync(messages, session, options, cancellationToken).ConfigureAwait(false))
            {
                yield return update;
            }
            yield break;
        }

        var firstRunOptions = new ChatClientAgentRunOptions
        {
            ChatOptions = chatRunOptions.ChatOptions.Clone(),
            AllowBackgroundResponses = chatRunOptions.AllowBackgroundResponses,
            ContinuationToken = chatRunOptions.ContinuationToken,
            ChatClientFactory = chatRunOptions.ChatClientFactory,
        };

        // Configure JSON schema response format for structured state output
        firstRunOptions.ChatOptions.ResponseFormat = ChatResponseFormat.ForJsonSchema<RecipeResponse>(
            schemaName: "RecipeResponse",
            schemaDescription: "A response containing a recipe with title, skill level, cooking time, preferences, ingredients, and instructions");

        ChatMessage stateUpdateMessage = new(
            ChatRole.System,
            [
                new TextContent("Here is the current state in JSON format:"),
                    new TextContent(state.GetRawText()),
                    new TextContent("The new state is:")
            ]);

        var firstRunMessages = messages.Append(stateUpdateMessage);

        var allUpdates = new List<AgentResponseUpdate>();
        await foreach (var update in this.InnerAgent.RunStreamingAsync(firstRunMessages, session, firstRunOptions, cancellationToken).ConfigureAwait(false))
        {
            allUpdates.Add(update);

            // Yield all non-text updates (tool calls, etc.)
            bool hasNonTextContent = update.Contents.Any(c => c is not TextContent);
            if (hasNonTextContent)
            {
                yield return update;
            }
        }

        var response = allUpdates.ToAgentResponse();

        if (TryDeserialize(response.Text, this._jsonSerializerOptions, out JsonElement stateSnapshot))
        {
            byte[] stateBytes = JsonSerializer.SerializeToUtf8Bytes(
                stateSnapshot,
                this._jsonSerializerOptions.GetTypeInfo(typeof(JsonElement)));
            yield return new AgentResponseUpdate
            {
                Contents = [new DataContent(stateBytes, "application/json")]
            };
        }
        else
        {
            yield break;
        }

        var secondRunMessages = messages.Concat(response.Messages).Append(
            new ChatMessage(
                ChatRole.System,
                [new TextContent("Please provide a concise summary of the state changes in at most two sentences.")]));

        await foreach (var update in this.InnerAgent.RunStreamingAsync(secondRunMessages, session, options, cancellationToken).ConfigureAwait(false))
        {
            yield return update;
        }
    }

    private static bool TryDeserialize<T>(string json, JsonSerializerOptions jsonSerializerOptions, out T structuredOutput)
    {
        try
        {
            T? result = JsonSerializer.Deserialize<T>(json, jsonSerializerOptions);
            if (result is null)
            {
                structuredOutput = default!;
                return false;
            }

            structuredOutput = result;
            return true;
        }
        catch
        {
            structuredOutput = default!;
            return false;
        }
    }
}
