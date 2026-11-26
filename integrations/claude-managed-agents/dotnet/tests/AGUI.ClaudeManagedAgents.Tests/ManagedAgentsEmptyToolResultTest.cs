using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.ClaudeManagedAgents.Tests;

public sealed class ManagedAgentsEmptyToolResultTest
{
    private const string Key = "7:agent_1|0:|5:env_1|0:|thread_1";
    private const string Idle = """{"type":"session.status_idle","id":"idle","stop_reason":{"type":"end_turn"}}""";

    [Theory]
    [InlineData("empty-string", "[]", null)]
    [InlineData("empty-array", "[]", null)]
    [InlineData("empty-part", "[]", null)]
    [InlineData("unsupported", "[]", null)]
    [InlineData("answer", """[{"type":"text","text":"  answered\n"}]""", null)]
    [InlineData("whitespace", """[{"type":"text","text":" \n"}]""", null)]
    [InlineData("empty-string", """[{"type":"text","text":"Failed"}]""", "Failed")]
    [InlineData("mixed", """[{"type":"text","text":" \n"},{"type":"image","source":{"type":"file","file_id":"file_1"}},{"type":"document","source":{"type":"url","url":"https://example.test/file.pdf"},"title":"file.pdf"}]""", null)]
    [InlineData("mixed", """[{"type":"text","text":" \n"},{"type":"image","source":{"type":"file","file_id":"file_1"}},{"type":"document","source":{"type":"url","url":"https://example.test/file.pdf"},"title":"file.pdf"},{"type":"text","text":"Failed"}]""", "Failed")]
    public async Task CompletesOriginalCallOnceAndRecoversWithoutResending(string shape, string expected, string? error)
    {
        var fake = new FakeManagedAgentsClient([Idle], [Idle])
        {
            History = [FakeManagedAgentsClient.Json("""{"type":"agent.custom_tool_use","id":"chart_1","name":"chart","input":{}}""")],
        };
        var store = new InMemorySessionStore();
        ManagedAgentsSessionRecord Pending() => new() { SessionId = "sesn_original", ToolNames = [], PendingClientToolUseIds = ["chart_1"], LastUserMessageId = "u1" };
        await store.SetAsync(Key, Pending(), default);
        ManagedAgentsAgent Agent() => new(new() { ManagedAgentId = "agent_1", EnvironmentId = "env_1", Client = fake, SessionStore = store });
        var content = Content(shape);
        var input = new RunAgentInput
        {
            ThreadId = "thread_1", RunId = "first", Tools = [],
            Messages = [
                new AGUIUserMessage { Id = "u1", Content = "Chart" },
                new AGUIToolMessage { Id = "t1", ToolCallId = "chart_1", Content = content, Error = error },
                new AGUIToolMessage { Id = "t1-copy", ToolCallId = "chart_1", Content = content, Error = error },
            ],
        };
        var events = await Collect(Agent(), input);
        Assert.IsType<RunFinishedEvent>(events[^1]);
        var result = Assert.Single(fake.SentEvents);
        Assert.Equal("user.custom_tool_result", result.GetProperty("type").GetString());
        Assert.Equal("chart_1", result.GetProperty("custom_tool_use_id").GetString());
        Assert.Equal(error is not null, result.GetProperty("is_error").GetBoolean());
        Assert.True(JsonElement.DeepEquals(FakeManagedAgentsClient.Json(expected), result.GetProperty("content")));
        Assert.Equal("sesn_original", Assert.Single(fake.SentSessionIds));
        Assert.Empty((await store.GetAsync(Key, default))!.PendingClientToolUseIds);

        // A fresh adapter reconstructs completion from native history even with stale bookkeeping.
        await store.SetAsync(Key, Pending(), default);
        input.RunId = "replay";
        var replay = await Collect(Agent(), input);
        Assert.IsType<RunFinishedEvent>(replay[^1]);
        Assert.Single(fake.SentEvents);
        Assert.Empty(fake.CreatedSessions);
        Assert.Empty((await store.GetAsync(Key, default))!.PendingClientToolUseIds);
        Assert.All(fake.StreamRequests, request => Assert.Equal("sesn_original", request.SessionId));
    }

    private static AGUIContent Content(string shape) => shape switch
    {
        "empty-string" => "",
        "answer" => "  answered\n",
        "whitespace" => " \n",
        "empty-array" => new AGUIContent(new List<AGUIInputContent>()),
        "empty-part" => new AGUIContent(new List<AGUIInputContent> { new AGUITextInputContent { Text = "" } }),
        "unsupported" => new AGUIContent(new List<AGUIInputContent> { new AGUIAudioInputContent { Source = new AGUIInputContentUrlSource { Value = "https://example.test/audio" } } }),
        "mixed" => new AGUIContent(new List<AGUIInputContent>
        {
            new AGUITextInputContent { Text = "" },
            new AGUITextInputContent { Text = " \n" },
            new AGUIImageInputContent { Source = new AGUIInputContentFileSource { Value = "file_1", Provider = "anthropic" } },
            new AGUIDocumentInputContent { Source = new AGUIInputContentUrlSource { Value = "https://example.test/file.pdf", MimeType = "application/pdf" }, Metadata = JsonSerializer.SerializeToElement(new { filename = "file.pdf" }) },
        }),
        _ => throw new ArgumentOutOfRangeException(nameof(shape)),
    };

    private static async Task<List<BaseEvent>> Collect(ManagedAgentsAgent agent, RunAgentInput input)
    {
        var events = new List<BaseEvent>();
        await foreach (var item in agent.RunAsync(input))
        {
            events.Add(item);
        }
        return events;
    }
}
