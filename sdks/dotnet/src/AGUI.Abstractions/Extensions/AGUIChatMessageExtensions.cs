using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Microsoft.Extensions.AI;

namespace AGUI.Abstractions;

/// <summary>
/// Extension methods for converting between AG-UI messages and <see cref="ChatMessage"/> instances.
/// </summary>
public static class AGUIChatMessageExtensions
{
    private static readonly ChatRole s_developerChatRole = new("developer");

    /// <summary>
    /// Converts a sequence of <see cref="AGUIMessage"/> instances to <see cref="ChatMessage"/> instances.
    /// </summary>
    /// <param name="aguiMessages">The AG-UI messages to convert.</param>
    /// <returns>A sequence of <see cref="ChatMessage"/> instances.</returns>
    public static IEnumerable<ChatMessage> AsChatMessages(this IEnumerable<AGUIMessage> aguiMessages)
    {
        // Accumulates a run of consecutive assistant messages that carry tool calls. Clients such
        // as @ag-ui/client split a single parallel-tool-call turn into one assistant message per
        // call, producing assistant(call_1), assistant(call_2), tool(call_1), tool(call_2).
        // Providers (e.g. OpenAI) reject that: an assistant tool_calls message must be immediately
        // followed by its tool results. Merging the run back into a single assistant message keeps
        // the reconstructed history valid. Only the current run is buffered, so this stays cheap.
        List<AIContent>? pendingToolCallContents = null;
        string? pendingToolCallId = null;

        foreach (var message in aguiMessages)
        {
            if (message is AGUIAssistantMessage toolCallAssistant && toolCallAssistant.ToolCalls is { Count: > 0 })
            {
                pendingToolCallContents ??= new List<AIContent>();
                pendingToolCallId ??= message.Id;

                if (!string.IsNullOrEmpty(toolCallAssistant.Content))
                {
                    pendingToolCallContents.Add(new TextContent(toolCallAssistant.Content));
                }

                foreach (var toolCall in toolCallAssistant.ToolCalls)
                {
                    pendingToolCallContents.Add(new FunctionCallContent(
                        toolCall.Id,
                        toolCall.Function.Name,
                        toolCall.Function.Arguments is { Length: > 0 }
                            ? (IDictionary<string, object?>?)JsonSerializer.Deserialize(
                                toolCall.Function.Arguments,
                                AGUIJsonSerializerContext.Default.GetTypeInfo(typeof(IDictionary<string, object?>))!)
                            : null));
                }

                continue;
            }

            // Any non-(assistant-with-tool-calls) message ends the current run; flush it first.
            if (pendingToolCallContents is not null)
            {
                yield return new ChatMessage(ChatRole.Assistant, pendingToolCallContents) { MessageId = pendingToolCallId };
                pendingToolCallContents = null;
                pendingToolCallId = null;
            }

            var role = MapChatRole(message.Role);

            if (message is AGUIUserMessage userMessage && userMessage.Content.Count > 0)
            {
                var authorName = userMessage.Name;
                var contents = new List<AIContent>();
                foreach (var inputContent in userMessage.Content)
                {
                    switch (inputContent)
                    {
                        case AGUITextInputContent textInput:
                            contents.Add(new TextContent(textInput.Text));
                            break;
                        case AGUIMediaInputContent mediaInput:
                            contents.Add(ConvertMediaInputContent(mediaInput));
                            break;
                        case AGUIBinaryInputContent binaryInput:
                            if (binaryInput.Url is not null)
                            {
                                var uriContent = new UriContent(new Uri(binaryInput.Url), binaryInput.MimeType);
                                if (binaryInput.Filename is not null)
                                {
                                    uriContent.AdditionalProperties ??= new AdditionalPropertiesDictionary();
                                    uriContent.AdditionalProperties["filename"] = binaryInput.Filename;
                                }

                                contents.Add(uriContent);
                            }
                            else if (binaryInput.Data is not null)
                            {
                                var bytes = Convert.FromBase64String(binaryInput.Data);
                                var dataContent = new DataContent(bytes, binaryInput.MimeType);
                                if (binaryInput.Filename is not null)
                                {
                                    dataContent.AdditionalProperties ??= new AdditionalPropertiesDictionary();
                                    dataContent.AdditionalProperties["filename"] = binaryInput.Filename;
                                }

                                contents.Add(dataContent);
                            }

                            break;
                    }
                }

                yield return new ChatMessage(role, contents) { MessageId = message.Id, AuthorName = authorName };
            }
            else if (message is AGUIToolMessage toolMessage)
            {
                var contents = new List<AIContent>
                {
                    new FunctionResultContent(toolMessage.ToolCallId ?? string.Empty, toolMessage.Content)
                };

                yield return new ChatMessage(role, contents)
                {
                    MessageId = message.Id
                };
            }
            else
            {
                var text = message switch
                {
                    AGUIAssistantMessage assistant => assistant.Content ?? string.Empty,
                    AGUISystemMessage system => system.Content,
                    AGUIDeveloperMessage developer => developer.Content,
                    AGUIReasoningMessage reasoning => reasoning.Content,
                    _ => string.Empty,
                };

                yield return new ChatMessage(role, text)
                {
                    MessageId = message.Id
                };
            }
        }

        // Flush any trailing assistant-tool-call run.
        if (pendingToolCallContents is not null)
        {
            yield return new ChatMessage(ChatRole.Assistant, pendingToolCallContents) { MessageId = pendingToolCallId };
        }
    }

    private static AIContent ConvertMediaInputContent(AGUIMediaInputContent mediaInput)
    {
        AIContent content = mediaInput.Source switch
        {
            AGUIInputContentDataSource dataSource =>
                new DataContent(Convert.FromBase64String(dataSource.Value), dataSource.MimeType),
            AGUIInputContentUrlSource urlSource =>
                new UriContent(new Uri(urlSource.Value, UriKind.RelativeOrAbsolute), urlSource.MimeType),
            _ => throw new NotSupportedException(
                $"Input content source type '{mediaInput.Source?.Type ?? "<null>"}' is not supported.")
        };

        ApplyMediaMetadata(content, mediaInput.Metadata);
        return content;
    }

    private static void ApplyMediaMetadata(AIContent content, JsonElement? metadata)
    {
        if (metadata is not { } value)
        {
            return;
        }

        if (value.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in value.EnumerateObject())
            {
                content.AdditionalProperties ??= new AdditionalPropertiesDictionary();
                content.AdditionalProperties[property.Name] = property.Value.Clone();

                if (content is DataContent dataContent &&
                    property.NameEquals("filename") &&
                    property.Value.ValueKind == JsonValueKind.String)
                {
                    dataContent.Name = property.Value.GetString();
                }
            }
        }
        else
        {
            content.AdditionalProperties = new AdditionalPropertiesDictionary
            {
                ["metadata"] = value.Clone()
            };
        }
    }

    /// <summary>
    /// Converts a sequence of <see cref="ChatMessage"/> instances to <see cref="AGUIMessage"/> instances.
    /// </summary>
    /// <param name="chatMessages">The chat messages to convert.</param>
    /// <returns>A sequence of <see cref="AGUIMessage"/> instances.</returns>
    public static IEnumerable<AGUIMessage> AsAGUIMessages(this IEnumerable<ChatMessage> chatMessages)
    {
        foreach (var message in chatMessages)
        {
            AGUIMessage aguiMessage;
            if (message.Role == ChatRole.User)
            {
                var userMsg = new AGUIUserMessage { Name = message.AuthorName };
                var parts = new List<AGUIInputContent>();
                foreach (var content in message.Contents)
                {
                    switch (content)
                    {
                        case TextContent textContent:
                            parts.Add(new AGUITextInputContent { Text = textContent.Text ?? string.Empty });
                            break;
                        case DataContent dataContent:
                            parts.Add(ConvertMediaContent(
                                dataContent.MediaType,
                                new AGUIInputContentDataSource
                                {
                                    Value = Convert.ToBase64String(dataContent.Data.ToArray()),
                                    MimeType = dataContent.MediaType ?? string.Empty
                                },
                                dataContent.AdditionalProperties,
                                dataContent.Name));
                            break;
                        case UriContent uriContent:
                            parts.Add(ConvertMediaContent(
                                uriContent.MediaType,
                                new AGUIInputContentUrlSource
                                {
                                    Value = uriContent.Uri?.ToString() ?? string.Empty,
                                    MimeType = uriContent.MediaType
                                },
                                uriContent.AdditionalProperties));
                            break;
                        default:
                            parts.Add(new AGUITextInputContent { Text = content.ToString() ?? string.Empty });
                            break;
                    }
                }

                userMsg.Content = parts;
                aguiMessage = userMsg;
            }
            else if (message.Role == ChatRole.Assistant)
            {
                var functionCalls = message.Contents.OfType<FunctionCallContent>().ToList();
                var assistantMsg = new AGUIAssistantMessage
                {
                    Content = string.IsNullOrEmpty(message.Text) ? null : message.Text
                };
                if (functionCalls.Count > 0)
                {
                    assistantMsg.ToolCalls = new List<AGUIToolCall>();
                    foreach (var fc in functionCalls)
                    {
                        assistantMsg.ToolCalls.Add(new AGUIToolCall
                        {
                            Id = fc.CallId ?? string.Empty,
                            Type = "function",
                            Function = new AGUIToolCallFunction
                            {
                                Name = fc.Name ?? string.Empty,
                                Arguments = fc.Arguments is not null
                                    ? JsonSerializer.Serialize(
                                        fc.Arguments,
                                        AGUIJsonSerializerContext.Default.GetTypeInfo(typeof(IDictionary<string, object?>))!)
                                    : string.Empty
                            }
                        });
                    }
                }

                aguiMessage = assistantMsg;
            }
            else if (message.Role == ChatRole.System)
            {
                aguiMessage = new AGUISystemMessage { Content = message.Text ?? string.Empty };
            }
            else if (message.Role == s_developerChatRole)
            {
                aguiMessage = new AGUIDeveloperMessage { Content = message.Text ?? string.Empty };
            }
            else if (message.Role == ChatRole.Tool)
            {
                // Mirror Microsoft.Extensions.AI (OpenAIChatClient.ToOpenAIChatMessages): a tool
                // message is materialized only from FunctionResultContent items, each keyed on its
                // tool call id. MEAI batches parallel tool results into a single tool ChatMessage,
                // so emit one AGUIToolMessage per result to preserve them all. Any tool-role content
                // without a FunctionResultContent has no tool call id to attach to and is ignored,
                // rather than synthesizing a message with an empty toolCallId.
                foreach (var functionResult in message.Contents.OfType<FunctionResultContent>())
                {
                    yield return new AGUIToolMessage
                    {
                        Id = functionResult.CallId,
                        ToolCallId = functionResult.CallId,
                        Content = SerializeFunctionResult(functionResult, message.Text)
                    };
                }

                continue;
            }
            else
            {
                aguiMessage = new AGUIUserMessage
                {
                    Content = [new AGUITextInputContent { Text = message.Text ?? string.Empty }]
                };
            }

            aguiMessage.Id = message.MessageId;
            yield return aguiMessage;
        }
    }

    private static AGUIMediaInputContent ConvertMediaContent(
        string? mediaType,
        AGUIInputContentSource source,
        AdditionalPropertiesDictionary? additionalProperties,
        string? filename = null)
    {
        AGUIMediaInputContent content = mediaType switch
        {
            { } value when value.StartsWith("image/", StringComparison.OrdinalIgnoreCase) =>
                new AGUIImageInputContent(),
            { } value when value.StartsWith("audio/", StringComparison.OrdinalIgnoreCase) =>
                new AGUIAudioInputContent(),
            { } value when value.StartsWith("video/", StringComparison.OrdinalIgnoreCase) =>
                new AGUIVideoInputContent(),
            _ => new AGUIDocumentInputContent()
        };

        content.Source = source;
        content.Metadata = ConvertAdditionalProperties(additionalProperties, filename);
        return content;
    }

    private static JsonElement? ConvertAdditionalProperties(
        AdditionalPropertiesDictionary? additionalProperties,
        string? filename)
    {
        if ((additionalProperties is null || additionalProperties.Count == 0) &&
            string.IsNullOrEmpty(filename))
        {
            return null;
        }

        IDictionary<string, object?> metadata = new Dictionary<string, object?>();
        if (additionalProperties is not null)
        {
            foreach (var property in additionalProperties)
            {
                metadata[property.Key] = property.Value;
            }
        }

        if (!string.IsNullOrEmpty(filename) && !metadata.ContainsKey("filename"))
        {
            metadata["filename"] = filename;
        }

        return JsonSerializer.SerializeToElement(
            metadata,
            AGUIJsonSerializerContext.Default.GetTypeInfo(typeof(IDictionary<string, object?>))!);
    }

    /// <summary>
    /// Maps an AG-UI role string to a <see cref="ChatRole"/>.
    /// </summary>
    /// <param name="role">The AG-UI role string.</param>
    /// <returns>The corresponding <see cref="ChatRole"/>.</returns>
    public static ChatRole MapChatRole(string role) =>
        string.Equals(role, AGUIRoles.System, StringComparison.OrdinalIgnoreCase) ? ChatRole.System :
        string.Equals(role, AGUIRoles.User, StringComparison.OrdinalIgnoreCase) ? ChatRole.User :
        string.Equals(role, AGUIRoles.Assistant, StringComparison.OrdinalIgnoreCase) ? ChatRole.Assistant :
        string.Equals(role, AGUIRoles.Developer, StringComparison.OrdinalIgnoreCase) ? s_developerChatRole :
        string.Equals(role, AGUIRoles.Tool, StringComparison.OrdinalIgnoreCase) ? ChatRole.Tool :
        throw new InvalidOperationException($"Unknown chat role: {role}");

    private static string SerializeFunctionResult(FunctionResultContent functionResult, string? fallbackText)
    {
        switch (functionResult.Result)
        {
            case string stringResult:
                return stringResult;
            case JsonElement jsonElement:
                return jsonElement.GetRawText();
            case IDictionary<string, object?>:
                return JsonSerializer.Serialize(
                    functionResult.Result,
                    AGUIJsonSerializerContext.Default.GetTypeInfo(typeof(IDictionary<string, object?>))!);
            case not null:
                var resultTypeInfo = AGUIJsonSerializerContext.Default.GetTypeInfo(functionResult.Result.GetType());
                return resultTypeInfo is not null
                    ? JsonSerializer.Serialize(functionResult.Result, resultTypeInfo)
                    : functionResult.Result.ToString() ?? string.Empty;
            default:
                return fallbackText ?? string.Empty;
        }
    }
}
