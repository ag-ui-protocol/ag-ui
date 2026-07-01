using AGUI.Abstractions;
using AGUI.Client;
using Microsoft.Extensions.AI;

namespace Step06_RawEvents.Client;

public static class SampleClient
{
    public static async Task RunAsync(
        IChatClient chatClient,
        TextWriter output,
        List<List<ChatMessage>>? messagesPerTurn = null,
        List<List<ChatResponseUpdate>>? updatesPerTurn = null,
        CancellationToken cancellationToken = default)
    {
        var messages = new List<ChatMessage>
        {
            new(ChatRole.User, "Tell me about ag-ui raw events"),
        };
        messagesPerTurn?.Add(messages.ToList());
        await output.WriteLineAsync("> Tell me about ag-ui raw events").ConfigureAwait(false);

        var updates = new List<ChatResponseUpdate>();
        await foreach (var update in chatClient.GetStreamingResponseAsync(
            messages, options: null, cancellationToken).ConfigureAwait(false))
        {
            updates.Add(update);

            // Telemetry events arrive as RawEvent inside ChatResponseUpdate.RawRepresentation.
            if (update.RawRepresentation is RawEvent { Source: var source, Event: var payload })
            {
                await output.WriteLineAsync($"[telemetry:{source}] {payload.GetRawText()}").ConfigureAwait(false);
                continue;
            }

            if (!string.IsNullOrEmpty(update.Text))
            {
                await output.WriteAsync(update.Text).ConfigureAwait(false);
            }
        }
        await output.WriteLineAsync().ConfigureAwait(false);
        updatesPerTurn?.Add(updates);
    }
}
