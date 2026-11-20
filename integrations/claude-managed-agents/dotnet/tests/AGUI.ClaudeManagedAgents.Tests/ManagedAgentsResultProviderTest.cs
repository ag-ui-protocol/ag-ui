using System.Diagnostics;
using System.Text.Json;
using AGUI.Abstractions;
using Anthropic;
using Anthropic.Core;
using Xunit;

namespace AGUI.ClaudeManagedAgents.Tests;

public class ManagedAgentsResultProviderTest
{
    [Theory]
    [InlineData("ts")]
    [InlineData("py")]
    [InlineData("dotnet")]
    public async Task NativeHttpResultSurvivesProviderRestart(string language)
    {
        using var fixture = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(AppContext.BaseDirectory, "child-results.json")));
        var row = fixture.RootElement.GetProperty(language);
        var native = row.GetProperty("native").EnumerateArray().Single(e => e.GetProperty("type").GetString() == "agent.tool_result");
        var store = new InMemorySessionStore();
        foreach (var completed in new[] { false, true })
        {
            if (completed)
            {
                var snapshot = JsonSerializer.Serialize(await store.GetAsync("1:a|0:|1:e|0:|imported", default));
                store = new InMemorySessionStore();
                await store.SetAsync("1:a|0:|1:e|0:|imported", JsonSerializer.Deserialize<ManagedAgentsSessionRecord>(snapshot)!, default);
            }
            var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("AGUI_TEST_PYTHON") ?? "python3") { RedirectStandardOutput = true, UseShellExecute = false };
            start.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory, "result_provider.py"));
            start.ArgumentList.Add(language);
            if (completed) start.ArgumentList.Add("completed");
            start.Environment["AGUI_RESULT_FIXTURE"] = Path.Combine(AppContext.BaseDirectory, "child-results.json");
            using var provider = Process.Start(start)!;
            try
            {
                var port = await provider.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5));
                Assert.True(int.TryParse(port, out _));
                var client = new AnthropicManagedAgentsClient(new AnthropicClient(new ClientOptions { ApiKey = "local-test", BaseUrl = $"http://127.0.0.1:{port}", MaxRetries = 0 }));
                var agent = new ManagedAgentsAgent(new() { ManagedAgentId = "a", EnvironmentId = "e", Client = client, SessionStore = store, ResolveSession = (_, _) => Task.FromResult<ManagedAgentsSessionBinding?>(new() { SessionId = "native" }) });
                var input = new RunAgentInput { ThreadId = "imported", RunId = "r", Messages = [], Tools = [] };
                if (!completed) input.Resume = [new AGUIResume { InterruptId = row.GetProperty("root")[0].GetProperty("id").GetString()!, Status = "resolved", Payload = row.GetProperty("root")[1].GetProperty("result") }];
                var events = new List<BaseEvent>();
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                await foreach (var e in agent.RunAsync(input, timeout.Token)) events.Add(e);
                Assert.IsType<RunFinishedEvent>(events[^1]);
                if (completed) Assert.Empty(events.OfType<ToolCallResultEvent>());
                else
                {
                    var result = Assert.Single(events.OfType<ToolCallResultEvent>());
                    Assert.Equal(native.GetProperty("id").GetString(), result.MessageId);
                    Assert.Equal(native.GetProperty("tool_use_id").GetString(), result.ToolCallId);
                    var content = Assert.IsType<string>(result.Content.Value);
                    if (native.GetProperty("is_error").GetBoolean())
                    {
                        using var envelope = JsonDocument.Parse(content);
                        Assert.True(envelope.RootElement.GetProperty("error").GetBoolean());
                        content = envelope.RootElement.GetProperty("content").GetString()!;
                    }
                    Assert.Equal(native.GetProperty("content")[0].GetProperty("text").GetString(), content);
                }
            }
            finally
            {
                if (!provider.HasExited) provider.Kill(entireProcessTree: true);
                await provider.WaitForExitAsync();
            }
        }
    }
}
