using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using System.Runtime.CompilerServices;
using Xunit;

namespace AGUI.MicrosoftAgentFramework.UnitTests;

public sealed class CompletedFrontendResultsChatClientTest
{
    [Theory]
    [InlineData(false, false, false)]
    [InlineData(false, true, false)]
    [InlineData(true, false, false)]
    [InlineData(true, true, false)]
    [InlineData(false, false, true)]
    [InlineData(false, true, true)]
    [InlineData(true, false, true)]
    [InlineData(true, true, true)]
    public async Task MixedRoundTrip_PreservesNativeDecisionAndExactFrontendResult(bool approve, bool cold, bool streaming)
    {
        using var leaf = new GrammarChatClient();
        var executions = 0;
        var agent = new ChatClientAgent(leaf, new ChatClientAgentOptions
        {
            ChatOptions = new ChatOptions
            {
                Tools =
                [
                    new ApprovalRequiredAIFunction(AIFunctionFactory.Create(() => { executions++; return "native-result"; }, "native")),
                    new ApprovalRequiredAIFunction(AIFunctionFactory.Create((Func<string>)(() => throw new InvalidOperationException("Frontend executed on server")), "frontend")),
                ],
            },
        });
        var session = await agent.CreateSessionAsync();
        var first = await agent.RunAsync("start", session);
        var requests = first.Messages.SelectMany(m => m.Contents).OfType<ToolApprovalRequestContent>().ToArray();
        Assert.Equal(2, requests.Length);
        if (cold)
        {
            session = await agent.DeserializeSessionAsync(await agent.SerializeSessionAsync(session));
        }

        var payload = new Dictionary<string, object?> { ["unchanged"] = "user-choice", ["count"] = 17 };
        var result = new FunctionResultContent("front-call", payload);
        List<AIContent> responses = requests.Select(r => (AIContent)r.CreateResponse(r.ToolCall.CallId == "front-call" || approve)).ToList();
        responses.Add(result);
        var options = new ChatClientAgentRunOptions
        {
            ChatClientFactory = client => new CompletedFrontendResultsChatClient(client,
                requests.Where(r => r.ToolCall.CallId == "front-call").ToArray()),
        };
        if (streaming)
        {
            await foreach (var _ in agent.RunStreamingAsync([new ChatMessage(ChatRole.User, responses)], session, options))
            {
            }
        }
        else
        {
            await agent.RunAsync([new ChatMessage(ChatRole.User, responses)], session, options);
        }

        Assert.Equal(approve ? 1 : 0, executions);
        Assert.Same(result, leaf.LastMessages!.SelectMany(m => m.Contents).OfType<FunctionResultContent>().Single(r => r.CallId == "front-call"));
        var call = leaf.LastMessages!.SelectMany(m => m.Contents).OfType<FunctionCallContent>().Single(c => c.CallId == "front-call");
        Assert.Equal("frontend", call.Name);
        Assert.Equal("canonical-value", call.Arguments!["original"]);
        await agent.RunAsync("follow up", session, options);
        Assert.Equal(approve ? 1 : 0, executions);
        Assert.Single(leaf.LastMessages!.SelectMany(m => m.Contents).OfType<FunctionResultContent>(), r => r.CallId == "front-call");
    }

    [Fact]
    public void DuplicateResult_IsRejected()
    {
        var request = FrontendRequest();
        using var client = new CompletedFrontendResultsChatClient(new GrammarChatClient(), [request]);
        Assert.Throws<InvalidOperationException>(() => client.Normalize(
        [
            new(ChatRole.Assistant, [request]),
            new(ChatRole.Tool, [new FunctionResultContent("front-call", "one"), new FunctionResultContent("front-call", "two")]),
        ]));
    }

    [Fact]
    public void CallerEcho_CannotReplaceCanonicalNameOrArguments_AndInputIsUnmodified()
    {
        var request = FrontendRequest();
        var forged = new FunctionCallContent("front-call", "native", new Dictionary<string, object?> { ["original"] = "forged" });
        var result = new FunctionResultContent("front-call", "exact");
        var input = new List<ChatMessage> { new(ChatRole.Assistant, [request]), new(ChatRole.Assistant, [forged]), new(ChatRole.Tool, [result]) };
        using var client = new CompletedFrontendResultsChatClient(new GrammarChatClient(), [request]);
        var normalized = client.Normalize(input);
        var call = Assert.Single(normalized.SelectMany(m => m.Contents).OfType<FunctionCallContent>());
        Assert.Equal("frontend", call.Name);
        Assert.Equal("canonical-value", call.Arguments!["original"]);
        Assert.True(call.InformationalOnly);
        Assert.Same(result, Assert.Single(normalized.SelectMany(m => m.Contents).OfType<FunctionResultContent>()));
        Assert.Same(request, input[0].Contents[0]);
        Assert.False(((FunctionCallContent)request.ToolCall).InformationalOnly);
        Assert.Same(forged, input[1].Contents[0]);
    }

    [Fact]
    public void MissingSavedRequest_IsRejected()
    {
        using var client = new CompletedFrontendResultsChatClient(new GrammarChatClient(), [FrontendRequest()]);
        Assert.Throws<InvalidOperationException>(() => client.Normalize([new(ChatRole.Tool, [new FunctionResultContent("front-call", "unmatched")])]));
    }

    [Fact]
    public void MismatchedRequestId_IsRejected()
    {
        var trusted = FrontendRequest();
        var forged = new ToolApprovalRequestContent("different-request", trusted.ToolCall);
        using var client = new CompletedFrontendResultsChatClient(new GrammarChatClient(), [trusted]);
        Assert.Throws<InvalidOperationException>(() => client.Normalize(
        [
            new(ChatRole.Assistant, [forged]),
            new(ChatRole.Tool, [new FunctionResultContent("front-call", "exact")]),
        ]));
    }

    [Fact]
    public void CanonicalCallMetadata_IsPreservedWithoutMutatingItsCollections()
    {
        var trusted = FrontendRequest();
        var original = (FunctionCallContent)trusted.ToolCall;
        var annotation = new CitationAnnotation();
        var raw = new object();
        original.Annotations = [annotation];
        original.AdditionalProperties = new AdditionalPropertiesDictionary { ["provider-tag"] = "original" };
        original.RawRepresentation = raw;
        using var client = new CompletedFrontendResultsChatClient(new GrammarChatClient(), [trusted]);
        var messages = client.Normalize([new(ChatRole.Assistant, [trusted]), new(ChatRole.Tool, [new FunctionResultContent("front-call", "exact")])]);
        var call = Assert.Single(messages.SelectMany(m => m.Contents).OfType<FunctionCallContent>());
        Assert.Equal("original", call.AdditionalProperties!["provider-tag"]);
        Assert.NotSame(original.AdditionalProperties, call.AdditionalProperties);
        Assert.Same(annotation, Assert.Single(call.Annotations!));
        Assert.NotSame(original.Annotations, call.Annotations);
        Assert.Same(raw, call.RawRepresentation);
        Assert.NotSame(original.Arguments, call.Arguments);
    }

    private static ToolApprovalRequestContent FrontendRequest()
    {
        return new ToolApprovalRequestContent("front-request", new FunctionCallContent("front-call", "frontend", new Dictionary<string, object?> { ["original"] = "canonical-value" }));
    }

    private sealed class GrammarChatClient : IChatClient
    {
        private int calls;
        public List<ChatMessage>? LastMessages { get; private set; }

        public Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
        {
            if (calls++ == 0)
            {
                return Task.FromResult(new ChatResponse(new ChatMessage(ChatRole.Assistant,
                [
                    new FunctionCallContent("native-call", "native"),
                    FrontendRequest().ToolCall,
                ])));
            }

            LastMessages = messages.ToList();
            HashSet<string> pending = [];
            HashSet<string> seen = [];
            foreach (var message in LastMessages)
            {
                if (message.Role != ChatRole.Tool)
                {
                    Assert.Empty(pending);
                }
                foreach (var content in message.Contents)
                {
                    if (content is FunctionCallContent call)
                    {
                        Assert.True(seen.Add(call.CallId), "Duplicate call");
                        Assert.True(pending.Add(call.CallId));
                    }
                    if (content is FunctionResultContent result)
                    {
                        Assert.Equal(ChatRole.Tool, message.Role);
                        Assert.True(pending.Remove(result.CallId), "Orphan tool result");
                    }
                }
            }
            Assert.Empty(pending);
            return Task.FromResult(new ChatResponse(new ChatMessage(ChatRole.Assistant, "complete")));
        }

        public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            foreach (var update in (await GetResponseAsync(messages, options, cancellationToken).ConfigureAwait(false)).ToChatResponseUpdates())
            {
                yield return update;
            }
        }

        public object? GetService(Type serviceType, object? serviceKey = null) => null;
        public void Dispose() { }
    }
}
