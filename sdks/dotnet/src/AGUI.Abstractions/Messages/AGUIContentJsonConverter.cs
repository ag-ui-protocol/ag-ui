using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Reads and writes an <see cref="AGUIContent"/> as the wire's
/// <c>string | ContentPart[]</c>: a JSON string stays a string, a JSON array is
/// read part by part through the <c>type</c> discriminator. Applied by attribute
/// to <see cref="AGUIToolMessage.Content"/> and <see cref="ToolCallResultEvent.Content"/>;
/// the hand-serialised user message calls the same two helpers.
/// </summary>
public sealed class AGUIContentJsonConverter : JsonConverter<AGUIContent>
{
    public override AGUIContent Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        var jsonElementTypeInfo = options.GetTypeInfo(typeof(JsonElement));
        JsonElement jsonElement = (JsonElement)JsonSerializer.Deserialize(ref reader, jsonElementTypeInfo)!;
        return ReadContent(jsonElement, options);
    }

    public override void Write(
        Utf8JsonWriter writer,
        AGUIContent value,
        JsonSerializerOptions options)
    {
        WriteContentValue(writer, value, options);
    }

    /// <summary>
    /// Reads a <c>content</c> value: a string, or an array of discriminated parts.
    /// Any other JSON kind is a malformed document rather than content.
    /// </summary>
    internal static AGUIContent ReadContent(JsonElement element, JsonSerializerOptions options)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.String:
                return element.GetString() ?? string.Empty;
            case JsonValueKind.Array:
            {
                var parts = new List<AGUIInputContent>();
                foreach (var partElement in element.EnumerateArray())
                {
                    if (!partElement.TryGetProperty("type", out var typeProp))
                    {
                        throw new JsonException("Missing 'type' discriminator in ContentPart");
                    }

                    var partType = typeProp.GetString();
                    AGUIInputContent? part = partType switch
                    {
                        AGUIInputContentTypes.Text => partElement.Deserialize(
                            options.GetTypeInfo(typeof(AGUITextInputContent))) as AGUITextInputContent,
                        AGUIInputContentTypes.Image => partElement.Deserialize(
                            options.GetTypeInfo(typeof(AGUIImageInputContent))) as AGUIImageInputContent,
                        AGUIInputContentTypes.Audio => partElement.Deserialize(
                            options.GetTypeInfo(typeof(AGUIAudioInputContent))) as AGUIAudioInputContent,
                        AGUIInputContentTypes.Video => partElement.Deserialize(
                            options.GetTypeInfo(typeof(AGUIVideoInputContent))) as AGUIVideoInputContent,
                        AGUIInputContentTypes.Document => partElement.Deserialize(
                            options.GetTypeInfo(typeof(AGUIDocumentInputContent))) as AGUIDocumentInputContent,
                        _ => throw new JsonException($"Unknown ContentPart type: '{partType}'")
                    };

                    if (part is not null)
                    {
                        parts.Add(part);
                    }
                }

                return parts;
            }
            default:
                throw new JsonException(
                    $"Content must be a string or an array of parts, not {element.ValueKind}");
        }
    }

    /// <summary>
    /// Writes a named <c>content</c> property: plain text as a string, a single bare
    /// text part collapsed to its string, and anything else as the parts array.
    /// </summary>
    internal static void WriteContent(
        Utf8JsonWriter writer,
        string propertyName,
        AGUIContent content,
        JsonSerializerOptions options)
    {
        writer.WritePropertyName(propertyName);
        WriteContentValue(writer, content, options);
    }

    private static void WriteContentValue(Utf8JsonWriter writer, AGUIContent content, JsonSerializerOptions options)
    {
        switch (content.Value)
        {
            case string text:
                writer.WriteStringValue(text);
                break;
            case IList<AGUIInputContent> parts
                when parts.Count == 1
                    && parts[0] is AGUITextInputContent { Id: null, Metadata: null } singleText:
                // A lone text part carrying nothing but its text is the string
                // form; one carrying an id or metadata is written as the array,
                // or those fields would be lost.
                writer.WriteStringValue(singleText.Text);
                break;
            case IList<AGUIInputContent> parts when parts.Count > 0:
                writer.WriteStartArray();
                foreach (var part in parts)
                {
                    JsonSerializer.Serialize(writer, part, options.GetTypeInfo(typeof(AGUIInputContent)));
                }

                writer.WriteEndArray();
                break;
            default:
                // Default-constructed content (no value) reads as the empty string,
                // which is what the wire has always carried for "nothing returned".
                writer.WriteStringValue(string.Empty);
                break;
        }
    }
}
