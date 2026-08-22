using System.Runtime.CompilerServices;
using AGUI.Abstractions;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Server.IntegrationTests;

public sealed class RunLifecycleIntegrationTest : IntegrationTestBase
{
    public RunLifecycleIntegrationTest(WebApplicationFactory<Program> factory)
        : base(factory)
    {
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task PostRun_EmptyStream_AutoGeneratesRunLifecycleEvents(TransportFormat format)
    {
        var client = CreateClient((messages, options, ct) => EmitEmptyResponse(ct), format);

        var updates = await CollectUpdates(client, [new ChatMessage(ChatRole.User, "Hi")]);

        Assert.Collection(updates,
            u =>
            {
                Assert.Equal(ChatRole.Assistant, u.Role);
                // Stateless: no ConversationId (issue #4869); the thread id is surfaced via
                // AdditionalProperties, and ResponseId carries the run id.
                Assert.Null(u.ConversationId);
                Assert.NotNull(u.ResponseId);
                var started = Assert.IsType<RunStartedEvent>(u.RawRepresentation);
                Assert.Equal(started.ThreadId, u.AdditionalProperties?["agui_thread_id"]);
                Assert.Equal(u.ResponseId, started.RunId);
            },
            u =>
            {
                Assert.Equal(ChatRole.Assistant, u.Role);
                Assert.Null(u.ConversationId);
                Assert.Equal(ChatFinishReason.Stop, u.FinishReason);
                var finished = Assert.IsType<RunFinishedEvent>(u.RawRepresentation);
                Assert.Equal(u.ResponseId, finished.RunId);
            });
    }

    [Theory]
    [InlineData(TransportFormat.Json, false)]
    [InlineData(TransportFormat.Json, true)]
    [InlineData(TransportFormat.Protobuf, false)]
    [InlineData(TransportFormat.Protobuf, true)]
    public async Task PostRun_StreamThrowsAfterUpdate_EmitsSanitizedRunErrorWithoutRunFinished(
        TransportFormat format,
        bool yieldThread)
    {
        var client = CreateClient((messages, options, ct) => EmitUpdateThenThrow(yieldThread, ct), format);

        var updates = await CollectUpdates(client, [new ChatMessage(ChatRole.User, "Hi")]);

        Assert.Collection(updates,
            u => Assert.IsType<RunStartedEvent>(u.RawRepresentation),
            u =>
            {
                Assert.Equal("partial", u.Text);
                Assert.IsType<TextMessageContentEvent>(u.RawRepresentation);
            },
            u =>
            {
                var content = Assert.IsType<ErrorContent>(Assert.Single(u.Contents));
                Assert.Equal("StreamingError", content.ErrorCode);
                Assert.Equal("An error occurred while streaming the agent response.", content.Message);
                Assert.IsType<RunErrorEvent>(u.RawRepresentation);
            });
        Assert.DoesNotContain(updates, u => u.RawRepresentation is RunFinishedEvent);
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> EmitUpdateThenThrow(
        bool yieldThread,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        yield return new ChatResponseUpdate(ChatRole.Assistant, "partial");
        if (yieldThread)
        {
            await Task.Yield();
        }

        throw new InvalidOperationException("sensitive provider failure details");
    }
}
