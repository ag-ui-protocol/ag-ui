using System.Collections.Immutable;
using System.Text.Json;
using AGUIDotnet.Integrations.ChatClient;
using AGUIDotnet.Types;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.DependencyInjection;

namespace AGUIDotnet.Tests;

public class FrontendToolTests
{
    [Fact]
    public void FrontendToolMirrorsAGUIToolDefinition()
    {
        var agUiTool = new Tool
        {
            Name = "TestTool",
            Description = "A test tool",
            Parameters = JsonDocument.Parse("{}").RootElement
        };

        var frontendTool = new FrontendTool(agUiTool);
        Assert.Equal(agUiTool.Name, frontendTool.Name);
        Assert.Equal(agUiTool.Description, frontendTool.Description);
        Assert.Equal(agUiTool.Parameters, frontendTool.JsonSchema);
    }

    [Fact]
    public async Task FrontendToolInvokeCoreTerminatesInvocationLoop()
    {
        var agUiTool = new Tool
        {
            Name = "TestTool",
            Description = "A test tool",
            Parameters = JsonDocument.Parse("{}").RootElement
        };

        var frontendTool = new FrontendTool(agUiTool);
        var serviceProvider = new ServiceCollection()
            .BuildServiceProvider();

        var callId = Guid.NewGuid().ToString();

        var innerChatClient = new TestChatClient(
            serviceProvider,
            async (sp, messages, options, cancellationToken) =>
            {
                // Simulate the AI requesting the tool be invoked
                return new ChatResponse(
                    new ChatMessage(
                        ChatRole.Assistant,
                        [
                            new FunctionCallContent(
                                callId,
                                frontendTool.Name,
                                null
                            ),
                            // Also request the backend function to be called
                            // (it should not be called)
                            new FunctionCallContent(
                                Guid.NewGuid().ToString(),
                                "backend",
                                null
                            )
                        ]
                    )
                )
                {
                    FinishReason = ChatFinishReason.ToolCalls
                };
            }
        );

        var chatClient = new FunctionInvokingChatClient(innerChatClient);

        /*
        The FrontendTool indicates via the current invocation context that it should terminate
        when it is invoked.

        We have no direct access to this, as by the time the work is done, the current context has been
        cleared, so we make the backend tool fail the test if it gets invoked.
        */
        static void BackendFunction()
        {
            Assert.Fail("Backend function should not have been invoked");
        }

        var resp = await chatClient.GetResponseAsync(
            new ChatMessage(ChatRole.User, "Hello"),
            new ChatOptions
            {
                Tools = [
                    frontendTool,
                    AIFunctionFactory.Create(
                        BackendFunction,
                        name: "backend"
                    )
                ],
                ToolMode = ChatToolMode.Auto,
                // For the purposes of this test, ensure the function invoking chat client
                // believes it can handle multiple tool calls in a single response.
                AllowMultipleToolCalls = true
            }
        );

        Assert.Equal(2, resp.Messages.Count);
        var funcCallMsg = resp.Messages[0];
        Assert.Equal(ChatRole.Assistant, funcCallMsg.Role);
        // We expect two function call contents on the first message:

        var funcCalls = funcCallMsg.Contents.OfType<FunctionCallContent>().ToImmutableList();
        Assert.Equal(funcCallMsg.Contents, funcCalls);

        var frontendToolCall = Assert.Single(funcCalls, fc => fc.CallId == callId);
        Assert.Equal(frontendTool.Name, frontendToolCall.Name);
        Assert.Null(frontendToolCall.Arguments);

        // The second function call should be the backend function
        var backendToolCall = Assert.Single(funcCalls, fc => fc.CallId != callId);
        Assert.Equal("backend", backendToolCall.Name);

        // The second message should be a tool result message
        var dummyResultMsg = resp.Messages[1];
        Assert.Equal(ChatRole.Tool, dummyResultMsg.Role);

        // It should *only* contain the dummy frontend tool result
        // (the underlying FunctionInvokingChatClient will have emitted the "result" as we have to intercept it this way)
        var resContent = Assert.IsType<FunctionResultContent>(Assert.Single(dummyResultMsg.Contents));
        Assert.Equal(callId, resContent.CallId);

        // The result isn't important, the frontend tool returns a null, but the 
        // AI abstraction sticks a success string message in there (presumably so the LLM can infer that it ran)
    }
}
