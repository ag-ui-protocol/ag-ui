using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.A2UI.UnitTests;

public sealed class A2UIRequestValidationTest
{
    public static IEnumerable<object[]> InvalidArguments()
    {
        foreach (string name in new[] { "intent", "target_surface_id", "changes" })
        {
            foreach (string value in new[] { "null", "object", "array", "number", "boolean", "clr-null", "clr-object", "node" })
            {
                yield return [name, value, true];
                yield return [name, value, false];
            }
        }
    }

    [Theory]
    [MemberData(nameof(InvalidArguments))]
    public async Task InvalidType_ReturnsOriginalCallErrorWithoutRenderingAsync(string name, string kind, bool streaming)
    {
        object? value = kind switch
        {
            "clr-null" => null,
            "clr-object" => new Dictionary<string, object?> { ["revenue"] = 22 },
            "node" => new JsonObject { ["revenue"] = 22 },
            _ => JsonDocument.Parse(kind switch
            {
                "object" => "{\"revenue\":22}",
                "array" => "[22]",
                "number" => "22",
                "boolean" => "true",
                _ => "null",
            }).RootElement.Clone(),
        };
        var arguments = new Dictionary<string, object?> { ["intent"] = "create", [name] = value };
        var renderer = new Renderer();
        var planner = new Planner(arguments);
        using var client = new A2UIChatClient(planner, renderer, new() { InjectA2UITool = true });

        List<AIContent> content = await RunAsync(client, streaming);

        Assert.Equal(0, renderer.Calls);
        Assert.Same(value, arguments[name]);
        FunctionResultContent result = Assert.Single(content.OfType<FunctionResultContent>());
        Assert.Equal("generate", result.CallId);
        JsonElement envelope = Assert.IsType<JsonElement>(result.Result);
        Assert.Contains(name, envelope.GetProperty("error").GetString());
        Assert.False(envelope.TryGetProperty("a2ui_operations", out _));
        Assert.Single(content.OfType<FunctionCallContent>());
        Assert.Contains(planner.NextHistory.SelectMany(m => m.Contents).OfType<FunctionResultContent>(), r => r.CallId == "generate");
    }

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData("delete")]
    [InlineData("UPDATE")]
    public async Task UnknownIntent_DoesNotBecomeCreateAsync(string intent)
    {
        var renderer = new Renderer();
        using var client = new A2UIChatClient(new Planner(new() { ["intent"] = intent }), renderer, new() { InjectA2UITool = true });
        List<AIContent> content = await RunAsync(client, true);
        Assert.Equal(0, renderer.Calls);
        Assert.Contains("intent", Assert.IsType<JsonElement>(Assert.Single(content.OfType<FunctionResultContent>()).Result).GetProperty("error").GetString());
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("  ")]
    public async Task UpdateWithoutTarget_DoesNotCreateSurfaceAsync(string? target)
    {
        var arguments = new Dictionary<string, object?> { ["intent"] = "update" };
        if (target is not null)
        {
            arguments["target_surface_id"] = target;
        }
        var renderer = new Renderer();
        using var client = new A2UIChatClient(new Planner(arguments), renderer, new() { InjectA2UITool = true });
        List<AIContent> content = await RunAsync(client, true);
        Assert.Equal(0, renderer.Calls);
        Assert.Contains("target_surface_id", Assert.IsType<JsonElement>(Assert.Single(content.OfType<FunctionResultContent>()).Result).GetProperty("error").GetString());
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task OmittedOptionalArguments_KeepDefaultCreateAsync(bool streaming)
    {
        var renderer = new Renderer();
        using var client = new A2UIChatClient(new Planner([]), renderer, new() { InjectA2UITool = true });
        List<AIContent> content = await RunAsync(client, streaming);
        Assert.Equal(1, renderer.Calls);
        FunctionResultContent result = content.OfType<FunctionResultContent>().Single(r => r.CallId == "generate");
        Assert.True(Assert.IsType<JsonElement>(result.Result).TryGetProperty("a2ui_operations", out _));
    }

    [Theory]
    [InlineData("clr")]
    [InlineData("element")]
    [InlineData("node")]
    public async Task TypedStringChanges_ReachRendererUnchangedAsync(string representation)
    {
        const string requestedChange = "Use exact revenue 22, preserving whitespace:  x  y.";
        object changes = representation switch
        {
            "element" => JsonDocument.Parse("\"" + requestedChange + "\"").RootElement.Clone(),
            "node" => JsonValue.Create(requestedChange)!,
            _ => requestedChange,
        };
        var arguments = new Dictionary<string, object?> { ["intent"] = "update", ["target_surface_id"] = "card", ["changes"] = changes };
        var renderer = new Renderer();
        using var client = new A2UIChatClient(new Planner(arguments), renderer, new() { InjectA2UITool = true });
        List<AIContent> content = await RunAsync(client, true, includePriorSurface: true);
        Assert.Equal(1, renderer.Calls);
        Assert.Contains(requestedChange, renderer.Prompt);
        FunctionResultContent result = content.OfType<FunctionResultContent>().Single(r => r.CallId == "generate");
        JsonElement operations = Assert.IsType<JsonElement>(result.Result).GetProperty("a2ui_operations");
        Assert.DoesNotContain(operations.EnumerateArray(), o => o.TryGetProperty("createSurface", out _));
        Assert.Same(changes, arguments["changes"]);
    }

    private static async Task<List<AIContent>> RunAsync(A2UIChatClient client, bool streaming, bool includePriorSurface = false)
    {
        var messages = new List<ChatMessage>();
        if (includePriorSurface)
        {
            messages.Add(new ChatMessage(ChatRole.Tool, [new FunctionResultContent("prior", JsonDocument.Parse("""
                {"a2ui_operations":[{"version":"v0.9","createSurface":{"surfaceId":"card","catalogId":"catalog"}},{"version":"v0.9","updateComponents":{"surfaceId":"card","components":[{"id":"root","component":"Text","text":"Old"}]}}]}
                """).RootElement.Clone())]));
        }
        messages.Add(new ChatMessage(ChatRole.User, "Generate the requested surface."));
        if (!streaming)
        {
            return (await client.GetResponseAsync(messages).ConfigureAwait(false)).Messages.SelectMany(m => m.Contents).ToList();
        }
        var content = new List<AIContent>();
        await foreach (ChatResponseUpdate update in client.GetStreamingResponseAsync(messages).ConfigureAwait(false))
        {
            content.AddRange(update.Contents);
        }
        return content;
    }

    private sealed class Planner(Dictionary<string, object?> arguments) : IChatClient
    {
        private int _round;
        public IReadOnlyList<ChatMessage> NextHistory { get; private set; } = [];
        public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            await Task.CompletedTask.ConfigureAwait(false);
            if (this._round++ == 0)
            {
                yield return new ChatResponseUpdate(ChatRole.Assistant, [new FunctionCallContent("generate", "generate_a2ui", arguments)]);
            }
            else
            {
                this.NextHistory = messages.ToList();
                yield return new ChatResponseUpdate(ChatRole.Assistant, "Done");
            }
        }
        public Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public object? GetService(Type serviceType, object? serviceKey = null) => null;
        public void Dispose() { }
    }

    private sealed class Renderer : IChatClient
    {
        public int Calls { get; private set; }
        public string Prompt { get; private set; } = string.Empty;
        public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            await Task.CompletedTask.ConfigureAwait(false);
            this.Calls++;
            this.Prompt = string.Join("\n", messages.Select(m => m.Text));
            yield return new ChatResponseUpdate(ChatRole.Assistant, [new FunctionCallContent("render", "render_a2ui", new Dictionary<string, object?>
            {
                ["surfaceId"] = "card",
                ["components"] = new object[] { new Dictionary<string, object?> { ["id"] = "root", ["component"] = "Text", ["text"] = "22" } },
            })]);
        }
        public Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public object? GetService(Type serviceType, object? serviceKey = null) => null;
        public void Dispose() { }
    }
}
