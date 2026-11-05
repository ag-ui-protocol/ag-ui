using System.Net;
using System.Text;
using System.Text.Json;
using Anthropic;
using Anthropic.Core;
using Xunit;

namespace AGUI.ClaudeManagedAgents.Tests;

/// <summary>
/// Wire-shape tests for the default client, over a fake HTTP handler (no network).
/// </summary>
public class AnthropicManagedAgentsClientTest
{
    private sealed class RecordedRequest
    {
        internal required HttpMethod Method { get; init; }

        internal required Uri Uri { get; init; }

        internal required string? BetaHeader { get; init; }

        internal required JsonElement? Body { get; init; }
    }

    private sealed class RecordingHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> _respond;

        internal RecordingHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) => _respond = respond;

        internal List<RecordedRequest> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
            Requests.Add(new RecordedRequest
            {
                Method = request.Method,
                Uri = request.RequestUri!,
                BetaHeader = request.Headers.TryGetValues("anthropic-beta", out var values) ? string.Join(",", values) : null,
                Body = string.IsNullOrEmpty(body) ? null : FakeManagedAgentsClient.Json(body),
            });
            return _respond(request);
        }
    }

    private static AnthropicManagedAgentsClient NewClient(RecordingHandler handler)
    {
        var options = new ClientOptions
        {
            ApiKey = "test-key",
            BaseUrl = "http://managed-agents.test",
            HttpClient = new HttpClient(handler),
            MaxRetries = 0,
        };
        return new AnthropicManagedAgentsClient(new AnthropicClient(options));
    }

    private static HttpResponseMessage JsonResponse(string json)
    {
        return new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        };
    }

    private static void AssertJson(string expected, JsonElement? actual)
    {
        Assert.NotNull(actual);
        var expectedElement = FakeManagedAgentsClient.Json(expected);
        Assert.True(
            JsonElement.DeepEquals(expectedElement, actual!.Value),
            $"Expected {expectedElement.GetRawText()}\nActual   {actual.Value.GetRawText()}");
    }

    [Fact]
    public async Task RuntimeContextReachesNativeHttpRequest()
    {
        var handler = new RecordingHandler(request => request.RequestUri!.AbsolutePath.EndsWith("/events/stream", StringComparison.Ordinal)
            ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("event: session.status_idle\ndata: {\"type\":\"session.status_idle\",\"id\":\"idle\",\"stop_reason\":{\"type\":\"end_turn\"}}\n\n", Encoding.UTF8, "text/event-stream") }
            : JsonResponse("{\"id\":\"native\",\"data\":[],\"tools\":[]}"));
        var agent = new ManagedAgentsAgent(new() { ManagedAgentId = "a", EnvironmentId = "e", Client = NewClient(handler) });
        var input = new AGUI.Abstractions.RunAgentInput { ThreadId = "t", RunId = "r", Tools = [],
            Messages = [new AGUI.Abstractions.AGUIUserMessage { Id = "u", Content = "show flights" }],
            Context = [new() { Description = "A2UI catalog", Value = "copilotkit://app-dashboard-catalog — FlightCard" }, new() { Description = "A2UI schema", Value = "  {\"component\":\"FlightCard\"}\n日本語" }] };
        var events = new List<AGUI.Abstractions.BaseEvent>();
        await foreach (var evt in agent.RunAsync(input)) events.Add(evt);
        Assert.IsType<AGUI.Abstractions.RunFinishedEvent>(events[^1]);
        var request = Assert.Single(handler.Requests, r => r.Body is { } body && body.TryGetProperty("events", out _));
        var sent = request.Body!.Value.GetProperty("events");
        Assert.Equal(2, sent.GetArrayLength());
        Assert.Equal("show flights", sent[0].GetProperty("content")[0].GetProperty("text").GetString());
        Assert.Equal("system.message", sent[1].GetProperty("type").GetString());
        var text = sent[1].GetProperty("content")[0].GetProperty("text").GetString()!;
        Assert.True(JsonElement.DeepEquals(JsonSerializer.SerializeToElement(input.Context), JsonSerializer.Deserialize<JsonElement>(text[(text.IndexOf('\n') + 1)..])));
        Assert.Single(input.Messages);
    }

    [Fact]
    public async Task NativeSdkStateReadWriteProducesRecoverableSnapshots()
    {
        const string call = """{"type":"agent.custom_tool_use","id":"state_write","session_thread_id":"primary","processed_at":"2026-10-21T12:00:01Z","name":"ag_ui_update_state","input":{"operation":"merge_patch","expectedRevision":1,"patch":{"board":{"count":2,"obsolete":null}}}}""";
        const string idle = """{"type":"session.status_idle","id":"idle","stop_reason":{"type":"end_turn"}}""";
        var handler = new RecordingHandler(request =>
        {
            var path = request.RequestUri!.AbsolutePath;
            if (request.Content is not null)
            {
                var body = JsonSerializer.Deserialize<JsonElement>(request.Content.ReadAsStringAsync().GetAwaiter().GetResult());
                if (body.TryGetProperty("events", out var batch))
                {
                    var items = batch.EnumerateArray().ToList();
                    var systemIndexes = items.Select((evt, index) => (evt, index)).Where(item => item.evt.GetProperty("type").GetString() == "system.message").Select(item => item.index).ToList();
                    Assert.True(systemIndexes.Count <= 1);
                    if (systemIndexes.Count == 1)
                    {
                        Assert.Equal(items.Count - 1, systemIndexes[0]);
                        Assert.True(systemIndexes[0] > 0);
                        Assert.Contains(items[systemIndexes[0] - 1].GetProperty("type").GetString(), new[] { "user.message", "user.tool_result", "user.custom_tool_result" });
                    }
                }
            }
            if (path.EndsWith("/events/stream", StringComparison.Ordinal)) return new HttpResponseMessage(HttpStatusCode.OK)
            { Content = new StringContent($"event: agent.custom_tool_use\ndata: {call}\n\nevent: session.status_idle\ndata: {idle}\n\n", Encoding.UTF8, "text/event-stream") };
            if (path.EndsWith("/threads", StringComparison.Ordinal)) return JsonResponse("""{"data":[{"id":"primary","session_id":"native","parent_thread_id":null}],"has_more":false}""");
            return JsonResponse("""{"id":"native","tools":[],"data":[]}""");
        });
        var store = new InMemorySessionStore();
        var agent = new ManagedAgentsAgent(new() { ManagedAgentId = "a", EnvironmentId = "e", Client = NewClient(handler), SessionStore = store });
        var input = new AGUI.Abstractions.RunAgentInput { ThreadId = "t", RunId = "r", Tools = [], Context = [new() { Description = "A2UI catalog", Value = "copilotkit://app-dashboard-catalog" }],
            State = JsonSerializer.Deserialize<JsonElement>("""{"board":{"count":1,"obsolete":true}}"""),
            Messages = [new AGUI.Abstractions.AGUIUserMessage { Id = "u", Content = "Increase board count and delete obsolete" }] };
        var events = new List<AGUI.Abstractions.BaseEvent>();
        await foreach (var evt in agent.RunAsync(input)) events.Add(evt);
        Assert.IsType<AGUI.Abstractions.RunFinishedEvent>(events[^1]);
        Assert.Equal(2, events.OfType<AGUI.Abstractions.StateSnapshotEvent>().Count());
        var native = handler.Requests.Where(request => request.Body is { } body && body.TryGetProperty("events", out _))
            .SelectMany(request => request.Body!.Value.GetProperty("events").EnumerateArray()).ToList();
        var system = Assert.Single(native, evt => evt.GetProperty("type").GetString() == "system.message");
        Assert.Equal(2, system.GetProperty("content").GetArrayLength());
        var recovered = new ManagedAgentsSessionRecord { SessionId = "native", PrimaryThreadId = "primary" };
        ManagedAgentsContext.Restore(system, recovered);
        Assert.NotNull(recovered.RuntimeContext);
        Assert.True(ManagedAgentsState.Restore(system, recovered, new Dictionary<string, JsonElement>()));
        Assert.Equal(1, recovered.SharedStateRevision);
        var result = Assert.Single(native, evt => evt.GetProperty("type").GetString() == "user.custom_tool_result");
        Assert.False(result.GetProperty("is_error").GetBoolean());
        var record = (await store.GetAsync("1:a|0:|1:e|0:|t", default))!;
        Assert.Equal(2, record.SharedStateRevision);
        Assert.True(JsonElement.DeepEquals(JsonSerializer.Deserialize<JsonElement>("""{"board":{"count":2}}"""), record.SharedState!.Value));
        if (Environment.GetEnvironmentVariable("PNI_STATE_FIXTURE") is { Length: > 0 } fixturePath)
        {
            static JsonElement Persisted(JsonElement evt, string id, string at)
            {
                var value = System.Text.Json.Nodes.JsonNode.Parse(evt.GetRawText())!.AsObject();
                value["id"] = id; value["session_thread_id"] = "primary"; value["processed_at"] = at;
                return JsonSerializer.SerializeToElement(value);
            }
            await File.WriteAllTextAsync(fixturePath, JsonSerializer.Serialize(new
            {
                provenance = "state-relevant event excerpt from deterministic HTTP handler through installed Anthropic SDK; not paid provider evidence",
                sdk = typeof(AnthropicClient).Assembly.GetName().Version!.ToString(), sessionId = "native",
                threads = new[] { new { id = "primary", session_id = "native", parent_thread_id = (string?)null } },
                events = new[] { Persisted(system, "state_initial", "2026-10-21T12:00:00Z"), JsonSerializer.Deserialize<JsonElement>(call), Persisted(result, "state_result", "2026-10-21T12:00:02Z") }
            }, new JsonSerializerOptions { WriteIndented = true }));
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ChildReservedCompletionUsesOriginalSessionAndIdAcrossColdRestart(bool childBinding)
    {
        const string call = """{"type":"agent.custom_tool_use","id":"child-write","session_thread_id":"child","name":"ag_ui_update_state","input":{"operation":"replace","expectedRevision":0,"state":{"ignored":true}}}""";
        const string parked = """{"type":"session.status_idle","id":"parked","stop_reason":{"type":"requires_action","event_ids":["child-write"]}}""";
        const string idle = """{"type":"session.status_idle","id":"finished","stop_reason":{"type":"end_turn"}}""";
        var history = new List<JsonElement> { FakeManagedAgentsClient.Json(call), FakeManagedAgentsClient.Json(parked) };
        var rejectResult = false;
        var acceptedResults = 0;
        var handler = new RecordingHandler(request =>
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path.EndsWith("/stream", StringComparison.Ordinal))
            {
                var terminal = childBinding ? idle.Replace("session.status_idle", "session.thread_status_idle", StringComparison.Ordinal).Replace("\"id\":\"finished\"", "\"id\":\"finished\",\"session_thread_id\":\"child\"", StringComparison.Ordinal) : idle;
                var kind = childBinding ? "session.thread_status_idle" : "session.status_idle";
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent($"event: {kind}\ndata: {terminal}\n\n", Encoding.UTF8, "text/event-stream") };
            }
            if (path.EndsWith("/threads", StringComparison.Ordinal)) return JsonResponse("""{"data":[{"id":"primary","session_id":"native","parent_thread_id":null}],"has_more":false}""");
            if (request.Method == HttpMethod.Get && path.EndsWith("/events", StringComparison.Ordinal))
                return JsonResponse(JsonSerializer.Serialize(new { data = history, has_more = false }));
            if (request.Method == HttpMethod.Post)
            {
                Assert.Equal("/v1/sessions/native/events", path);
                var body = FakeManagedAgentsClient.Json(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());
                var result = Assert.Single(body.GetProperty("events").EnumerateArray());
                Assert.Equal("user.custom_tool_result", result.GetProperty("type").GetString());
                Assert.Equal("child-write", result.GetProperty("custom_tool_use_id").GetString());
                if (rejectResult) return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable) { Content = new StringContent("offline") };
                acceptedResults++;
                history.Add(result);
                history.Add(FakeManagedAgentsClient.Json(idle));
            }
            return JsonResponse("{}");
        });
        if (childBinding)
        {
            var probe = await NewClient(handler).OpenConversationStreamAsync("native", "child", false, default);
            var received = 0;
            await using ((IAsyncDisposable)probe)
            {
                await foreach (var evt in probe) { Assert.True(evt.TryPickSessionStatusIdleEvent(out _), evt.Json.GetRawText()); received++; }
            }
            Assert.Equal(1, received);
        }
        var input = new AGUI.Abstractions.RunAgentInput { ThreadId = "t", RunId = "r", Messages = [], Tools = [], Context = [] };
        async Task<List<AGUI.Abstractions.BaseEvent>> ColdRun(bool failed = false)
        {
            var agent = new ManagedAgentsAgent(new() { ManagedAgentId = "a", EnvironmentId = "e", Client = NewClient(handler),
                SessionStore = new InMemorySessionStore(), ResolveSession = (_, _) => Task.FromResult<ManagedAgentsSessionBinding?>(new() { SessionId = "native", SessionThreadId = childBinding ? "child" : null }) });
            var events = new List<AGUI.Abstractions.BaseEvent>();
            await foreach (var evt in agent.RunAsync(input)) events.Add(evt);
            if (failed) Assert.IsType<AGUI.Abstractions.RunErrorEvent>(events[^1]);
            else Assert.IsType<AGUI.Abstractions.RunFinishedEvent>(events[^1]);
            Assert.Empty(events.OfType<AGUI.Abstractions.StateSnapshotEvent>());
            return events;
        }
        Assert.Equal("child-write", Assert.Single((await ColdRun()).OfType<AGUI.Abstractions.ToolCallStartEvent>()).ToolCallId);
        Assert.DoesNotContain(handler.Requests, request => request.Method == HttpMethod.Post);
        input.Messages.Add(new AGUI.Abstractions.AGUIToolMessage { Id = "answer", ToolCallId = "child-write", Content = "Unsupported child state write" });
        rejectResult = true;
        await ColdRun(failed: true);
        Assert.Equal(0, acceptedResults);
        rejectResult = false;
        await ColdRun();
        await ColdRun();
        Assert.Equal(1, acceptedResults);
        Assert.Equal(2, handler.Requests.Count(request => request.Method == HttpMethod.Post));
        Assert.Contains(handler.Requests, request => request.Uri.AbsolutePath == (childBinding ? "/v1/sessions/native/threads/child/events" : "/v1/sessions/native/events") && request.Method == HttpMethod.Get);
    }

    [Fact]
    public async Task CreatesASessionWithToolOverridesAndAPinnedVersion()
    {
        var handler = new RecordingHandler(_ => JsonResponse("""{"id":"sesn_test"}"""));
        var client = NewClient(handler);

        var sessionId = await client.CreateSessionAsync(
            new ManagedAgentSessionRequest
            {
                ManagedAgentId = "agent_1",
                AgentVersion = 3,
                EnvironmentId = "env_1",
                Title = "AG-UI thread thread_1",
                OverrideTools = [FakeManagedAgentsClient.Json("""{"type":"custom","name":"show_chart"}""")],
            },
            default);

        Assert.Equal("sesn_test", sessionId);
        var request = Assert.Single(handler.Requests);
        Assert.Equal((HttpMethod.Post, "/v1/sessions"), (request.Method, request.Uri.AbsolutePath));
        Assert.Contains("managed-agents-2026-04-01", request.BetaHeader);
        AssertJson(
            """
            {
              "agent": {"type": "agent_with_overrides", "id": "agent_1", "version": 3, "tools": [{"type": "custom", "name": "show_chart"}]},
              "environment_id": "env_1",
              "title": "AG-UI thread thread_1"
            }
            """,
            request.Body);
    }

    [Fact]
    public async Task CreatesASessionOnThePlainAgentWithoutOverrides()
    {
        var handler = new RecordingHandler(_ => JsonResponse("""{"id":"sesn_test"}"""));
        var client = NewClient(handler);

        await client.CreateSessionAsync(
            new ManagedAgentSessionRequest { ManagedAgentId = "agent_1", EnvironmentId = "env_1", Title = "T" },
            default);

        AssertJson(
            """{"agent":{"type":"agent","id":"agent_1"},"environment_id":"env_1","title":"T"}""",
            Assert.Single(handler.Requests).Body);
    }

    [Fact]
    public async Task UpdatesTheSessionsToolListInFull()
    {
        var handler = new RecordingHandler(_ => JsonResponse("""{"id":"sesn_test"}"""));
        var client = NewClient(handler);

        await client.UpdateSessionToolsAsync(
            "sesn_test",
            [
                FakeManagedAgentsClient.Json("""{"type":"agent_toolset_20260401"}"""),
                FakeManagedAgentsClient.Json("""{"type":"custom","name":"show_chart"}"""),
            ],
            default);

        var request = Assert.Single(handler.Requests);
        Assert.Equal((HttpMethod.Post, "/v1/sessions/sesn_test"), (request.Method, request.Uri.AbsolutePath));
        AssertJson(
            """{"agent":{"tools":[{"type":"agent_toolset_20260401"},{"type":"custom","name":"show_chart"}]}}""",
            request.Body);
    }

    [Fact]
    public async Task ReadsTheAgentsOwnToolsAtAPinnedVersion()
    {
        var handler = new RecordingHandler(_ => JsonResponse("""{"id":"agent_1","tools":[{"type":"agent_toolset_20260401"}]}"""));
        var client = NewClient(handler);

        var tools = await client.GetAgentToolsAsync("agent_1", 3, default);

        var request = Assert.Single(handler.Requests);
        Assert.Equal((HttpMethod.Get, "/v1/agents/agent_1"), (request.Method, request.Uri.AbsolutePath));
        Assert.Contains("version=3", request.Uri.Query);
        AssertJson("""{"type":"agent_toolset_20260401"}""", Assert.Single(tools));
    }

    [Fact]
    public async Task PostsEventsIntoTheSession()
    {
        var handler = new RecordingHandler(_ => JsonResponse("{}"));
        var client = NewClient(handler);

        await client.SendEventsAsync("sesn_test", [ManagedAgentsSessionEvents.UserMessage("hi")], default);

        var request = Assert.Single(handler.Requests);
        Assert.Equal((HttpMethod.Post, "/v1/sessions/sesn_test/events"), (request.Method, request.Uri.AbsolutePath));
        AssertJson(
            """{"events":[{"type":"user.message","content":[{"type":"text","text":"hi"}]}]}""",
            request.Body);
    }

    [Fact]
    public async Task OpensTheEventStreamRequestingPreviewsAndReadsItsEvents()
    {
        var handler = new RecordingHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                "event: session.status_idle\ndata: {\"type\":\"session.status_idle\",\"id\":\"idle_1\",\"stop_reason\":{\"type\":\"end_turn\"}}\n\n",
                Encoding.UTF8,
                "text/event-stream"),
        });
        var client = NewClient(handler);

        var stream = await client.OpenEventStreamAsync("sesn_test", streamDeltas: true, default);
        var received = new List<string>();
        await using ((IAsyncDisposable)stream)
        {
            await foreach (var streamEvent in stream)
            {
                received.Add(streamEvent.Json.GetProperty("type").GetString()!);
            }
        }

        var request = Assert.Single(handler.Requests);
        Assert.Equal((HttpMethod.Get, "/v1/sessions/sesn_test/events/stream"), (request.Method, request.Uri.AbsolutePath));
        var query = Uri.UnescapeDataString(request.Uri.Query);
        Assert.Contains("event_deltas", query);
        Assert.Contains("agent.message", query);
        Assert.Contains("agent.thinking", query);
        Assert.Equal(["session.status_idle"], received);
    }

    [Fact]
    public async Task OpensTheEventStreamWithoutPreviewsWhenDisabled()
    {
        var handler = new RecordingHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(string.Empty, Encoding.UTF8, "text/event-stream"),
        });
        var client = NewClient(handler);

        var stream = await client.OpenEventStreamAsync("sesn_test", streamDeltas: false, default);
        await ((IAsyncDisposable)stream).DisposeAsync();

        Assert.DoesNotContain("event_deltas", Uri.UnescapeDataString(Assert.Single(handler.Requests).Uri.Query));
    }
    [Theory]
    [InlineData(null, "/v1/sessions/native/events")]
    [InlineData("child", "/v1/sessions/native/threads/child/events")]
    public async Task ReadsEveryHistoryPageFromSelectedConversation(string? child, string expectedPath)
    {
        var handler = new RecordingHandler(request => JsonResponse(request.RequestUri!.Query.Contains("page=next", StringComparison.Ordinal)
            ? """{"data":[{"type":"agent.custom_tool_use","id":"second","name":"lookup","input":{}}],"next_page":null}"""
            : """{"data":[{"type":"agent.custom_tool_use","id":"first","name":"lookup","input":{}}],"next_page":"next"}"""));
        var events = await NewClient(handler).ListSessionEventsAsync("native", child, default);
        Assert.Equal(new[] { "first", "second" }, events.Select(evt => evt.GetProperty("id").GetString()));
        Assert.Equal(2, handler.Requests.Count);
        Assert.All(handler.Requests, request => Assert.Equal(expectedPath, request.Uri.AbsolutePath));
    }

    [Fact]
    public async Task ChildStreamPreservesTermination()
    {
        var handler = new RecordingHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("event: session.thread_status_terminated\ndata: {\"type\":\"session.thread_status_terminated\",\"id\":\"end\",\"session_thread_id\":\"child\"}\n\n", Encoding.UTF8, "text/event-stream"),
        });
        var stream = await NewClient(handler).OpenConversationStreamAsync("native", "child", false, default);
        await using ((IAsyncDisposable)stream)
        {
            var received = 0;
            await foreach (var evt in stream)
            {
                Assert.Equal("session.status_terminated", evt.Json.GetProperty("type").GetString());
                Assert.True(evt.TryPickSessionStatusTerminatedEvent(out _));
                received++;
            }
            Assert.Equal(1, received);
        }
        Assert.Equal("/v1/sessions/native/threads/child/stream", Assert.Single(handler.Requests).Uri.AbsolutePath);
    }
}
