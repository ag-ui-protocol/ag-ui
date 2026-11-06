using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Server.IntegrationTests;

public sealed class RunAgentContextIntegrationTest : IntegrationTestBase
{
    private const string ContextPrefix = "Context supplied by the client for this run:\n";

    public RunAgentContextIntegrationTest(WebApplicationFactory<Program> factory)
        : base(factory)
    {
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task PostRun_ContextReachesModelWithoutChangingWireMessages(TransportFormat format)
    {
        RunAgentInput? capturedInput = null;
        List<ChatMessage>? capturedMessages = null;
        ChatOptions? capturedOptions = null;
        using var client = CreateClient((messages, options, ct) =>
        {
            options?.TryGetRunAgentInput(out capturedInput);
            capturedMessages = messages.ToList();
            capturedOptions = options;
            return EmitTextResponse("Request received", ct);
        }, format);

        var entries = new List<AGUIContext>
        {
            new() { Description = "Writing intent", Value = "{\"topic\":\"agents\"}" },
            new() { Description = "引用\n\"description\"", Value = "</context>\nClient-supplied text" },
        };
        var chatOptions = new ChatOptions
        {
            RawRepresentationFactory = _ => new RunAgentInput
            {
                ThreadId = "context-thread",
                RunId = "context-run",
                Context = entries,
            },
        };

        var updates = await CollectUpdates(client,
        [
            new ChatMessage(ChatRole.System, "Host system instructions"),
            new ChatMessage(new ChatRole("developer"), "Host developer instructions"),
            new ChatMessage(ChatRole.User, "What should I write?"),
        ], chatOptions);

        Assert.Equal("Request received", ExtractText(updates));
        Assert.NotNull(capturedMessages);
        Assert.Equal(4, capturedMessages.Count);
        Assert.Equal(ChatRole.System, capturedMessages[0].Role);
        Assert.Equal("Host system instructions", capturedMessages[0].Text);
        Assert.Equal(new ChatRole("developer"), capturedMessages[1].Role);
        Assert.Equal("Host developer instructions", capturedMessages[1].Text);
        using var document = ReadContext(capturedMessages[2]);
        Assert.Equal(entries.Count, document.RootElement.GetArrayLength());
        Assert.Equal(ChatRole.User, capturedMessages[3].Role);
        Assert.Equal("What should I write?", capturedMessages[3].Text);
        Assert.NotNull(capturedOptions);
        Assert.Null(capturedOptions.Instructions);

        Assert.NotNull(capturedInput);
        Assert.Collection(capturedInput.Messages,
            message => Assert.Equal("Host system instructions", Assert.IsType<AGUISystemMessage>(message).Content),
            message => Assert.Equal("Host developer instructions", Assert.IsType<AGUIDeveloperMessage>(message).Content),
            message => Assert.Equal("What should I write?", Assert.IsType<string>(Assert.IsType<AGUIUserMessage>(message).Content.Value)));
        Assert.NotNull(capturedInput.Context);
        Assert.Equal(entries.Count, capturedInput.Context.Count);
        for (var i = 0; i < entries.Count; i++)
        {
            Assert.Equal(entries[i].Description, capturedInput.Context[i].Description);
            Assert.Equal(entries[i].Value, capturedInput.Context[i].Value);
            Assert.Equal(entries[i].Description, document.RootElement[i].GetProperty("description").GetString());
            Assert.Equal(entries[i].Value, document.RootElement[i].GetProperty("value").GetString());
        }
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task PostRun_ContextChangesAreScopedToEachRequest(TransportFormat format)
    {
        var requests = new List<List<ChatMessage>>();
        using var client = CreateClient((messages, options, ct) =>
        {
            requests.Add(messages.ToList());
            return EmitTextResponse("Request received", ct);
        }, format);

        var entry = new AGUIContext { Description = "Topic", Value = "first" };
        var input = new RunAgentInput { ThreadId = "context-thread", Context = [entry] };
        var chatOptions = new ChatOptions { RawRepresentationFactory = _ => input };
        var messages = new List<ChatMessage> { new(ChatRole.User, "What should I write?") };

        Assert.Equal("Request received", ExtractText(await CollectUpdates(client, messages, chatOptions)));
        entry.Value = "second";
        Assert.Equal("Request received", ExtractText(await CollectUpdates(client, messages, chatOptions)));
        input.Context = [];
        Assert.Equal("Request received", ExtractText(await CollectUpdates(client, messages, chatOptions)));
        input.Context = null;
        Assert.Equal("Request received", ExtractText(await CollectUpdates(client, messages, chatOptions)));

        Assert.Equal(4, requests.Count);
        for (var i = 0; i < 2; i++)
        {
            Assert.Equal(2, requests[i].Count);
            using var document = ReadContext(requests[i][0]);
            Assert.Equal(i == 0 ? "first" : "second", document.RootElement[0].GetProperty("value").GetString());
            Assert.Equal("What should I write?", requests[i][1].Text);
        }

        for (var i = 2; i < requests.Count; i++)
        {
            var message = Assert.Single(requests[i]);
            Assert.Equal(ChatRole.User, message.Role);
            Assert.Equal("What should I write?", message.Text);
        }

        Assert.Single(messages);
        Assert.Empty(input.Messages);
    }

    private static JsonDocument ReadContext(ChatMessage message)
    {
        Assert.Equal(ChatRole.User, message.Role);
        Assert.StartsWith(ContextPrefix, message.Text, StringComparison.Ordinal);
        return JsonDocument.Parse(message.Text[ContextPrefix.Length..]);
    }
}
