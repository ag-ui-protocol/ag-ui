using System.Collections.Immutable;
using System.Text.Json;
using AGUIDotnet.Integrations.ChatClient;
using AGUIDotnet.Types;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUIDotnet.Tests;

public class ChatClientMessageMapperTests
{
    [Theory]
    [InlineData("test content", "test name")]
    [InlineData("", null)]
    public void MapSystemMessage_ShouldMapCorrectly(string content, string? name)
    {
        // Arrange
        var message = new SystemMessage
        {
            Id = "sys1",
            Content = content,
            Name = name
        };

        // Act
        var result = new[] { message }.MapAGUIMessagesToChatClientMessages();

        // Assert
        Assert.Single(result);
        var chatMessage = result[0];
        Assert.Equal(ChatRole.System, chatMessage.Role);
        var textContent = Assert.Single(chatMessage.Contents);
        Assert.IsType<TextContent>(textContent);
        Assert.Equal(content, ((TextContent)textContent).Text);
        Assert.Equal(name, chatMessage.AuthorName);
        Assert.Equal(message.Id, chatMessage.MessageId);
    }

    [Theory]
    [InlineData("test content", "test name")]
    [InlineData("", null)]
    public void MapUserMessage_ShouldMapCorrectly(string content, string? name)
    {
        // Arrange
        var message = new UserMessage
        {
            Id = "usr1",
            Content = content,
            Name = name
        };

        // Act
        var result = new[] { message }.MapAGUIMessagesToChatClientMessages();

        // Assert
        Assert.Single(result);
        var chatMessage = result[0];
        Assert.Equal(ChatRole.User, chatMessage.Role);
        var textContent = Assert.Single(chatMessage.Contents);
        Assert.IsType<TextContent>(textContent);
        Assert.Equal(content, ((TextContent)textContent).Text);
        Assert.Equal(name, chatMessage.AuthorName);
        Assert.Equal(message.Id, chatMessage.MessageId);
    }

    [Theory]
    [InlineData("test content")]
    [InlineData("")]
    [InlineData(null)]
    public void MapAssistantMessage_ShouldMapCorrectly(string? content)
    {
        // Arrange
        var message = new AssistantMessage
        {
            Id = "asst1",
            Content = content
        };

        // Act
        var result = new[] { message }.MapAGUIMessagesToChatClientMessages();

        // Assert
        Assert.Single(result);
        var chatMessage = result[0];
        Assert.Equal(ChatRole.Assistant, chatMessage.Role);
        Assert.Equal(message.Id, chatMessage.MessageId);

        if (string.IsNullOrWhiteSpace(content))
        {
            Assert.Empty(chatMessage.Contents);
        }
        else
        {
            Assert.Single(chatMessage.Contents);
            Assert.IsType<TextContent>(chatMessage.Contents[0]);
            Assert.Equal(content, ((TextContent)chatMessage.Contents[0]).Text);
        }
    }

    [Fact]
    public void MapAssistantMessage_WithToolCalls_ShouldMapCorrectly()
    {
        // Arrange
        var message = new AssistantMessage
        {
            Id = "asst2",
            Content = "test content",
            ToolCalls =
            [
                new ToolCall
                {
                    Id = "testId",
                    Function = new FunctionCall
                    {
                        Name = "testFunc",
                        Arguments = "{\"param1\": \"value1\"}"
                    }
                }
            ]
        };

        // Act
        var result = new[] { message }.MapAGUIMessagesToChatClientMessages();

        // Assert
        Assert.Single(result);
        var chatMessage = result[0];
        Assert.Equal(2, chatMessage.Contents.Count);
        Assert.IsType<TextContent>(chatMessage.Contents[0]);
        Assert.IsType<FunctionCallContent>(chatMessage.Contents[1]);

        var functionCall = (FunctionCallContent)chatMessage.Contents[1];
        Assert.Equal("testId", functionCall.CallId);
        Assert.Equal("testFunc", functionCall.Name);
        Assert.NotNull(functionCall.Arguments);
        Assert.True(functionCall.Arguments!.TryGetValue("param1", out var paramValue));
        Assert.NotNull(paramValue);
        var jsonElement = (JsonElement)paramValue;
        var stringValue = jsonElement.GetString();
        Assert.NotNull(stringValue);
        Assert.Equal("value1", stringValue);
    }

    [Fact]
    public void MapToolMessage_ShouldMapCorrectly()
    {
        // Arrange
        var message = new ToolMessage
        {
            Id = "tool1",
            ToolCallId = "testId",
            Content = "test content"
        };

        // Act
        var result = new[] { message }.MapAGUIMessagesToChatClientMessages();

        // Assert
        Assert.Single(result);
        var chatMessage = result[0];
        Assert.Equal(ChatRole.Tool, chatMessage.Role);
        Assert.Equal(message.Id, chatMessage.MessageId);
        Assert.Single(chatMessage.Contents);
        Assert.IsType<FunctionResultContent>(chatMessage.Contents[0]);

        var functionResult = (FunctionResultContent)chatMessage.Contents[0];
        Assert.Equal("testId", functionResult.CallId);
        Assert.Equal("test content", functionResult.Result);
    }

    [Fact]
    public void MapMessages_ShouldFilterOutIrrelevantTypes()
    {
        // Arrange
        var messages = new BaseMessage[]
        {
            new SystemMessage { Id = "sys1", Content = "system" },
            new DeveloperMessage { Id = "dev1", Content = "developer" }, // Should be filtered out
            new UserMessage { Id = "usr1", Content = "user" },
            new AssistantMessage { Id = "asst1", Content = "assistant" },
            new ToolMessage { Id = "tool1", ToolCallId = "toolId", Content = "tool" },
        };

        // Act
        var result = messages.MapAGUIMessagesToChatClientMessages();

        // Assert
        Assert.Equal(4, result.Count);
        Assert.Collection(result,
            msg => Assert.Equal(ChatRole.System, msg.Role),
            msg => Assert.Equal(ChatRole.User, msg.Role),
            msg => Assert.Equal(ChatRole.Assistant, msg.Role),
            msg => Assert.Equal(ChatRole.Tool, msg.Role)
        );
    }

    [Fact]
    public void MapMessages_WithUnsupportedType_ShouldStripMessage()
    {
        // Arrange
        var messages = new BaseMessage[]
        {
            new CustomMessage { Id = "custom1", Content = "custom" } // This should be stripped
        };

        // Act
        var result = messages.MapAGUIMessagesToChatClientMessages();

        // Assert
        Assert.Empty(result);
    }

    private record CustomMessage : BaseMessage
    {
        public required string Content { get; init; }
    }
}