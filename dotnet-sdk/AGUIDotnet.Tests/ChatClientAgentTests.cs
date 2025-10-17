using System.Collections.Immutable;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Threading.Channels;
using AGUIDotnet.Agent;
using AGUIDotnet.Events;
using AGUIDotnet.Types;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace AGUIDotnet.Tests;

public class ChatClientAgentTests
{
    [Fact]
    public async Task UserMessage_ShouldReceiveAssistantResponse()
    {
        // Arrange
        var userMessage = new UserMessage
        {
            Id = "user-msg-1",
            Content = "Hello, assistant!",
            Name = "User"
        };

        var input = new RunAgentInput
        {
            ThreadId = "thread-1",
            RunId = "run-1",
            Messages = ImmutableList.Create<BaseMessage>(userMessage),
            Tools = ImmutableList<Tool>.Empty,
            Context = ImmutableList<Context>.Empty,
            State = JsonDocument.Parse("{}").RootElement,
            ForwardedProps = JsonDocument.Parse("{}").RootElement
        };

        // Setup the response from the chat client
        var responseText = "Hello, I'm an assistant!";
        var messageId = "assistant-msg-1";

        // Create a test chat client that simulates streaming response
        var serviceProvider = new ServiceCollection().BuildServiceProvider();

        // Create a streaming chat client that returns a simulated response
        var chatClient = new TestStreamingChatClient(
            serviceProvider,
            (sp, messages, options, ct) => GenerateStreamingResponseAsync(messageId, responseText, ct));

        // Local async iterator method to generate streaming response
        async IAsyncEnumerable<ChatResponseUpdate> GenerateStreamingResponseAsync(string msgId, string text, [EnumeratorCancellation] CancellationToken ct)
        {
            // Simulate a delay for realistic streaming behavior
            await Task.Delay(10, ct);

            // Yield a single update with text content
            yield return new ChatResponseUpdate
            {
                MessageId = msgId,
                Contents = new[] { new TextContent(text) }
            };
        }

        // Create the agent under test
        var agent = new ChatClientAgent(chatClient);

        // Act - collect all events using the extension method
        var eventList = new List<BaseEvent>();
        await foreach (var evt in agent.RunToCompletionAsync(input))
        {
            eventList.Add(evt);
        }

        // Assert
        Assert.Contains(eventList, e => e is RunStartedEvent);
        Assert.Contains(eventList, e => e is RunFinishedEvent);

        var textStartEvent = Assert.Single(eventList.OfType<TextMessageStartEvent>());
        Assert.Equal(messageId, textStartEvent.MessageId);

        var textContentEvent = Assert.Single(eventList.OfType<TextMessageContentEvent>());
        Assert.Equal(messageId, textContentEvent.MessageId);
        Assert.Equal(responseText, textContentEvent.Delta);

        var textEndEvent = Assert.Single(eventList.OfType<TextMessageEndEvent>());
        Assert.Equal(messageId, textEndEvent.MessageId);
    }

    [Fact]
    public async Task SystemMessage_ShouldBePreservedInChatRequest()
    {
        // Arrange
        var systemMessage = new SystemMessage
        {
            Id = "sys-msg-1",
            Content = "You are a helpful assistant.",
        };

        var userMessage = new UserMessage
        {
            Id = "user-msg-1",
            Content = "Hello, assistant!",
            Name = "User"
        };

        var input = new RunAgentInput
        {
            ThreadId = "thread-1",
            RunId = "run-1",
            Messages = ImmutableList.Create<BaseMessage>(systemMessage, userMessage),
            Tools = ImmutableList<Tool>.Empty,
            Context = ImmutableList<Context>.Empty,
            State = JsonDocument.Parse("{}").RootElement,
            ForwardedProps = JsonDocument.Parse("{}").RootElement
        };

        // Track the messages passed to the chat client
        List<ChatMessage> passedMessages = new List<ChatMessage>();

        // Setup the response from the chat client
        var responseText = "Hello, I'm an assistant!";
        var messageId = "assistant-msg-1";

        // Create a test chat client that simulates streaming response
        var serviceProvider = new ServiceCollection().BuildServiceProvider();

        // Create a streaming chat client that returns a simulated response and captures the messages
        var chatClient = new TestStreamingChatClient(
            serviceProvider,
            (sp, messages, options, ct) =>
            {
                // Capture the messages passed to the client
                passedMessages.AddRange(messages);
                return GenerateStreamingResponseAsync(messageId, responseText, ct);
            });

        // Local async iterator method to generate streaming response
        async IAsyncEnumerable<ChatResponseUpdate> GenerateStreamingResponseAsync(string msgId, string text, [EnumeratorCancellation] CancellationToken ct)
        {
            await Task.Delay(10, ct);
            yield return new ChatResponseUpdate
            {
                MessageId = msgId,
                Contents = new[] { new TextContent(text) }
            };
        }

        // Create the agent under test with default options (which preserves system messages)
        var agent = new ChatClientAgent(chatClient);

        // Act - collect all events using the extension method
        var eventList = new List<BaseEvent>();
        await foreach (var evt in agent.RunToCompletionAsync(input))
        {
            eventList.Add(evt);
        }

        // Assert
        // Verify that a system message was passed to the chat client
        Assert.Contains(passedMessages, m => m.Role == ChatRole.System);
        var systemMsg = passedMessages.First(m => m.Role == ChatRole.System);
        Assert.Equal(systemMessage.Content, ((TextContent)systemMsg.Contents[0]).Text);

        // Verify that a user message was passed to the chat client
        Assert.Contains(passedMessages, m => m.Role == ChatRole.User);
        var userMsg = passedMessages.First(m => m.Role == ChatRole.User);
        Assert.Equal(userMessage.Content, ((TextContent)userMsg.Contents[0]).Text);

        // Verify we got expected events
        Assert.Contains(eventList, e => e is RunStartedEvent);
        Assert.Contains(eventList, e => e is RunFinishedEvent);
        Assert.Contains(eventList, e => e is TextMessageStartEvent);
    }

    [Fact]
    public async Task SystemMessage_ShouldBeDiscardedWhenPreserveInboundSystemMessagesIsFalse()
    {
        // Arrange
        var systemMessage = new SystemMessage
        {
            Id = "sys-msg-1",
            Content = "You are a helpful assistant.",
        };

        var userMessage = new UserMessage
        {
            Id = "user-msg-1",
            Content = "Hello, assistant!",
            Name = "User"
        };

        var input = new RunAgentInput
        {
            ThreadId = "thread-1",
            RunId = "run-1",
            Messages = ImmutableList.Create<BaseMessage>(systemMessage, userMessage),
            Tools = ImmutableList<Tool>.Empty,
            Context = ImmutableList<Context>.Empty,
            State = JsonDocument.Parse("{}").RootElement,
            ForwardedProps = JsonDocument.Parse("{}").RootElement
        };

        // Track the messages passed to the chat client
        List<ChatMessage> passedMessages = new List<ChatMessage>();

        // Setup the response from the chat client
        var responseText = "Hello, I'm an assistant!";
        var messageId = "assistant-msg-1";

        // Create a test chat client that simulates streaming response
        var serviceProvider = new ServiceCollection().BuildServiceProvider();

        // Create a streaming chat client that returns a simulated response and captures the messages
        var chatClient = new TestStreamingChatClient(
            serviceProvider,
            (sp, messages, options, ct) =>
            {
                // Capture the messages passed to the client
                passedMessages.AddRange(messages);
                return GenerateStreamingResponseAsync(messageId, responseText, ct);
            });

        // Local async iterator method to generate streaming response
        async IAsyncEnumerable<ChatResponseUpdate> GenerateStreamingResponseAsync(string msgId, string text, [EnumeratorCancellation] CancellationToken ct)
        {
            await Task.Delay(10, ct);
            yield return new ChatResponseUpdate
            {
                MessageId = msgId,
                Contents = new[] { new TextContent(text) }
            };
        }

        // Create the agent under test with PreserveInboundSystemMessages set to false
        var agentOptions = new ChatClientAgentOptions
        {
            PreserveInboundSystemMessages = false
        };
        var agent = new ChatClientAgent(chatClient, agentOptions);

        // Act - collect all events using the extension method
        var eventList = new List<BaseEvent>();
        await foreach (var evt in agent.RunToCompletionAsync(input))
        {
            eventList.Add(evt);
        }

        // Assert
        // Verify that no system message was passed to the chat client
        Assert.DoesNotContain(passedMessages, m => m.Role == ChatRole.System);

        // Verify that a user message was passed to the chat client
        Assert.Contains(passedMessages, m => m.Role == ChatRole.User);
        var userMsg = passedMessages.First(m => m.Role == ChatRole.User);
        Assert.Equal(userMessage.Content, ((TextContent)userMsg.Contents[0]).Text);

        // Verify we got expected events
        Assert.Contains(eventList, e => e is RunStartedEvent);
        Assert.Contains(eventList, e => e is RunFinishedEvent);
        Assert.Contains(eventList, e => e is TextMessageStartEvent);
    }

    [Fact]
    public async Task SystemMessage_ShouldBeOverriddenWhenSystemMessageOptionIsProvided()
    {
        // Arrange
        var systemMessage = new SystemMessage
        {
            Id = "sys-msg-1",
            Content = "You are a helpful assistant.",
        };

        var userMessage = new UserMessage
        {
            Id = "user-msg-1",
            Content = "Hello, assistant!",
            Name = "User"
        };

        var input = new RunAgentInput
        {
            ThreadId = "thread-1",
            RunId = "run-1",
            Messages = ImmutableList.Create<BaseMessage>(systemMessage, userMessage),
            Tools = ImmutableList<Tool>.Empty,
            Context = ImmutableList<Context>.Empty,
            State = JsonDocument.Parse("{}").RootElement,
            ForwardedProps = JsonDocument.Parse("{}").RootElement
        };

        // Track the messages passed to the chat client
        List<ChatMessage> passedMessages = new List<ChatMessage>();

        // Setup the response from the chat client
        var responseText = "Hello, I'm an assistant!";
        var messageId = "assistant-msg-1";
        var overrideSystemMessage = "You are an AI coding assistant.";

        // Create a test chat client that simulates streaming response
        var serviceProvider = new ServiceCollection().BuildServiceProvider();

        // Create a streaming chat client that returns a simulated response and captures the messages
        var chatClient = new TestStreamingChatClient(
            serviceProvider,
            (sp, messages, options, ct) =>
            {
                // Capture the messages passed to the client
                passedMessages.AddRange(messages);
                return GenerateStreamingResponseAsync(messageId, responseText, ct);
            });

        // Local async iterator method to generate streaming response
        async IAsyncEnumerable<ChatResponseUpdate> GenerateStreamingResponseAsync(string msgId, string text, [EnumeratorCancellation] CancellationToken ct)
        {
            await Task.Delay(10, ct);
            yield return new ChatResponseUpdate
            {
                MessageId = msgId,
                Contents = new[] { new TextContent(text) }
            };
        }

        // Create the agent under test with a custom system message
        var agentOptions = new ChatClientAgentOptions
        {
            SystemMessage = overrideSystemMessage
        };
        var agent = new ChatClientAgent(chatClient, agentOptions);

        // Act - collect all events using the extension method
        var eventList = new List<BaseEvent>();
        await foreach (var evt in agent.RunToCompletionAsync(input))
        {
            eventList.Add(evt);
        }

        // Assert
        // Verify that a system message was passed to the chat client
        Assert.Contains(passedMessages, m => m.Role == ChatRole.System);
        var systemMsg = passedMessages.First(m => m.Role == ChatRole.System);

        // Verify the system message was overridden
        Assert.Equal(overrideSystemMessage, ((TextContent)systemMsg.Contents[0]).Text);
        Assert.NotEqual(systemMessage.Content, ((TextContent)systemMsg.Contents[0]).Text);

        // Verify that a user message was passed to the chat client
        Assert.Contains(passedMessages, m => m.Role == ChatRole.User);
        var userMsg = passedMessages.First(m => m.Role == ChatRole.User);
        Assert.Equal(userMessage.Content, ((TextContent)userMsg.Contents[0]).Text);

        // Verify we got expected events
        Assert.Contains(eventList, e => e is RunStartedEvent);
        Assert.Contains(eventList, e => e is RunFinishedEvent);
    }

    [Fact]
    public async Task FrontendToolCall_ShouldBeEmittedWithEvents()
    {
        // Arrange
        var userMessage = new UserMessage
        {
            Id = "user-msg-1",
            Content = "Call the search tool please",
            Name = "User"
        };

        // Create a frontend tool to be passed to the agent
        var searchTool = new Tool
        {
            Name = "search",
            Description = "Search for information",
            Parameters = JsonDocument.Parse(@"{
                ""type"": ""object"",
                ""properties"": {
                    ""query"": {
                        ""type"": ""string"",
                        ""description"": ""The search query""
                    }
                },
                ""required"": [""query""]
            }").RootElement
        };

        var input = new RunAgentInput
        {
            ThreadId = "thread-1",
            RunId = "run-1",
            Messages = ImmutableList.Create<BaseMessage>(userMessage),
            Tools = ImmutableList.Create(searchTool),
            Context = ImmutableList<Context>.Empty,
            State = JsonDocument.Parse("{}").RootElement,
            ForwardedProps = JsonDocument.Parse("{}").RootElement
        };

        // Create a test chat client that simulates a tool call
        var serviceProvider = new ServiceCollection().BuildServiceProvider();

        // Set up the tool call details
        var toolCallId = "tool-call-1";
        var messageId = "assistant-msg-1";
        var toolName = "search";
        var toolArgs = @"{""query"":""test search""}";

        // Create a streaming chat client that returns a simulated tool call
        var chatClient = new TestStreamingChatClient(
            serviceProvider,
            (sp, messages, options, ct) => GenerateToolCallResponseAsync(messageId, toolCallId, toolName, toolArgs, ct));

        // Local async iterator method to generate a tool call response
        async IAsyncEnumerable<ChatResponseUpdate> GenerateToolCallResponseAsync(
            string msgId, string callId, string name, string args, [EnumeratorCancellation] CancellationToken ct)
        {
            await Task.Delay(10, ct);

            // Yield an update with a function call content
            yield return new ChatResponseUpdate
            {
                MessageId = msgId,
                Contents = new[] { new FunctionCallContent(
                    callId,
                    name,
                    JsonSerializer.Deserialize<Dictionary<string, object?>>(args)
                )}
            };
        }

        // Create the agent under test
        var agent = new ChatClientAgent(chatClient);

        // Act - collect all events using the extension method
        var eventList = new List<BaseEvent>();
        await foreach (var evt in agent.RunToCompletionAsync(input))
        {
            eventList.Add(evt);
        }

        // Assert
        // Verify the tool call events were emitted
        var toolCallStartEvent = Assert.Single(eventList.OfType<ToolCallStartEvent>());
        Assert.Equal(toolCallId, toolCallStartEvent.ToolCallId);
        Assert.Equal(toolName, toolCallStartEvent.ToolCallName);

        var toolCallArgsEvent = Assert.Single(eventList.OfType<ToolCallArgsEvent>());
        Assert.Equal(toolCallId, toolCallArgsEvent.ToolCallId);
        // The actual JSON might have different formatting, so deserialize and compare the content
        var expectedArgs = JsonSerializer.Deserialize<Dictionary<string, object?>>(toolArgs);
        var actualArgs = JsonSerializer.Deserialize<Dictionary<string, object?>>(toolCallArgsEvent.Delta);
        Assert.Equal(expectedArgs?["query"]?.ToString(), actualArgs?["query"]?.ToString());

        var toolCallEndEvent = Assert.Single(eventList.OfType<ToolCallEndEvent>());
        Assert.Equal(toolCallId, toolCallEndEvent.ToolCallId);
    }
}