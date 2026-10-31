using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.A2UI.UnitTests;

public sealed class A2UIRequestInstructionsTest
{
    [Fact]
    public async Task SiblingCreatesAndRetry_ReceiveTheirOwnInstructionsAsync()
    {
        string[] instructions = ["Create North with value 11", "Create South with value 22", "Retry South with value 22"];
        FunctionCallContent Generate(int index) => new($"gen-{index}", "generate_a2ui",
            new Dictionary<string, object?> { ["intent"] = "create", ["changes"] = instructions[index] });
        var planner = new ScriptedClient((round, _) => round switch
        {
            1 => [new(ChatRole.Assistant, [Generate(0), Generate(1)]) { MessageId = "siblings" }],
            2 => [new(ChatRole.Assistant, [Generate(2)])],
            _ => [new(ChatRole.Assistant, "done")],
        });
        var renderer = new ScriptedClient((round, _) => [new(ChatRole.Assistant,
            [new FunctionCallContent($"render-{round}", "render_a2ui", new Dictionary<string, object?>
            {
                ["surfaceId"] = $"surface-{round}",
                ["components"] = JsonDocument.Parse("""[{"id":"root","component":"Text","text":"hello"}]""").RootElement.Clone(),
            })])]);
        using var client = new A2UIChatClient(planner, renderer, new A2UIChatClientOptions { InjectA2UITool = true });

        var response = await client.GetResponseAsync([new(ChatRole.User, "Create the two requested cards")]);

        Assert.Equal(3, renderer.Calls);
        for (int index = 0; index < instructions.Length; index++)
        {
            var input = renderer.Inputs[index];
            string prompt = Assert.Single(input, message => message.Role == ChatRole.System).Text;
            Assert.Contains(instructions[index], prompt);
            foreach (string sibling in instructions.Where(value => value != instructions[index]))
            {
                Assert.DoesNotContain(sibling, prompt);
            }

            // The current generator call must not be restored as an unanswered provider call.
            var results = input.SelectMany(message => message.Contents).OfType<FunctionResultContent>().Select(result => result.CallId).ToHashSet();
            Assert.All(input.SelectMany(message => message.Contents).OfType<FunctionCallContent>(), call => Assert.Contains(call.CallId, results));
        }

        var completed = response.Messages.SelectMany(message => message.Contents).OfType<FunctionResultContent>().ToList();
        Assert.Equal(6, completed.Count);
        Assert.Equal(6, completed.Select(result => result.CallId).Distinct().Count());
    }

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
