using System.Diagnostics.CodeAnalysis;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

namespace AGUIDojoServer.PredictiveStateUpdates;

[SuppressMessage("Performance", "CA1812:Avoid uninstantiated internal classes", Justification = "Instantiated by ChatClientAgentFactory.CreatePredictiveStateUpdates")]
internal sealed class PredictiveStateUpdatesAgent : DelegatingAIAgent
{
    private readonly JsonSerializerOptions _jsonSerializerOptions;
    private const int ChunkSize = 10; // Characters per chunk for streaming effect

    public PredictiveStateUpdatesAgent(AIAgent innerAgent, JsonSerializerOptions jsonSerializerOptions)
        : base(innerAgent)
    {
        this._jsonSerializerOptions = jsonSerializerOptions;
    }

    public override Task<AgentRunResponse> RunAsync(IEnumerable<ChatMessage> messages, AgentThread? thread = null, AgentRunOptions? options = null, CancellationToken cancellationToken = default)
    {
        return this.RunStreamingAsync(messages, thread, options, cancellationToken).ToAgentRunResponseAsync(cancellationToken);
    }

    public override async IAsyncEnumerable<AgentRunResponseUpdate> RunStreamingAsync(
        IEnumerable<ChatMessage> messages,
        AgentThread? thread = null,
        AgentRunOptions? options = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        // Track the last emitted document state to avoid duplicates
        string? lastEmittedDocument = null;

        await foreach (var update in this.InnerAgent.RunStreamingAsync(messages, thread, options, cancellationToken).ConfigureAwait(false))
        {
            // Check if we're seeing a write_document tool call and emit predictive state
            bool hasToolCall = false;
            string? documentContent = null;

            foreach (var content in update.Contents)
            {
                if (content is FunctionCallContent callContent && callContent.Name == "write_document")
                {
                    hasToolCall = true;
                    // Try to extract the document argument directly from the dictionary
                    if (callContent.Arguments?.TryGetValue("document", out var documentValue) == true)
                    {
                        documentContent = documentValue?.ToString();
                    }
                }
            }

            // Always yield the original update first
            yield return update;

            // If we got a complete tool call with document content, "fake" stream it in chunks
            if (hasToolCall && documentContent != null && documentContent != lastEmittedDocument)
            {
                // Chunk the document content and emit progressive state updates
                int startIndex = 0;
                if (lastEmittedDocument != null && documentContent.StartsWith(lastEmittedDocument, StringComparison.Ordinal))
                {
                    // Only stream the new portion that was added
                    startIndex = lastEmittedDocument.Length;
                }

                // Stream the document in chunks
                for (int i = startIndex; i < documentContent.Length; i += ChunkSize)
                {
                    int length = Math.Min(ChunkSize, documentContent.Length - i);
                    string chunk = documentContent.Substring(0, i + length);

                    // Prepare predictive state update as DataContent
                    var stateUpdate = new DocumentState { Document = chunk };
                    byte[] stateBytes = JsonSerializer.SerializeToUtf8Bytes(
                        stateUpdate,
                        this._jsonSerializerOptions.GetTypeInfo(typeof(DocumentState)));

                    yield return new AgentRunResponseUpdate(
                        new ChatResponseUpdate(role: ChatRole.Assistant, [new DataContent(stateBytes, "application/json")])
                        {
                            MessageId = "snapshot" + Guid.NewGuid().ToString("N"),
                            CreatedAt = update.CreatedAt,
                            ResponseId = update.ResponseId,
                            AdditionalProperties = update.AdditionalProperties,
                            AuthorName = update.AuthorName,
                        })
                    {
                        AgentId = update.AgentId
                    };

                    // Small delay to simulate streaming
                    await Task.Delay(50, cancellationToken).ConfigureAwait(false);
                }

                lastEmittedDocument = documentContent;
            }
        }
    }
}
