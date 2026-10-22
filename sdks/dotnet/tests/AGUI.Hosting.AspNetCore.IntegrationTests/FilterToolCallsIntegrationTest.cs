using System.Runtime.CompilerServices;
using System.Text.Json;
using AGUI.Abstractions;
using AGUI.Client;
using AGUI.Formatting;
using AGUI.Protobuf;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace AGUI.Server.IntegrationTests;

public sealed class FilterToolCallsIntegrationTest : IntegrationTestBase
{
    internal const string HiddenToolName = "lookup_customer_record";
    private const string VisibleToolName = "get_weather";
    private const string SecretArgument = "ssn-123-45-6789";
    private const string SecretResult = "customer-tier-platinum";

    public FilterToolCallsIntegrationTest(WebApplicationFactory<Program> factory)
        : base(factory)
    {
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task HiddenServerTool_RunsOnServer_ButNothingAboutItReachesTheWire(TransportFormat format)
    {
        var hiddenToolRan = false;
        var hiddenTool = AIFunctionFactory.Create(
            (string ssn) => { hiddenToolRan = ssn == SecretArgument; return SecretResult; },
            HiddenToolName,
            "Looks up the customer's record.");
        var visibleTool = AIFunctionFactory.Create(() => "sunny", VisibleToolName, "Gets the weather.");

        var transport = CreateTransport(format, [hiddenTool, visibleTool], EmitTurn);

        var events = new List<BaseEvent>();
        await foreach (var evt in transport.SendAsync(
            new RunAgentInput
            {
                ThreadId = "thread-1",
                RunId = "run-1",
                Messages = [new AGUIUserMessage { Id = "u1", Content = "Am I a gold customer, and how is the weather?" }],
            },
            CancellationToken.None))
        {
            events.Add(evt);
        }

        Assert.True(hiddenToolRan, "The hidden server tool should still run on the server.");

        foreach (var evt in events)
        {
            var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.BaseEvent);
            Assert.DoesNotContain(HiddenToolName, json, StringComparison.Ordinal);
            Assert.DoesNotContain(SecretArgument, json, StringComparison.Ordinal);
            Assert.DoesNotContain(SecretResult, json, StringComparison.Ordinal);
        }

        Assert.Contains(events, e => e is ToolCallStartEvent { ToolCallName: VisibleToolName });
        Assert.Contains(events, e => e is ToolCallResultEvent { ToolCallId: "call-visible" });
        Assert.Contains(events, e => e is TextMessageContentEvent { Delta: "You are a gold customer and it is sunny." });
        Assert.IsType<RunFinishedEvent>(events[^1]);
    }

    // First model turn: text plus both tool calls in one update, so the text event's raw data
    // carries the hidden call. Second turn (after function invocation): the final answer.
    private static async IAsyncEnumerable<ChatResponseUpdate> EmitTurn(
        IEnumerable<ChatMessage> messages,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        if (messages.Any(m => m.Contents.OfType<FunctionResultContent>().Any()))
        {
            yield return new ChatResponseUpdate
            {
                Role = ChatRole.Assistant,
                MessageId = "msg-2",
                Contents = [new TextContent("You are a gold customer and it is sunny.")],
            };
        }
        else
        {
            yield return new ChatResponseUpdate
            {
                Role = ChatRole.Assistant,
                MessageId = "msg-1",
                Contents =
                [
                    new TextContent("Let me check."),
                    new FunctionCallContent("call-hidden", HiddenToolName, new Dictionary<string, object?> { ["ssn"] = SecretArgument }),
                    new FunctionCallContent("call-visible", VisibleToolName),
                ],
                FinishReason = ChatFinishReason.ToolCalls,
            };
        }

        await Task.CompletedTask.ConfigureAwait(false);
    }

    private AGUIHttpTransport CreateTransport(
        TransportFormat format,
        AITool[] serverTools,
        Func<IEnumerable<ChatMessage>, CancellationToken, IAsyncEnumerable<ChatResponseUpdate>> handler)
    {
        var factory = Factory.WithWebHostBuilder(builder =>
        {
            builder.ConfigureTestServices(services =>
            {
                services.AddSingleton(_ =>
                {
                    var client = new DelegatingStreamingChatClient();
                    client.SetHandler((messages, _, ct) => handler(messages, ct));
                    return client;
                });

                foreach (var tool in serverTools)
                {
                    services.AddSingleton(tool);
                }
            });
        });

        var httpClient = format == TransportFormat.Protobuf
            ? factory.CreateDefaultClient(new AGUIEventStreamHandler(
                new IAGUIEventStreamFormatter[] { new ProtobufEventStreamFormatter(), new SseEventStreamFormatter() }))
            : factory.CreateClient();

        return new AGUIHttpTransport(httpClient, "/agui-filtered");
    }
}
