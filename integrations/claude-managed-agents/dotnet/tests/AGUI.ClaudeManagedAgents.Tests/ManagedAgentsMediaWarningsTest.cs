using System.Diagnostics;
using System.Globalization;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.ClaudeManagedAgents.Tests;

/// <summary>
/// Trace listeners are process-wide, so the tests that capture warnings run outside xunit's
/// parallelization and never see another test's output.
/// </summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class TraceCaptureCollection
{
    public const string Name = "TraceCapture";
}

[Collection(TraceCaptureCollection.Name)]
public sealed class ManagedAgentsMediaWarningsTest
{
    private const string IdleEndTurn =
        """{"type":"session.status_idle","id":"idle_1","stop_reason":{"type":"end_turn"}}""";

    private const string SessionKey = "7:agent_1|0:|5:env_1|0:|thread_1";

    private const string Prefix = "[claude-managed-agents]";

    private static ManagedAgentsAgent NewAgent(FakeManagedAgentsClient fake, ISessionStore? store = null) =>
        new(new ManagedAgentsAgentOptions
        {
            ManagedAgentId = "agent_1",
            EnvironmentId = "env_1",
            Client = fake,
            SessionStore = store,
        });

    private static async Task CollectAsync(ManagedAgentsAgent agent, RunAgentInput input)
    {
        await foreach (var _ in agent.RunAsync(input))
        {
        }
    }

    private static async Task<List<string>> CaptureWarningsAsync(Func<Task> action)
    {
        var warnings = new List<string>();
        var listener = new WarningListener(warnings);
        Trace.Listeners.Add(listener);
        try
        {
            await action();
        }
        finally
        {
            Trace.Listeners.Remove(listener);
        }

        return warnings;
    }

    [Fact]
    public async Task WarnsOnceWhenUserMessageMediaIsDroppedAndStillSendsTheText()
    {
        var fake = new FakeManagedAgentsClient([IdleEndTurn]);
        var input = new RunAgentInput
        {
            ThreadId = "thread_1",
            RunId = "run_1",
            Messages =
            [
                new AGUIUserMessage
                {
                    Id = "u1",
                    Content =
                    [
                        new AGUITextInputContent { Text = "Look here" },
                        new AGUIImageInputContent { Source = new AGUIInputContentUrlSource { Value = "https://x/y.png" } },
                    ],
                },
            ],
            Tools = [],
        };

        var warnings = await CaptureWarningsAsync(() => CollectAsync(NewAgent(fake), input));

        var sent = Assert.Single(fake.Sent[0]);
        Assert.Equal("Look here", sent.GetProperty("content")[0].GetProperty("text").GetString());
        Assert.Equal(
            [$"{Prefix} Dropping image user-message content: this adapter forwards only text to a managed session"],
            warnings.Where(static w => w.StartsWith(Prefix, StringComparison.Ordinal)));
    }

    [Fact]
    public async Task WarnsForEachNonTextToolResultPartItFlattensAway()
    {
        var fake = new FakeManagedAgentsClient([IdleEndTurn]);
        var store = new InMemorySessionStore();
        await store.SetAsync(
            SessionKey,
            new ManagedAgentsSessionRecord
            {
                SessionId = "sesn_1",
                ToolNames = [],
                PendingClientToolUseIds = ["ctu_1"],
                LastUserMessageId = "u1",
            },
            CancellationToken.None);
        var input = new RunAgentInput
        {
            ThreadId = "thread_1",
            RunId = "run_1",
            Messages =
            [
                new AGUIUserMessage { Id = "u1", Content = "Hello" },
                new AGUIToolMessage
                {
                    Id = "t1",
                    ToolCallId = "ctu_1",
                    Content =
                    [
                        new AGUITextInputContent { Text = "Invoice attached." },
                        new AGUIDocumentInputContent { Source = new AGUIInputContentFileSource { Value = "file_abc123" } },
                        new AGUIAudioInputContent { Source = new AGUIInputContentUrlSource { Value = "https://example.com/a.wav" } },
                    ],
                },
            ],
            Tools = [],
        };

        var warnings = await CaptureWarningsAsync(() => CollectAsync(NewAgent(fake, store), input));

        var json = Assert.Single(fake.Sent[0]).GetRawText();
        Assert.Contains("Invoice attached.", json, StringComparison.Ordinal);
        // The provider file handle never reaches the session.
        Assert.DoesNotContain("file_abc123", json, StringComparison.Ordinal);
        Assert.Equal(
            [
                $"{Prefix} Dropping document tool-result content: this adapter forwards tool results as text only",
                $"{Prefix} Dropping audio tool-result content: this adapter forwards tool results as text only",
            ],
            warnings.Where(static w => w.StartsWith(Prefix, StringComparison.Ordinal)));
    }

    [Fact]
    public async Task TextOnlyContentLogsNoWarning()
    {
        var fake = new FakeManagedAgentsClient([IdleEndTurn]);
        var input = new RunAgentInput
        {
            ThreadId = "thread_1",
            RunId = "run_1",
            Messages =
            [
                new AGUIUserMessage
                {
                    Id = "u1",
                    Content = [new AGUITextInputContent { Text = "Hello" }],
                },
            ],
            Tools = [],
        };

        var warnings = await CaptureWarningsAsync(() => CollectAsync(NewAgent(fake), input));

        Assert.DoesNotContain(warnings, static w => w.StartsWith(Prefix, StringComparison.Ordinal));
    }

    private sealed class WarningListener(List<string> warnings) : TraceListener
    {
        public override void Write(string? message)
        {
        }

        public override void WriteLine(string? message)
        {
        }

        public override void TraceEvent(TraceEventCache? eventCache, string source, TraceEventType eventType, int id, string? message)
        {
            Record(eventType, message);
        }

        public override void TraceEvent(TraceEventCache? eventCache, string source, TraceEventType eventType, int id, string? format, params object?[]? args)
        {
            Record(eventType, format is null || args is null ? format : string.Format(CultureInfo.InvariantCulture, format, args));
        }

        private void Record(TraceEventType eventType, string? message)
        {
            if (eventType == TraceEventType.Warning && message is not null)
            {
                lock (warnings)
                {
                    warnings.Add(message);
                }
            }
        }
    }
}
