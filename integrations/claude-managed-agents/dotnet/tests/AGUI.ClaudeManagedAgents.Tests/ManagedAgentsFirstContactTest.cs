using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.ClaudeManagedAgents.Tests;

public class ManagedAgentsFirstContactTest
{
    private static async Task<(FakeManagedAgentsClient Fake, List<BaseEvent> Events)> RunAsync(IList<AGUIMessage> messages)
    {
        var fake = new FakeManagedAgentsClient(["""{"type":"session.status_idle","id":"idle","stop_reason":{"type":"end_turn"}}"""]);
        var input = new RunAgentInput { ThreadId = "t", RunId = "r", State = JsonSerializer.SerializeToElement(new { }), Messages = messages, Tools = [] };
        var original = JsonSerializer.SerializeToElement(input);
        var agent = new ManagedAgentsAgent(new ManagedAgentsAgentOptions { ManagedAgentId = "a", EnvironmentId = "e", Client = fake });
        var events = new List<BaseEvent>();
        await foreach (var item in agent.RunAsync(input)) events.Add(item);
        Assert.Same(input, Assert.IsType<RunStartedEvent>(events[0]).Input);
        Assert.True(JsonElement.DeepEquals(original, JsonSerializer.SerializeToElement(input)));
        return (fake, events);
    }

    [Theory]
    [InlineData("%%%", false)]
    [InlineData("/w==", false)]
    [InlineData("%%%", true)]
    [InlineData("/w==", true)]
    public async Task FirstContactValidatesOnlyNewestUserMessage(string data, bool malformedLast)
    {
        var malformed = new AGUIUserMessage
        {
            Id = "malformed",
            Content = new AGUIContent(new List<AGUIInputContent> {
                new AGUIDocumentInputContent { Source = new AGUIInputContentDataSource { Value = data, MimeType = "text/plain" } },
            }),
        };
        var corrected = new AGUIUserMessage { Id = "corrected", Content = "corrected message" };
        var (fake, events) = await RunAsync(malformedLast ? [corrected, malformed] : [malformed, corrected]);
        if (malformedLast)
        {
            Assert.Equal("invalid_attachment", Assert.IsType<RunErrorEvent>(events[^1]).Code);
            Assert.Single(events.OfType<RunErrorEvent>());
            Assert.Empty(fake.CreatedSessions);
            Assert.Empty(fake.Sent);
        }
        else
        {
            Assert.IsType<RunFinishedEvent>(events[^1]);
            Assert.Single(fake.CreatedSessions);
            var sent = Assert.Single(fake.Sent.SelectMany(batch => batch), item => item.GetProperty("type").GetString() == "user.message");
            Assert.Equal("corrected message", Assert.Single(sent.GetProperty("content").EnumerateArray()).GetProperty("text").GetString());
        }
    }

    [Fact]
    public async Task FirstContactDoesNotCreateFromOlderTextWhenNewestUserIsBlank()
    {
        var (fake, events) = await RunAsync([
            new AGUIUserMessage { Id = "old", Content = "older message" },
            new AGUIUserMessage { Id = "new", Content = " \n" },
        ]);
        Assert.IsType<RunErrorEvent>(events[^1]);
        Assert.Empty(fake.CreatedSessions);
        Assert.Empty(fake.Sent);
    }

    [Theory]
    [InlineData("%%%")]
    [InlineData("/w==")]
    public async Task ExistingSessionDoesNotRevalidateDeliveredHistory(string data)
    {
        var fake = new FakeManagedAgentsClient([Idle("idle")], [Idle("idle_2")]);
        var agent = new ManagedAgentsAgent(new ManagedAgentsAgentOptions { ManagedAgentId = "a", EnvironmentId = "e", Client = fake });
        var corrected = new AGUIUserMessage { Id = "corrected", Content = "corrected message" };
        Assert.IsType<RunFinishedEvent>((await CollectAsync(agent, [Malformed(data), corrected], "r1"))[^1]);
        var events = await CollectAsync(agent, [Malformed(data), corrected, new AGUIUserMessage { Id = "next", Content = "next message" }], "r2");
        Assert.IsType<RunFinishedEvent>(events[^1]);
        Assert.Single(fake.CreatedSessions);
        var sent = Assert.Single(fake.Sent[^1], item => item.GetProperty("type").GetString() == "user.message");
        Assert.Equal("next message", Assert.Single(sent.GetProperty("content").EnumerateArray()).GetProperty("text").GetString());
    }

    [Theory]
    [InlineData("%%%")]
    [InlineData("/w==")]
    public async Task ExistingSessionRejectsMalformedNewestUserMessage(string data)
    {
        var fake = new FakeManagedAgentsClient([Idle("idle")], [Idle("idle_2")]);
        var agent = new ManagedAgentsAgent(new ManagedAgentsAgentOptions { ManagedAgentId = "a", EnvironmentId = "e", Client = fake });
        var corrected = new AGUIUserMessage { Id = "corrected", Content = "corrected message" };
        Assert.IsType<RunFinishedEvent>((await CollectAsync(agent, [corrected], "r1"))[^1]);
        var sent = fake.Sent.Count;
        var events = await CollectAsync(agent, [corrected, Malformed(data)], "r2");
        Assert.Equal("run_failed", Assert.IsType<RunErrorEvent>(events[^1]).Code);
        Assert.Equal(sent, fake.Sent.Count);
    }

    private static string Idle(string id) => $$$"""{"type":"session.status_idle","id":"{{{id}}}","stop_reason":{"type":"end_turn"}}""";

    private static AGUIUserMessage Malformed(string data) => new()
    {
        Id = "malformed",
        Content = new AGUIContent(new List<AGUIInputContent> {
            new AGUIDocumentInputContent { Source = new AGUIInputContentDataSource { Value = data, MimeType = "text/plain" } },
        }),
    };

    private static async Task<List<BaseEvent>> CollectAsync(ManagedAgentsAgent agent, IList<AGUIMessage> messages, string runId)
    {
        var events = new List<BaseEvent>();
        await foreach (var item in agent.RunAsync(new RunAgentInput { ThreadId = "t", RunId = runId, Messages = messages, Tools = [] })) events.Add(item);
        return events;
    }
}
