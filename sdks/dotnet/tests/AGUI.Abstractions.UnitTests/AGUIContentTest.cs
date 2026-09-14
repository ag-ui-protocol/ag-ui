using System.Collections.Generic;
using System.Text.Json;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class AGUIContentTest
{
    [Fact]
    public void ImplicitFromString_StoresTextAndSurfacesAsSingleTextPart()
    {
        AGUIContent content = "hello";

        Assert.True(content.IsText);
        Assert.Equal("hello", content.Value);
        var single = Assert.Single(content);
        Assert.Equal("hello", Assert.IsType<AGUITextInputContent>(single).Text);
    }

    [Fact]
    public void ImplicitFromList_StoresPartsAndIsNotText()
    {
        var parts = new List<AGUIInputContent>
        {
            new AGUITextInputContent { Text = "a" },
            new AGUITextInputContent { Text = "b" },
        };

        AGUIContent content = parts;

        Assert.False(content.IsText);
        Assert.Equal(2, content.Count);
        Assert.Equal("a", Assert.IsType<AGUITextInputContent>(content[0]).Text);
        Assert.Equal("b", Assert.IsType<AGUITextInputContent>(content[1]).Text);
    }

    [Fact]
    public void CollectionExpression_InitializesParts()
    {
        AGUIContent content = [new AGUITextInputContent { Text = "x" }, new AGUITextInputContent { Text = "y" }];

        Assert.False(content.IsText);
        Assert.Collection(
            content,
            part => Assert.Equal("x", Assert.IsType<AGUITextInputContent>(part).Text),
            part => Assert.Equal("y", Assert.IsType<AGUITextInputContent>(part).Text));
    }

    [Fact]
    public void Default_IsEmpty()
    {
        AGUIContent content = default;

        Assert.Null(content.Value);
        Assert.False(content.IsText);
        Assert.Empty(content);
    }

    [Fact]
    public void UserMessage_StringContent_SerializesAsJsonString()
    {
        AGUIMessage message = new AGUIUserMessage { Id = "u1", Content = "hello" };

        var json = JsonSerializer.Serialize(message, AGUIJsonSerializerContext.Default.AGUIMessage);
        using var doc = JsonDocument.Parse(json);

        Assert.Equal("user", doc.RootElement.GetProperty("role").GetString());
        var contentElement = doc.RootElement.GetProperty("content");
        Assert.Equal(JsonValueKind.String, contentElement.ValueKind);
        Assert.Equal("hello", contentElement.GetString());
    }

    [Fact]
    public void UserMessage_MultipleParts_SerializesAsArray()
    {
        AGUIMessage message = new AGUIUserMessage
        {
            Id = "u1",
            Content = [new AGUITextInputContent { Text = "a" }, new AGUITextInputContent { Text = "b" }],
        };

        var json = JsonSerializer.Serialize(message, AGUIJsonSerializerContext.Default.AGUIMessage);
        using var doc = JsonDocument.Parse(json);

        var contentElement = doc.RootElement.GetProperty("content");
        Assert.Equal(JsonValueKind.Array, contentElement.ValueKind);
        Assert.Equal(2, contentElement.GetArrayLength());
        Assert.Equal("text", contentElement[0].GetProperty("type").GetString());
    }

    [Fact]
    public void UserMessage_StringContent_RoundTrips()
    {
        AGUIMessage message = new AGUIUserMessage { Id = "u1", Content = "round trip" };

        var json = JsonSerializer.Serialize(message, AGUIJsonSerializerContext.Default.AGUIMessage);
        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.AGUIMessage);

        var user = Assert.IsType<AGUIUserMessage>(deserialized);
        Assert.Equal("round trip", Assert.IsType<AGUITextInputContent>(Assert.Single(user.Content)).Text);
    }

    [Fact]
    public void UserMessage_DeserializesStringContent_AsSingleTextPart()
    {
        var json = """{ "id": "u1", "role": "user", "content": "hi there" }""";

        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.AGUIMessage);

        var user = Assert.IsType<AGUIUserMessage>(deserialized);
        var part = Assert.Single(user.Content);
        Assert.Equal("hi there", Assert.IsType<AGUITextInputContent>(part).Text);
    }

    [Fact]
    public void ToolMessage_Parts_SerializeAsArrayAndRoundTrip()
    {
        AGUIMessage message = new AGUIToolMessage
        {
            Id = "t1",
            ToolCallId = "c1",
            Content =
            [
                new AGUITextInputContent { Id = "p1", Text = "Invoice attached.", Metadata = JsonSerializer.SerializeToElement(new { title = "INV-2291" }) },
                new AGUIDocumentInputContent
                {
                    Source = new AGUIInputContentUrlSource { Value = "https://example.com/i.pdf", MimeType = "application/pdf" },
                },
            ],
        };

        var json = JsonSerializer.Serialize(message, AGUIJsonSerializerContext.Default.AGUIMessage);
        using var doc = JsonDocument.Parse(json);
        var contentElement = doc.RootElement.GetProperty("content");
        Assert.Equal(JsonValueKind.Array, contentElement.ValueKind);
        Assert.Equal("p1", contentElement[0].GetProperty("id").GetString());
        Assert.Equal("INV-2291", contentElement[0].GetProperty("metadata").GetProperty("title").GetString());
        Assert.Equal("document", contentElement[1].GetProperty("type").GetString());

        var tool = Assert.IsType<AGUIToolMessage>(JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.AGUIMessage));
        var parts = Assert.IsType<List<AGUIInputContent>>(tool.Content.Value);
        Assert.Equal("Invoice attached.", Assert.IsType<AGUITextInputContent>(parts[0]).Text);
        Assert.Equal("https://example.com/i.pdf", Assert.IsType<AGUIInputContentUrlSource>(Assert.IsType<AGUIDocumentInputContent>(parts[1]).Source).Value);
    }

    [Fact]
    public void ToolMessage_StringContent_StillWritesAString()
    {
        AGUIMessage message = new AGUIToolMessage { Id = "t1", ToolCallId = "c1", Content = "3 results" };

        var json = JsonSerializer.Serialize(message, AGUIJsonSerializerContext.Default.AGUIMessage);
        using var doc = JsonDocument.Parse(json);

        Assert.Equal("3 results", doc.RootElement.GetProperty("content").GetString());
        var tool = Assert.IsType<AGUIToolMessage>(JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.AGUIMessage));
        Assert.Equal("3 results", tool.Content.Value);
    }

    [Fact]
    public void ToolCallResultEvent_Parts_RoundTrip()
    {
        var evt = new ToolCallResultEvent
        {
            MessageId = "m2",
            ToolCallId = "c1",
            Content = [new AGUITextInputContent { Text = "a" }, new AGUITextInputContent { Text = "b" }],
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ToolCallResultEvent);
        using var doc = JsonDocument.Parse(json);
        Assert.Equal(2, doc.RootElement.GetProperty("content").GetArrayLength());

        var typed = Assert.IsType<ToolCallResultEvent>(JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent));
        Assert.Equal(2, typed.Content.Count);
        Assert.Equal("ab", typed.Content.ToString());
    }

    [Fact]
    public void SingleTextPart_WithIdOrMetadata_IsWrittenAsArray_SoNothingIsLost()
    {
        AGUIMessage message = new AGUIToolMessage
        {
            Id = "t1",
            ToolCallId = "c1",
            Content =
            [
                new AGUITextInputContent { Id = "p1", Text = "hit", Metadata = JsonSerializer.SerializeToElement(new { title = "Source" }) },
            ],
        };

        var json = JsonSerializer.Serialize(message, AGUIJsonSerializerContext.Default.AGUIMessage);
        using var doc = JsonDocument.Parse(json);
        var contentElement = doc.RootElement.GetProperty("content");
        Assert.Equal(JsonValueKind.Array, contentElement.ValueKind);
        Assert.Equal("p1", contentElement[0].GetProperty("id").GetString());
        Assert.Equal("Source", contentElement[0].GetProperty("metadata").GetProperty("title").GetString());

        var tool = Assert.IsType<AGUIToolMessage>(JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.AGUIMessage));
        var part = Assert.IsType<AGUITextInputContent>(Assert.Single(Assert.IsType<List<AGUIInputContent>>(tool.Content.Value)));
        Assert.Equal("p1", part.Id);
        Assert.Equal("Source", part.Metadata!.Value.GetProperty("title").GetString());
    }

    [Fact]
    public void SingleBareTextPart_StillCollapsesToAString()
    {
        AGUIMessage message = new AGUIToolMessage
        {
            Id = "t1",
            ToolCallId = "c1",
            Content = [new AGUITextInputContent { Text = "just text" }],
        };

        var json = JsonSerializer.Serialize(message, AGUIJsonSerializerContext.Default.AGUIMessage);
        using var doc = JsonDocument.Parse(json);
        Assert.Equal("just text", doc.RootElement.GetProperty("content").GetString());
    }

    [Fact]
    public void ToString_FlattensToText_DroppingMedia()
    {
        AGUIContent content =
        [
            new AGUITextInputContent { Text = "a" },
            new AGUIImageInputContent { Source = new AGUIInputContentUrlSource { Value = "https://example.com/x.png" } },
            new AGUITextInputContent { Text = "b" },
        ];

        Assert.Equal("ab", content.ToString());
        Assert.Equal("plain", new AGUIContent("plain").ToString());
        Assert.Equal(string.Empty, default(AGUIContent).ToString());
    }
}
