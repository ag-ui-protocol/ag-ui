using System.Linq;
using System.Runtime.CompilerServices;
using AGUI.Abstractions;
using AGUI.Client;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Server.IntegrationTests;

public sealed class ReasoningIntegrationTest : IntegrationTestBase
{
    public ReasoningIntegrationTest(WebApplicationFactory<Program> factory)
        : base(factory)
    {
    }

    [Fact]
    public async Task PostRun_FullReasoningFlow_MapsToUpdatesWithRawRepresentation()
    {
        var client = CreateClient((messages, options, ct) => EmitFullReasoningFlow(ct));

        var updates = await CollectUpdates(client, [new ChatMessage(ChatRole.User, "Think about this")]);

        // Expect: RunStarted, ReasoningStart, ReasoningMessageStart, ReasoningMessageContent, ReasoningMessageEnd, ReasoningEnd, RunFinished
        Assert.Equal(7, updates.Count);

        Assert.IsType<ReasoningStartEvent>(updates[1].RawRepresentation);
        Assert.IsType<ReasoningMessageStartEvent>(updates[2].RawRepresentation);
        Assert.IsType<ReasoningMessageContentEvent>(updates[3].RawRepresentation);
        Assert.IsType<ReasoningMessageEndEvent>(updates[4].RawRepresentation);
        Assert.IsType<ReasoningEndEvent>(updates[5].RawRepresentation);

        // Content event should have TextReasoningContent
        var reasoning = Assert.Single(updates[3].Contents.OfType<TextReasoningContent>());
        Assert.Equal("Thinking step 1", reasoning.Text);
    }

    // Bracketed, because a reasoning span left open at RUN_FINISHED is a streaming-discipline
    // violation the client now rejects: what this test is about is the properties the START
    // carries, not an unclosed span.
    [Fact]
    public async Task PostRun_ReasoningStart_HasCorrectProperties()
    {
        var client = CreateClient((messages, options, ct) => EmitReasoningEvents(
            ct,
            new ReasoningStartEvent { MessageId = "rs-1" },
            new ReasoningEndEvent { MessageId = "rs-1" }));

        var updates = await CollectUpdates(client, [new ChatMessage(ChatRole.User, "Hi")]);

        Assert.Equal(4, updates.Count);
        var update = updates[1];
        Assert.Equal(ChatRole.Assistant, update.Role);
        var evt = Assert.IsType<ReasoningStartEvent>(update.RawRepresentation);
        Assert.Equal("rs-1", evt.MessageId);
    }

    // Bracketed for the same reason: a reasoning fragment with no opener is rejected, and the
    // content this test reads is what the CONTENT event carries inside a well-formed message.
    [Fact]
    public async Task PostRun_ReasoningMessageContent_HasTextReasoningContent()
    {
        var client = CreateClient((messages, options, ct) => EmitReasoningEvents(
            ct,
            new ReasoningMessageStartEvent { MessageId = "rmc-1" },
            new ReasoningMessageContentEvent { MessageId = "rmc-1", Delta = "Let me think..." },
            new ReasoningMessageEndEvent { MessageId = "rmc-1" }));

        var updates = await CollectUpdates(client, [new ChatMessage(ChatRole.User, "Hi")]);

        Assert.Equal(5, updates.Count);
        var reasoning = Assert.Single(updates[2].Contents.OfType<TextReasoningContent>());
        Assert.Equal("Let me think...", reasoning.Text);
        Assert.IsType<ReasoningMessageContentEvent>(reasoning.RawRepresentation);
    }

    [Fact]
    public async Task PostRun_ReasoningEncryptedValue_HasTextReasoningContentWithProtectedData()
    {
        var client = CreateClient((messages, options, ct) => EmitSingleReasoningEvent(
            new ReasoningEncryptedValueEvent
            {
                Subtype = "tool-call",
                EntityId = "entity-1",
                EncryptedValue = "enc-secret"
            }, ct));

        var updates = await CollectUpdates(client, [new ChatMessage(ChatRole.User, "Hi")]);

        Assert.Equal(3, updates.Count);
        var reasoning = Assert.Single(updates[1].Contents.OfType<TextReasoningContent>());
        Assert.Equal("enc-secret", reasoning.ProtectedData);
        Assert.IsType<ReasoningEncryptedValueEvent>(reasoning.RawRepresentation);
    }

    [Fact]
    public async Task PostRun_ReasoningMessageChunk_MapsCorrectly()
    {
        var client = CreateClient((messages, options, ct) => EmitSingleReasoningEvent(
            new ReasoningMessageChunkEvent { MessageId = "chunk-1", Delta = "compact" }, ct));

        var updates = await CollectUpdates(client, [new ChatMessage(ChatRole.User, "Hi")]);

        Assert.Equal(3, updates.Count);
        var evt = Assert.IsType<ReasoningMessageChunkEvent>(updates[1].RawRepresentation);
        Assert.Equal("chunk-1", evt.MessageId);
        Assert.Equal("compact", evt.Delta);
    }

    [Fact]
    public async Task PostRun_ReasoningEvents_ShareResponseId()
    {
        var client = CreateClient((messages, options, ct) => EmitFullReasoningFlow(ct));

        var updates = await CollectUpdates(client, [new ChatMessage(ChatRole.User, "Think")]);

        // AGUIChatClient is stateless: it never surfaces a ConversationId (issue #4869).
        // Updates are correlated by ResponseId instead.
        Assert.All(updates, u =>
        {
            Assert.Null(u.ConversationId);
            Assert.NotNull(u.ResponseId);
        });

        var responseId = updates[0].ResponseId;
        Assert.All(updates, u => Assert.Equal(responseId, u.ResponseId));
    }

    [Fact]
    public async Task PostRun_ReasoningEvents_AllHaveAssistantRole()
    {
        var client = CreateClient((messages, options, ct) => EmitFullReasoningFlow(ct));

        var updates = await CollectUpdates(client, [new ChatMessage(ChatRole.User, "Think")]);

        // All reasoning updates (indices 1-5) should have Assistant role
        for (var i = 1; i <= 5; i++)
        {
            Assert.Equal(ChatRole.Assistant, updates[i].Role);
        }
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> EmitFullReasoningFlow(
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            RawRepresentation = new ReasoningStartEvent { MessageId = "reason-1" }
        };
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            RawRepresentation = new ReasoningMessageStartEvent { MessageId = "reason-1" }
        };
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            RawRepresentation = new ReasoningMessageContentEvent { MessageId = "reason-1", Delta = "Thinking step 1" }
        };
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            RawRepresentation = new ReasoningMessageEndEvent { MessageId = "reason-1" }
        };
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            RawRepresentation = new ReasoningEndEvent { MessageId = "reason-1" }
        };
        await Task.CompletedTask.ConfigureAwait(false);
    }

    private static IAsyncEnumerable<ChatResponseUpdate> EmitSingleReasoningEvent(
        BaseEvent evt,
        CancellationToken ct = default) =>
        EmitReasoningEvents(ct, evt);

    private static async IAsyncEnumerable<ChatResponseUpdate> EmitReasoningEvents(
        [EnumeratorCancellation] CancellationToken ct,
        params BaseEvent[] events)
    {
        foreach (var evt in events)
        {
            yield return new ChatResponseUpdate
            {
                Role = ChatRole.Assistant,
                RawRepresentation = evt
            };
        }

        await Task.CompletedTask.ConfigureAwait(false);
    }
}
