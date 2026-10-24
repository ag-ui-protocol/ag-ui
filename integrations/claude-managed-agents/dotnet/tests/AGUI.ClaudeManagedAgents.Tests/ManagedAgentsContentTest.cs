using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.ClaudeManagedAgents.Tests;

public class ManagedAgentsContentTest
{
    private const string Idle = """{"type":"session.status_idle","id":"idle","stop_reason":{"type":"end_turn"}}""";

    private static async Task<(FakeManagedAgentsClient Fake, List<BaseEvent> Events, RunAgentInput Input)> RunAsync(AGUIContent content, params string[] native)
    {
        var fake = new FakeManagedAgentsClient([.. native, Idle]);
        var input = new RunAgentInput { ThreadId = "t", RunId = "r", State = JsonSerializer.SerializeToElement(new { cart = new { total = 42 } }), Messages = [new AGUIUserMessage { Id = "original-user", Content = content }], Tools = [] };
        var agent = new ManagedAgentsAgent(new ManagedAgentsAgentOptions { ManagedAgentId = "a", EnvironmentId = "e", Client = fake });
        var events = new List<BaseEvent>();
        await foreach (var item in agent.RunAsync(input)) events.Add(item);
        return (fake, events, input);
    }

    [Theory]
    [InlineData(true, "agent.tool_result", "tool_use_id")]
    [InlineData(false, "agent.tool_result", "tool_use_id")]
    [InlineData(true, "agent.mcp_tool_result", "mcp_tool_use_id")]
    [InlineData(false, "agent.mcp_tool_result", "mcp_tool_use_id")]
    public async Task PreservesNativeResultStatus(bool isError, string kind, string field)
    {
        const string text = "Permission to use read has been rejected.";
        var native = JsonSerializer.Serialize(new Dictionary<string, object> {
            ["type"] = kind, ["id"] = "native-result", [field] = "native-call",
            ["is_error"] = isError, ["content"] = new[] { new { type = "text", text } },
        });
        var run = await RunAsync("hello", native);
        var result = Assert.Single(run.Events.OfType<ToolCallResultEvent>());
        Assert.Equal("native-result", result.MessageId);
        Assert.Equal("native-call", result.ToolCallId);
        var actual = Assert.IsType<AGUITextInputContent>(Assert.Single(result.Content)).Text;
        if (isError)
        {
            using var envelope = JsonDocument.Parse(actual);
            Assert.True(envelope.RootElement.GetProperty("error").GetBoolean());
            actual = envelope.RootElement.GetProperty("content").GetString()!;
        }
        Assert.Equal(text, actual);
        Assert.IsType<RunFinishedEvent>(run.Events[^1]);
    }

    [Theory]
    [InlineData("image", "image/png")]
    [InlineData("document", "application/pdf")]
    public async Task PreservesSourcesAndOriginalInput(string kind, string mime)
    {
        AGUIMediaInputContent Part(AGUIInputContentSource source) => kind == "image"
            ? new AGUIImageInputContent { Source = source, Metadata = JsonSerializer.SerializeToElement(new { filename = "original.bin" }) }
            : new AGUIDocumentInputContent { Source = source, Metadata = JsonSerializer.SerializeToElement(new { filename = "original.bin" }) };
        var run = await RunAsync(new AGUIContent(new List<AGUIInputContent> {
            Part(new AGUIInputContentDataSource { Value = "AAEC/w==", MimeType = mime }),
            Part(new AGUIInputContentUrlSource { Value = "https://example.test/media", MimeType = mime }),
            Part(new AGUIInputContentFileSource { Value = "file_native", Provider = "anthropic", MimeType = mime }),
        }));
        Assert.Same(run.Input, Assert.IsType<RunStartedEvent>(run.Events[0]).Input);
        Assert.Equal(run.Input.State, Assert.Single(run.Events.OfType<StateSnapshotEvent>()).Snapshot);
        var blocks = run.Fake.Sent[0][0].GetProperty("content");
        Assert.Equal("AAEC/w==", blocks[0].GetProperty("source").GetProperty("data").GetString());
        Assert.Equal(mime, blocks[0].GetProperty("source").GetProperty("media_type").GetString());
        Assert.Equal("https://example.test/media", blocks[1].GetProperty("source").GetProperty("url").GetString());
        Assert.Equal("file_native", blocks[2].GetProperty("source").GetProperty("file_id").GetString());
        Assert.IsType<RunFinishedEvent>(run.Events[^1]);
    }

    [Theory]
    [InlineData("audio")]
    [InlineData("video")]
    public async Task UnsupportedOnlyMediaIsRecordedWithoutSending(string kind)
    {
        AGUIInputContentSource source = new AGUIInputContentDataSource { Value = "AAEC", MimeType = kind + "/test" };
        AGUIInputContent part = kind == "audio" ? new AGUIAudioInputContent { Source = source } : new AGUIVideoInputContent { Source = source };
        var run = await RunAsync(new AGUIContent(new List<AGUIInputContent> { part }));
        Assert.Same(run.Input, Assert.IsType<RunStartedEvent>(run.Events[0]).Input);
        Assert.Equal("empty_run", Assert.IsType<RunErrorEvent>(run.Events[^1]).Code);
        Assert.Empty(run.Fake.Sent);
        Assert.Empty(run.Fake.CreatedSessions);
    }

    [Fact]
    public async Task PreservesFullNativeResultWithOriginalIdentity()
    {
        var content = new object[] { new { type = "text", text = "  " + new string('x', 30000) + "\n" }, new { type = "image", source = new { type = "base64", data = "AAEC/w==", media_type = "image/png" } }, new { type = "search_result", title = "A &amp; B", source = "https://example.test", content = new[] {new { type = "text", text = new string('y', 2000) }} } };
        var native = JsonSerializer.Serialize(new { type = "agent.mcp_tool_result", id = "original-result", mcp_tool_use_id = "original-call", is_error = true, content });
        var run = await RunAsync("hello", native);
        var raw = Assert.Single(run.Events.OfType<RawEvent>());
        Assert.Equal("claude-managed-agents", raw.Source);
        Assert.True(JsonElement.DeepEquals(JsonSerializer.Deserialize<JsonElement>(native), raw.Event));
        var result = Assert.Single(run.Events.OfType<ToolCallResultEvent>());
        Assert.Equal("original-result", result.MessageId);
        Assert.Equal("original-call", result.ToolCallId);
        Assert.All(result.Content, p => Assert.True((p is AGUIMediaInputContent media ? media.Metadata : ((AGUITextInputContent)p).Metadata)!.Value.GetProperty("isError").GetBoolean()));
        var preserved = result.Content.Select(p => (p is AGUIMediaInputContent media ? media.Metadata : ((AGUITextInputContent)p).Metadata)!.Value.GetProperty("claudeManagedAgents")).ToArray();
        Assert.True(JsonElement.DeepEquals(JsonSerializer.SerializeToElement(content), JsonSerializer.SerializeToElement(preserved)));
        Assert.Equal("AAEC/w==", Assert.IsType<AGUIInputContentDataSource>(Assert.IsType<AGUIImageInputContent>(result.Content[1]).Source).Value);
    }
    [Fact]
    public async Task MixedUserContentSkipsUnsupportedPartsPreservingInputAndWhitespace()
    {
        var run = await RunAsync(new AGUIContent(new List<AGUIInputContent> {
            new AGUITextInputContent { Text = "  meaningful\n" },
            new AGUIAudioInputContent { Source = new AGUIInputContentUrlSource { Value = "https://example.test/audio" } },
            new AGUIImageInputContent { Source = new AGUIInputContentDataSource { Value = "AAEC", MimeType = "image/tiff" } },
            new AGUIImageInputContent { Source = new AGUIInputContentFileSource { Value = "foreign", Provider = "openai" } },
        }));
        Assert.Same(run.Input, Assert.IsType<RunStartedEvent>(run.Events[0]).Input);
        Assert.Equal(1, run.Fake.Sent[0][0].GetProperty("content").GetArrayLength());
        Assert.Equal("  meaningful\n", run.Fake.Sent[0][0].GetProperty("content")[0].GetProperty("text").GetString());
        Assert.IsType<RunFinishedEvent>(run.Events[^1]);
    }
    [Fact]
    public async Task MeaningfulUserTextPreservesBlankSeparators()
    {
        var run = await RunAsync(new AGUIContent(new List<AGUIInputContent> {
            new AGUITextInputContent { Text = "START" }, new AGUITextInputContent { Text = "\n" }, new AGUITextInputContent { Text = "END" },
        }));
        Assert.Equal(new[] { "START", "\n", "END" }, run.Fake.Sent[0][0].GetProperty("content").EnumerateArray().Select(p => p.GetProperty("text").GetString()));
        Assert.Same(run.Input, Assert.IsType<RunStartedEvent>(run.Events[0]).Input);
        Assert.IsType<RunFinishedEvent>(run.Events[^1]);
    }

    [Fact]
    public async Task SupportedUserMediaPreservesAdjacentBlankText()
    {
        var run = await RunAsync(new AGUIContent(new List<AGUIInputContent> {
            new AGUIImageInputContent { Source = new AGUIInputContentUrlSource { Value = "https://example.test/image" } },
            new AGUITextInputContent { Text = " \n" },
        }));
        var blocks = run.Fake.Sent[0][0].GetProperty("content");
        Assert.Equal(2, blocks.GetArrayLength());
        Assert.Equal("https://example.test/image", blocks[0].GetProperty("source").GetProperty("url").GetString());
        Assert.Equal(" \n", blocks[1].GetProperty("text").GetString());
        Assert.IsType<RunFinishedEvent>(run.Events[^1]);
    }
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task TextDocumentUsesUtf8TextSourcePreservingOriginalInput(bool mixed)
    {
        const string text = "\uFEFF  café 日本語 😀\r\nPARITY42\n";
        var encoded = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(text));
        var document = new AGUIDocumentInputContent { Source = new AGUIInputContentDataSource { Value = encoded, MimeType = "text/plain" }, Metadata = JsonSerializer.SerializeToElement(new { filename = "note.txt" }) };
        var parts = new List<AGUIInputContent> { document };
        if (mixed) parts.AddRange([
            new AGUIImageInputContent { Source = new AGUIInputContentDataSource { Value = "AAEC/w==", MimeType = "image/png" } },
            new AGUIDocumentInputContent { Source = new AGUIInputContentDataSource { Value = "JVBERi0=", MimeType = "application/pdf" } },
            new AGUIAudioInputContent { Source = new AGUIInputContentDataSource { Value = "AAEC", MimeType = "audio/wav" } },
        ]);
        var original = JsonSerializer.SerializeToElement(parts);
        var run = await RunAsync(new AGUIContent(parts));
        var recorded = Assert.IsType<RunStartedEvent>(run.Events[0]).Input!;
        Assert.True(JsonElement.DeepEquals(original, JsonSerializer.SerializeToElement(Assert.IsType<AGUIUserMessage>(recorded.Messages[0]).Content.ToList())));
        var blocks = run.Fake.Sent[0][0].GetProperty("content");
        Assert.Equal(mixed ? 3 : 1, blocks.GetArrayLength());
        Assert.True(JsonElement.DeepEquals(JsonSerializer.SerializeToElement(new { type = "document", title = "note.txt", source = new { type = "text", media_type = "text/plain", data = text } }), blocks[0]));
        if (mixed)
        {
            Assert.Equal("base64", blocks[1].GetProperty("source").GetProperty("type").GetString());
            Assert.Equal("AAEC/w==", blocks[1].GetProperty("source").GetProperty("data").GetString());
            Assert.Equal("application/pdf", blocks[2].GetProperty("source").GetProperty("media_type").GetString());
            Assert.Equal("JVBERi0=", blocks[2].GetProperty("source").GetProperty("data").GetString());
        }
        Assert.IsType<RunFinishedEvent>(run.Events[^1]);
    }
    [Theory]
    [InlineData("%%%")]
    [InlineData("/w==")]
    public async Task MalformedTextDocumentIsRejectedWithoutReplacingBytes(string data)
    {
        var document = new AGUIDocumentInputContent { Source = new AGUIInputContentDataSource { Value = data, MimeType = "text/plain" }, Metadata = JsonSerializer.SerializeToElement(new { filename = "invalid.txt" }) };
        var run = await RunAsync(new AGUIContent(new List<AGUIInputContent> { document }));
        var recorded = Assert.IsType<RunStartedEvent>(run.Events[0]).Input!;
        var part = Assert.IsType<AGUIDocumentInputContent>(Assert.IsType<AGUIUserMessage>(recorded.Messages[0]).Content[0]);
        Assert.Equal(data, Assert.IsType<AGUIInputContentDataSource>(part.Source).Value);
        Assert.Equal("invalid_attachment", Assert.IsType<RunErrorEvent>(run.Events[^1]).Code);
        Assert.Empty(run.Fake.Sent);
        Assert.Empty(run.Fake.CreatedSessions);
    }
}
