#pragma warning disable MEAI001 // RequiresConfirmation distinguishes an internal declaration from a protected tool.
using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.A2UI.UnitTests;

public sealed class A2UIChatClientApprovalTest
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task MixedBatch_GeneratesOnceAndResumesOnlyPendingFunctionsAsync(bool approved)
    {
        int executions = 0;
        var planner = new ScriptedClient((round, _) => round == 1
            ? [new(ChatRole.Assistant, [Call("pie", "pieChart"), Call("gen", "generate_a2ui"), Call("flight", "search_flights"), Call("bar", "barChart")]) { MessageId = "parallel" }]
            : [new(ChatRole.Assistant, "done")]);
        var renderer = CreateRenderer();
        using var client = new A2UIChatClient(new FunctionInvokingChatClient(planner), renderer,
            new A2UIChatClientOptions { InjectA2UITool = true });
        var options = new ChatOptions
        {
            Tools = new[] { "pieChart", "search_flights", "barChart" }
                .Select(name => (AITool)new ApprovalRequiredAIFunction(AIFunctionFactory.Create(() => ++executions, name))).ToList(),
        };
        List<ChatMessage> history = [new(ChatRole.User, "three charts and a dashboard")];

        var initial = await client.GetResponseAsync(history, options);
        var requests = initial.Messages.SelectMany(m => m.Contents).OfType<ToolApprovalRequestContent>().ToList();
        Assert.Equal(3, requests.Count);
        Assert.DoesNotContain(requests, r => r.ToolCall.CallId == "gen");
        Assert.Equal(new[] { "render", "gen" }, initial.Messages.SelectMany(m => m.Contents).OfType<FunctionResultContent>().Select(r => r.CallId));
        Assert.Equal(1, planner.Calls);
        Assert.Equal(1, renderer.Calls);
        Assert.Equal(0, executions);

        history.AddRange(initial.Messages);
        history.Add(new(ChatRole.User, requests.Select(r => (AIContent)r.CreateResponse(approved)).ToList()));
        var resumed = await client.GetResponseAsync(history, options);
        Assert.Equal(approved ? 3 : 0, executions);
        Assert.Equal(1, renderer.Calls);
        Assert.Equal(2, planner.Calls);
        Assert.Equal(new[] { "bar", "flight", "pie" }, resumed.Messages.SelectMany(m => m.Contents)
            .OfType<FunctionResultContent>().Select(r => r.CallId).Order());
        Assert.DoesNotContain(resumed.Messages.SelectMany(m => m.Contents), c => c is ToolApprovalRequestContent);
        var generatorResults = planner.Inputs.Last().SelectMany(m => m.Contents).OfType<FunctionResultContent>().Where(r => r.CallId == "gen");
        Assert.Single(generatorResults);
    }

    [Fact]
    public async Task RepeatedGeneratorCallId_ExecutesOnceAsync()
    {
        var planner = new ScriptedClient((round, _) => round == 1
            ? [new(ChatRole.Assistant, [Call("gen", "generate_a2ui"), Call("gen", "generate_a2ui")])]
            : [new(ChatRole.Assistant, "done")]);
        var renderer = CreateRenderer();
        using var client = new A2UIChatClient(planner, renderer, new A2UIChatClientOptions { InjectA2UITool = true });
        var response = await client.GetResponseAsync([new(ChatRole.User, "generate")]);
        Assert.Equal(1, renderer.Calls);
        Assert.Single(response.Messages.SelectMany(m => m.Contents).OfType<FunctionResultContent>(), r => r.CallId == "gen");
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task NonExecutableGenerator_IsNotRegeneratedAsync(bool informational)
    {
        var call = Call("gen", "generate_a2ui");
        call.InformationalOnly = informational;
        List<AIContent> contents = [call];
        if (!informational)
        {
            contents.Add(new FunctionResultContent("gen", "already completed"));
        }
        var planner = new ScriptedClient((round, _) => round == 1 ? [new(ChatRole.Assistant, contents)] : [new(ChatRole.Assistant, "done")]);
        var renderer = CreateRenderer();
        using var client = new A2UIChatClient(planner, renderer, new A2UIChatClientOptions { InjectA2UITool = true });

        await client.GetResponseAsync([new(ChatRole.User, "continue")]);

        Assert.Equal(0, renderer.Calls);
        Assert.Equal(1, planner.Calls);
    }

    [Fact]
    public async Task PreviouslyCompletedGenerator_IsNotRegeneratedAsync()
    {
        var planner = new ScriptedClient((round, _) => round == 1
            ? [new(ChatRole.Assistant, [Call("gen", "generate_a2ui")])]
            : [new(ChatRole.Assistant, "done")]);
        var renderer = CreateRenderer();
        using var client = new A2UIChatClient(planner, renderer, new A2UIChatClientOptions { InjectA2UITool = true });
        await client.GetResponseAsync([new(ChatRole.Assistant, [Call("gen", "generate_a2ui")]), new(ChatRole.Tool, [new FunctionResultContent("gen", "saved")])]);
        Assert.Equal(0, renderer.Calls);
    }

    [Fact]
    public async Task OwnedRequest_IsCopiedWithoutMutatingInnerUpdateAsync()
    {
        var request = new ToolApprovalRequestContent("owned", Call("gen", "generate_a2ui")) { RequiresConfirmation = false };
        var original = new ChatResponseUpdate(ChatRole.Assistant, [request]) { MessageId = "owned-message", AdditionalProperties = new() { ["provider"] = "retained" } };
        var planner = new ScriptedClient((round, _) => round == 1 ? [original] : [new(ChatRole.Assistant, "done")]);
        var renderer = CreateRenderer();
        using var client = new A2UIChatClient(planner, renderer, new A2UIChatClientOptions { InjectA2UITool = true });
        var updates = new List<ChatResponseUpdate>();
        await foreach (var update in client.GetStreamingResponseAsync([new(ChatRole.User, "generate")]))
        {
            updates.Add(update);
        }
        Assert.Same(request, Assert.Single(original.Contents));
        var owned = Assert.Single(updates, u => u.MessageId == "owned-message");
        Assert.NotSame(original, owned);
        Assert.IsType<FunctionCallContent>(Assert.Single(owned.Contents));
        Assert.Equal("retained", owned.AdditionalProperties!["provider"]);
        Assert.Equal(1, renderer.Calls);
    }

    [Theory]
    [InlineData("generate_a2ui", null)]
    [InlineData("generate_a2ui", true)]
    [InlineData("other_tool", false)]
    public async Task UnownedOrConfirmingRequest_RemainsPendingAsync(string name, bool? requiresConfirmation)
    {
        var request = new ToolApprovalRequestContent("pending", Call("pending", name));
        if (requiresConfirmation.HasValue)
        {
            request.RequiresConfirmation = requiresConfirmation.Value;
        }
        var planner = new ScriptedClient((_, _) => [new(ChatRole.Assistant, [request])]);
        var renderer = CreateRenderer();
        using var client = new A2UIChatClient(planner, renderer, new A2UIChatClientOptions { InjectA2UITool = true });
        var response = await client.GetResponseAsync([new(ChatRole.User, "pending")]);
        Assert.Same(request, Assert.Single(response.Messages.SelectMany(m => m.Contents)));
        Assert.Equal(0, renderer.Calls);
        Assert.Equal(1, planner.Calls);
    }

    private static FunctionCallContent Call(string id, string name) => new(id, name, new Dictionary<string, object?> { ["intent"] = "create" });

    private static ScriptedClient CreateRenderer() => new((_, _) => [new(ChatRole.Assistant,
        [new FunctionCallContent("render", "render_a2ui", new Dictionary<string, object?>
        {
            ["surfaceId"] = "dashboard",
            ["components"] = JsonDocument.Parse("""[{"id":"root","component":"Text","text":"hello"}]""").RootElement.Clone(),
        })])]);

    private sealed class ScriptedClient(Func<int, IReadOnlyList<ChatMessage>, IEnumerable<ChatResponseUpdate>> script) : IChatClient
    {
        public int Calls { get; private set; }
        public List<IReadOnlyList<ChatMessage>> Inputs { get; } = [];

        public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(IEnumerable<ChatMessage> messages,
            ChatOptions? options = null, [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            await Task.CompletedTask.ConfigureAwait(false);
            var input = messages.ToList();
            Inputs.Add(input);
            foreach (var update in script(++Calls, input))
            {
                yield return update;
            }
        }

        public Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default) =>
            GetStreamingResponseAsync(messages, options, cancellationToken).ToChatResponseAsync(cancellationToken);
        public object? GetService(Type serviceType, object? serviceKey = null) => serviceType.IsInstanceOfType(this) ? this : null;
        public void Dispose() { }
    }
}
