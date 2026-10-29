using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.A2UI.UnitTests;

public sealed class A2UIHistoryContinuationTest
{
    [Theory]
    [InlineData(true, false)]
    [InlineData(false, false)]
    [InlineData(true, true)]
    [InlineData(false, true)]
    public async Task ActualNestedGeneration_CanContinueWithStrictProviderAsync(bool injectOnContinuation, bool cold)
    {
        var planner = new Planner();
        using var client = new A2UIChatClient(planner, new Renderer(), new A2UIChatClientOptions { InjectA2UITool = true });
        List<ChatMessage> history = [new(ChatRole.User, "Create a dashboard")];
        ChatResponse first = await client.GetResponseAsync(history);
        history.AddRange(first.Messages);
        Assert.Contains(history.SelectMany(m => m.Contents).OfType<FunctionCallContent>(), c => c.Name == "render_a2ui");
        if (cold)
        {
            var typeInfo = (JsonTypeInfo<List<ChatMessage>>)AIJsonUtilities.DefaultOptions.GetTypeInfo(typeof(List<ChatMessage>));
            history = JsonSerializer.Deserialize(JsonSerializer.Serialize(history, typeInfo), typeInfo)!;
        }
        history.Add(new ChatMessage(ChatRole.User, "Create another dashboard"));
        using var continuation = new A2UIChatClient(planner, new Renderer(), new A2UIChatClientOptions { InjectA2UITool = injectOnContinuation });
        await continuation.GetResponseAsync(history);
    }

    [Fact]
    public void CompletedBlock_PreservesOriginalContentAndNativeEnvelopes()
    {
        var outer = new FunctionCallContent("outer", "generate_a2ui", new Dictionary<string, object?> { ["exact"] = "  value  " });
        var inner = new FunctionCallContent("inner", "render_a2ui", new Dictionary<string, object?>());
        inner.AdditionalProperties = new() { ["owner"] = "outer" };
        var outerResult = new FunctionResultContent("outer", "  exact result  ");
        var innerResult = new FunctionResultContent("inner", "rendered");
        List<ChatMessage> source = [new(ChatRole.Assistant, [outer]), new(ChatRole.Assistant, [inner]), new(ChatRole.Tool, [innerResult, outerResult])];
        List<ChatMessage> normalized = A2UIHistoryNormalizer.Normalize(source, "generate_a2ui");
        Validate(normalized);
        Assert.Equal(3, source.Count);
        Assert.Same(inner, Assert.Single(source[1].Contents));
        Assert.Same(outer, normalized[0].Contents[0]);
        Assert.Same(inner, normalized[0].Contents[1]);
        Assert.Same(source[2], normalized[1]);
        Assert.Equal("outer", inner.AdditionalProperties["owner"]);
    }

    [Fact]
    public void MultipleRenderAttempts_KeepEveryOriginalCallAndResult()
    {
        List<ChatMessage> source =
        [
            new(ChatRole.Assistant, [new FunctionCallContent("outer", "generate_a2ui", null)]),
            new(ChatRole.Assistant, [new FunctionCallContent("render-1", "render_a2ui", null)]),
            new(ChatRole.Tool, [new FunctionResultContent("render-1", "first attempt")]),
            new(ChatRole.Assistant, [new FunctionCallContent("render-2", "render_a2ui", null)]),
            new(ChatRole.Tool, [new FunctionResultContent("render-2", "second attempt"), new FunctionResultContent("outer", "exact envelope")]),
        ];
        List<ChatMessage> normalized = A2UIHistoryNormalizer.Normalize(source, "generate_a2ui");
        Validate(normalized);
        Assert.Equal(5, source.Count);
        Assert.Equal(3, normalized[0].Contents.Count);
        Assert.Same(source[2], normalized[1]);
        Assert.Same(source[4], normalized[2]);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("foreign")]
    [InlineData("duplicate")]
    [InlineData("ordinary")]
    public void UnprovenBlock_IsNotRepaired(string scenario)
    {
        List<ChatMessage> source = [new(ChatRole.Assistant, [new FunctionCallContent("outer", "generate_a2ui", null)]), new(ChatRole.Assistant, [new FunctionCallContent("inner", "render_a2ui", null)])];
        if (scenario == "ordinary") { source.Add(new ChatMessage(ChatRole.User, "Do not move this")); }
        source.Add(new ChatMessage(ChatRole.Tool, [new FunctionResultContent("inner", "rendered")]));
        if (scenario != "missing") { source.Add(new ChatMessage(ChatRole.Tool, [new FunctionResultContent(scenario == "foreign" ? "foreign" : scenario == "duplicate" ? "inner" : "outer", "answer")])); }
        Assert.Equal(source, A2UIHistoryNormalizer.Normalize(source, "generate_a2ui"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task UpdateAfterNestedGeneration_FindsLaterResultInCombinedToolMessageAsync(bool cold)
    {
        using var creator = new A2UIChatClient(new Planner(), new Renderer(), new A2UIChatClientOptions { InjectA2UITool = true });
        ChatResponse created = await creator.GetResponseAsync([new ChatMessage(ChatRole.User, "Create card")]);
        List<ChatMessage> history = created.Messages.ToList();
        Assert.Contains(history, m => m.Contents.OfType<FunctionResultContent>().Count() > 1);
        var typeInfo = (JsonTypeInfo<List<ChatMessage>>)AIJsonUtilities.DefaultOptions.GetTypeInfo(typeof(List<ChatMessage>));
        if (cold) { history = JsonSerializer.Deserialize(JsonSerializer.Serialize(history, typeInfo), typeInfo)!; }
        string before = JsonSerializer.Serialize(history, typeInfo);
        using var updater = new A2UIChatClient(new UpdatePlanner(), new Renderer(), new A2UIChatClientOptions { InjectA2UITool = true });
        ChatResponse updated = await updater.GetResponseAsync(history);
        var result = Assert.Single(updated.Messages.SelectMany(m => m.Contents).OfType<FunctionResultContent>(), r => r.CallId == "update");
        JsonElement envelope = Assert.IsType<JsonElement>(result.Result);
        Assert.True(envelope.TryGetProperty("a2ui_operations", out JsonElement operations), envelope.GetRawText());
        Assert.DoesNotContain(operations.EnumerateArray(), operation => operation.TryGetProperty("createSurface", out _));
        Assert.Contains(operations.EnumerateArray(), operation => operation.TryGetProperty("updateComponents", out JsonElement update) && update.GetProperty("surfaceId").GetString() == "card");
        Assert.Equal(before, JsonSerializer.Serialize(history, typeInfo));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task LaterDeleteInSameToolMessage_DoesNotResurrectEarlierSurfaceAsync(bool deleteAsText)
    {
        using var create = JsonDocument.Parse("""{"a2ui_operations":[{"createSurface":{"surfaceId":"card","catalogId":"catalog"}},{"updateComponents":{"surfaceId":"card","components":[{"id":"root","component":"Text","text":"old"}]}}]}""");
        using var delete = JsonDocument.Parse("""{"a2ui_operations":[{"deleteSurface":{"surfaceId":"card"}}]}""");
        List<ChatMessage> history =
        [
            new(ChatRole.Assistant, [new FunctionCallContent("ack", "render_a2ui", null), new FunctionCallContent("create", "generate_a2ui", null), new FunctionCallContent("delete", "generate_a2ui", null)]),
            new(ChatRole.Tool, [new FunctionResultContent("ack", "rendered"), new FunctionResultContent("create", create.RootElement.Clone()), new FunctionResultContent("delete", delete.RootElement.Clone())]),
        ];
        if (deleteAsText)
        {
            history[0].Contents.RemoveAt(2);
            history[1].Contents[2] = new TextContent(delete.RootElement.GetRawText());
        }
        using var updater = new A2UIChatClient(new UpdatePlanner(), new Renderer(), new A2UIChatClientOptions { InjectA2UITool = true });
        ChatResponse updated = await updater.GetResponseAsync(history);
        Assert.DoesNotContain(updated.Messages.SelectMany(m => m.Contents).OfType<FunctionCallContent>(), c => c.Name == "render_a2ui");
        var result = Assert.Single(updated.Messages.SelectMany(m => m.Contents).OfType<FunctionResultContent>(), r => r.CallId == "update");
        Assert.Contains("no prior render", Assert.IsType<JsonElement>(result.Result).GetRawText(), StringComparison.Ordinal);
    }

    private sealed class UpdatePlanner : IChatClient
    {
        private bool _called;
        public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            await Task.CompletedTask.ConfigureAwait(false);
            Validate(messages);
            if (!this._called)
            {
                this._called = true;
                yield return new ChatResponseUpdate(ChatRole.Assistant, [new FunctionCallContent("update", "generate_a2ui", new Dictionary<string, object?> { ["intent"] = "update", ["target_surface_id"] = "card", ["changes"] = "Update existing card" })]) { MessageId = "update-message" };
            }
            else { yield return new ChatResponseUpdate(ChatRole.Assistant, "Updated") { MessageId = "update-done" }; }
        }
        public Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public object? GetService(Type serviceType, object? serviceKey = null) => null;
        public void Dispose() { }
    }

    private static void Validate(IEnumerable<ChatMessage> messages)
    {
        HashSet<string> pending = [];
        foreach (ChatMessage message in messages)
        {
            if (message.Role != ChatRole.Tool && pending.Count != 0)
            {
                throw new InvalidOperationException("Assistant tool calls must receive results before another message.");
            }
            foreach (AIContent content in message.Contents)
            {
                if (content is FunctionCallContent call) { Assert.True(pending.Add(call.CallId)); }
                if (content is FunctionResultContent result) { Assert.True(pending.Remove(result.CallId)); }
            }
        }
        Assert.Empty(pending);
    }

    private sealed class Planner : IChatClient
    {
        private int _round;
        public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            await Task.CompletedTask.ConfigureAwait(false);
            Validate(messages);
            if (this._round++ == 0)
            {
                yield return new ChatResponseUpdate(ChatRole.Assistant, [new FunctionCallContent("outer", "generate_a2ui", new Dictionary<string, object?> { ["intent"] = "create", ["changes"] = "Create card" })]) { MessageId = "planner-message" };
            }
            else { yield return new ChatResponseUpdate(ChatRole.Assistant, "Done") { MessageId = "planner-done" }; }
        }
        public Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public object? GetService(Type serviceType, object? serviceKey = null) => null;
        public void Dispose() { }
    }

    private sealed class Renderer : IChatClient
    {
        public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            await Task.CompletedTask.ConfigureAwait(false);
            yield return new ChatResponseUpdate(ChatRole.Assistant, [new FunctionCallContent("inner", "render_a2ui", new Dictionary<string, object?>
            {
                ["surfaceId"] = "card", ["components"] = new object[] { new Dictionary<string, object?> { ["id"] = "root", ["component"] = "Text", ["text"] = "Card" } },
            })]) { MessageId = "renderer-message" };
        }
        public Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public object? GetService(Type serviceType, object? serviceKey = null) => null;
        public void Dispose() { }
    }
}
