using System.Runtime.CompilerServices;
using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;

namespace Step06_RawEvents.Server;

/// <summary>
/// A stateless <see cref="DelegatingChatClient"/> that forwards the model's token-usage
/// reports to the client as AG-UI <see cref="RawEvent"/>s. Whenever the inner client streams
/// a <see cref="UsageContent"/>, its <see cref="UsageDetails"/> are surfaced verbatim as an
/// opaque raw event so the UI can render or log usage without the protocol needing a dedicated
/// event type.
/// </summary>
/// <remarks>
/// The usage payload is attached to a <see cref="ChatResponseUpdate"/> via
/// <see cref="ChatResponseUpdate.RawRepresentation"/>; the hosting layer's
/// <c>AsAGUIEventStreamAsync</c> recognises a <see cref="BaseEvent"/> raw representation and
/// emits it verbatim, so no other plumbing is required to inject protocol events.
/// </remarks>
internal sealed class UsageRawEventsChatClient : DelegatingChatClient
{
    private readonly JsonSerializerOptions _jsonSerializerOptions;

    public UsageRawEventsChatClient(IChatClient innerClient, JsonSerializerOptions jsonSerializerOptions)
        : base(innerClient)
    {
        _jsonSerializerOptions = jsonSerializerOptions;
    }

    public override async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        await foreach (var update in base.GetStreamingResponseAsync(messages, options, cancellationToken).ConfigureAwait(false))
        {
            yield return update;

            foreach (var usage in update.Contents.OfType<UsageContent>())
            {
                yield return ToRawUsageEvent(usage.Details);
            }
        }
    }

    private ChatResponseUpdate ToRawUsageEvent(UsageDetails details) =>
        new()
        {
            RawRepresentation = new RawEvent
            {
                Source = "usage",
                Event = JsonSerializer.SerializeToElement(details, _jsonSerializerOptions),
            },
        };
}
