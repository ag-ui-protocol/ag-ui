using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.A2UI.UnitTests;

public sealed class A2UIHistoryTest
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ColdHistory_ProvidesAdjacentResultsWithoutChangingTranscriptAsync(bool inject)
    {
        var history = History();
        var typeInfo = (System.Text.Json.Serialization.Metadata.JsonTypeInfo<List<ChatMessage>>)AIJsonUtilities.DefaultOptions.GetTypeInfo(typeof(List<ChatMessage>));
        history = JsonSerializer.Deserialize(JsonSerializer.Serialize(history, typeInfo), typeInfo)!;
        var originalMessages = history.ToArray();
        var originalContents = history.Select(m => m.Contents.ToArray()).ToArray();
        var planner = new RecordingClient();
        using var client = new A2UIChatClient(planner, planner, new() { InjectA2UITool = inject });
        await client.GetResponseAsync(history);
        AssertProviderSequence(planner.Messages);
        Assert.Equal(new[] { "parent", "child-1", "child-2" }, planner.Messages.SelectMany(m => m.Contents).OfType<FunctionResultContent>().Select(r => r.CallId));
        Assert.Equal(originalMessages, history);
        for (int i = 0; i < history.Count; i++)
        {
            Assert.Equal(originalContents[i], history[i].Contents);
        }
        var original = history.SelectMany(m => m.Contents).ToList();
        var projected = planner.Messages.SelectMany(m => m.Contents).ToList();
        Assert.Equal(original.Count, projected.Count);
        Assert.All(original, content => Assert.Contains(content, projected));
        // Repeated continuation is idempotent.
        var once = planner.Messages;
        await client.GetResponseAsync(once);
        Assert.Equal(once, planner.Messages);
    }

    [Theory]
    [InlineData("legacy")]
    [InlineData("wrong-parent")]
    [InlineData("missing-result")]
    [InlineData("user-boundary")]
    [InlineData("unanswered-child")]
    [InlineData("duplicate-result")]
    public async Task UnprovenHistory_IsNotReorderedAsync(string scenario)
    {
        var history = History();
        var child = (FunctionCallContent)history[2].Contents[0];
        if (scenario == "legacy")
        {
            child.AdditionalProperties = null;
        }
        else if (scenario == "wrong-parent")
        {
            child.AdditionalProperties!["ag_ui_parent_tool_call_id"] = "other";
        }
        else if (scenario == "missing-result")
        {
            history[5].Contents.RemoveAt(1);
        }
        else if (scenario == "unanswered-child")
        {
            history.RemoveAt(3);
        }
        else if (scenario == "duplicate-result")
        {
            history[3].Contents.Add(new FunctionResultContent("child-1", "duplicate"));
        }
        else
        {
            history.Insert(3, new ChatMessage(ChatRole.User, "boundary"));
        }
        var planner = new RecordingClient();
        using var client = new A2UIChatClient(planner, planner);
        await client.GetResponseAsync(history);
        Assert.Equal(history, planner.Messages);
    }

    [Fact]
    public async Task MultipleGenerators_PreserveBothResultsAndTheirChildrenAsync()
    {
        var history = History();
        history[1].Contents.Add(new FunctionCallContent("parent-2", "generate_a2ui", new Dictionary<string, object?> { ["intent"] = "create" }));
        var secondChild = (FunctionCallContent)history[4].Contents[0];
        secondChild.AdditionalProperties!["ag_ui_parent_tool_call_id"] = "parent-2";
        history[3].Contents.Add(new FunctionResultContent("parent", "first envelope"));
        history[5].Contents[1] = new FunctionResultContent("parent-2", "second envelope");
        history[5].MessageId = "result-message";
        history[5].AdditionalProperties = new() { ["source"] = "native" };
        var planner = new RecordingClient();
        using var client = new A2UIChatClient(planner, planner);

        await client.GetResponseAsync(history);

        AssertProviderSequence(planner.Messages);
        Assert.Equal(new[] { "parent", "parent-2", "child-1", "child-2" }, planner.Messages.SelectMany(m => m.Contents).OfType<FunctionResultContent>().Select(r => r.CallId));
        Assert.Equal(2, planner.Messages.Count(m => m.MessageId == "result-message"));
        Assert.All(planner.Messages.Where(m => m.MessageId == "result-message"), m => Assert.Equal("native", m.AdditionalProperties!["source"]));
        Assert.Equal(new[] { "child-1", "parent", "child-2", "parent-2" }, history.SelectMany(m => m.Contents).OfType<FunctionResultContent>().Select(r => r.CallId));
    }

    private static List<ChatMessage> History() =>
    [
        new(ChatRole.User, "card"),
        new(ChatRole.Assistant, [new FunctionCallContent("parent", "generate_a2ui", new Dictionary<string, object?> { ["intent"] = "create" })]),
        new(ChatRole.Assistant, [Child("child-1")]),
        new(ChatRole.Tool, [new FunctionResultContent("child-1", "first")]),
        new(ChatRole.Assistant, [Child("child-2")]),
        new(ChatRole.Tool, [new FunctionResultContent("child-2", "second"), new FunctionResultContent("parent", "canonical envelope")]),
        new(ChatRole.Assistant, "done"),
        new(ChatRole.User, "follow up"),
    ];

    private static FunctionCallContent Child(string id) => new(id, "render_a2ui", new Dictionary<string, object?> { ["surfaceId"] = "same" })
    {
        AdditionalProperties = new() { ["ag_ui_parent_tool_call_id"] = "parent" },
    };

    private static void AssertProviderSequence(IReadOnlyList<ChatMessage> messages)
    {
        var pending = new HashSet<string>();
        foreach (var message in messages)
        {
            if (message.Role != ChatRole.Tool)
            {
                Assert.Empty(pending);
            }
            foreach (var call in message.Contents.OfType<FunctionCallContent>())
            {
                Assert.True(pending.Add(call.CallId));
            }
            foreach (var result in message.Contents.OfType<FunctionResultContent>())
            {
                Assert.True(pending.Remove(result.CallId));
            }
        }
        Assert.Empty(pending);
    }

    private sealed class RecordingClient : IChatClient
    {
        public IReadOnlyList<ChatMessage> Messages { get; private set; } = [];
        public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            await Task.CompletedTask.ConfigureAwait(false);
            Messages = messages.ToList();
            yield return new(ChatRole.Assistant, "ok");
        }
        public Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public object? GetService(Type serviceType, object? serviceKey = null) => null;
        public void Dispose() { }
    }
}
