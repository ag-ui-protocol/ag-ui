using System.Runtime.CompilerServices;
using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Server.UnitTests;

public sealed class ChatClientAGUIExtensionsTest
{
    private static readonly JsonSerializerOptions SerializerOptions = AIJsonUtilities.DefaultOptions;

    [Fact]
    public async Task AsAGUIRunDelegate_StreamsTheChatClientResponseAsEvents()
    {
        using var chatClient = new RecordingChatClient("Hi there");
        var run = chatClient.AsAGUIRunDelegate(SerializerOptions);

        var events = await Collect(run(Input("hello"), default));

        Assert.Equal("hello", chatClient.ReceivedMessages[^1].Text);
        Assert.Equal("run-1", Assert.IsType<RunStartedEvent>(events[0]).RunId);
        Assert.Contains(events, e => e is TextMessageContentEvent { Delta: "Hi there" });
        Assert.IsType<RunFinishedEvent>(events[^1]);
    }

    [Fact]
    public async Task AsAGUIRunDelegate_AsTerminal_ModelSeesRewrittenInput()
    {
        using var chatClient = new RecordingChatClient("ok");
        var run = new AGUIMiddlewarePipeline()
            .Use((input, next, ct) => next(Input("rewritten"), ct))
            .Build(chatClient.AsAGUIRunDelegate(SerializerOptions));

        await Collect(run(Input("original"), default));

        Assert.Equal("rewritten", chatClient.ReceivedMessages[^1].Text);
    }

    [Fact]
    public void AsAGUIRunDelegate_NullArguments_Throw()
    {
        using var chatClient = new RecordingChatClient("ok");

        Assert.Throws<ArgumentNullException>(() => ((IChatClient)null!).AsAGUIRunDelegate(SerializerOptions));
        Assert.Throws<ArgumentNullException>(() => chatClient.AsAGUIRunDelegate(null!));
    }

    private static RunAgentInput Input(string text) => new()
    {
        ThreadId = "thread-1",
        RunId = "run-1",
        Messages = [new AGUIUserMessage { Id = "user-1", Content = text }],
    };

    private static async Task<List<BaseEvent>> Collect(IAsyncEnumerable<BaseEvent> events)
    {
        var list = new List<BaseEvent>();
        await foreach (var evt in events.ConfigureAwait(false))
        {
            list.Add(evt);
        }

        return list;
    }

    private sealed class RecordingChatClient(string reply) : IChatClient
    {
        public List<ChatMessage> ReceivedMessages { get; } = [];

        public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
            IEnumerable<ChatMessage> messages,
            ChatOptions? options = null,
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            ReceivedMessages.AddRange(messages);
            yield return new ChatResponseUpdate(ChatRole.Assistant, reply) { MessageId = "msg-1" };
            await Task.CompletedTask.ConfigureAwait(false);
        }

        public Task<ChatResponse> GetResponseAsync(
            IEnumerable<ChatMessage> messages,
            ChatOptions? options = null,
            CancellationToken cancellationToken = default) => throw new NotSupportedException();

        public object? GetService(Type serviceType, object? serviceKey = null) => null;

        public void Dispose()
        {
        }
    }
}
