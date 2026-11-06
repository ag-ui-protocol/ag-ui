using System.Text.Json;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class AGUIUserMetadataTest
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void UserMetadata_SurvivesNativeSerialization(bool emptyContent)
    {
        ChatMessage native;
        using (var document = JsonDocument.Parse("""
            {"copilotkit.a2uiAction":{"version":1,"label":"Book flight"},"nested":{"values":[null,42,true]}}
            """))
        {
            var source = new AGUIUserMessage
            {
                Id = "action-1",
                Name = "Alice",
                SubagentRunId = "child-1",
                Metadata = document.RootElement,
                Content = emptyContent ? [] : [new AGUITextInputContent { Text = "exact action JSON" }]
            };
            native = Assert.Single(new[] { source }.AsChatMessages());
        }

        Assert.NotNull(native.AdditionalProperties);
        var metadata = Assert.IsType<JsonElement>(native.AdditionalProperties["agui.metadata"]);
        Assert.Equal("Book flight", metadata.GetProperty("copilotkit.a2uiAction").GetProperty("label").GetString());
        var serialized = JsonSerializer.Serialize(native);
        var cold = JsonSerializer.Deserialize<ChatMessage>(serialized)!;
        var restored = Assert.IsType<AGUIUserMessage>(Assert.Single(new[] { cold }.AsAGUIMessages(AGUIJsonSerializerContext.Default.Options)));
        Assert.Equal("action-1", restored.Id);
        Assert.Equal("Alice", restored.Name);
        Assert.Equal("Book flight", restored.Metadata!.Value.GetProperty("copilotkit.a2uiAction").GetProperty("label").GetString());
        Assert.Equal(42, restored.Metadata.Value.GetProperty("nested").GetProperty("values")[1].GetInt32());
        Assert.Equal(JsonValueKind.Null, restored.Metadata.Value.GetProperty("nested").GetProperty("values")[0].ValueKind);
        Assert.True(restored.Metadata.Value.GetProperty("nested").GetProperty("values")[2].GetBoolean());
        Assert.Equal(emptyContent ? string.Empty : "exact action JSON", cold.Text);
    }

    [Fact]
    public void UserMetadata_WithMedia_RestoresDetachedMetadataWithoutChangingParts()
    {
        using var metadata = JsonDocument.Parse("""{"copilotkit.a2uiAction":{"version":1,"label":"Book flight"}}""");
        var source = new AGUIUserMessage
        {
            Id = "mixed-1",
            Metadata = metadata.RootElement,
            Content =
            [
                new AGUITextInputContent { Text = "original" },
                new AGUIImageInputContent
                {
                    Source = new AGUIInputContentDataSource { Value = "AQID", MimeType = "image/png" }
                }
            ]
        };
        var native = Assert.Single(new[] { source }.AsChatMessages());
        var cold = JsonSerializer.Deserialize<ChatMessage>(JsonSerializer.Serialize(native))!;
        var restored = Assert.IsType<AGUIUserMessage>(Assert.Single(new[] { cold }.AsAGUIMessages(AGUIJsonSerializerContext.Default.Options)));
        Assert.Equal(2, restored.Content.Count);
        Assert.Equal("original", Assert.IsType<AGUITextInputContent>(restored.Content[0]).Text);
        var image = Assert.IsType<AGUIImageInputContent>(restored.Content[1]);
        Assert.Equal("AQID", Assert.IsType<AGUIInputContentDataSource>(image.Source).Value);
        Assert.Equal("Book flight", restored.Metadata!.Value.GetProperty("copilotkit.a2uiAction").GetProperty("label").GetString());

        AGUIMessage detached;
        using (var document = JsonDocument.Parse("""{"nested":{"value":true}}"""))
        {
            native.AdditionalProperties!["agui.metadata"] = document.RootElement;
            detached = Assert.Single(new[] { native }.AsAGUIMessages(AGUIJsonSerializerContext.Default.Options));
        }

        Assert.True(detached.Metadata!.Value.GetProperty("nested").GetProperty("value").GetBoolean());
        Assert.Equal("Book flight", source.Metadata!.Value.GetProperty("copilotkit.a2uiAction").GetProperty("label").GetString());
    }

    [Fact]
    public void NonUserMetadata_IsNotPromoted()
    {
        using var document = JsonDocument.Parse("""{"copilotkit.a2uiAction":{"version":1,"label":"Book flight"}}""");
        var properties = new AdditionalPropertiesDictionary { ["agui.metadata"] = document.RootElement };
        ChatMessage[] native =
        [
            new(ChatRole.Assistant, "answer") { AdditionalProperties = properties },
            new(ChatRole.Tool, [new FunctionResultContent("call-1", "result")]) { AdditionalProperties = properties }
        ];
        Assert.All(native.AsAGUIMessages(AGUIJsonSerializerContext.Default.Options), message => Assert.Null(message.Metadata));
    }

    [Fact]
    public void MissingMetadata_DoesNotPromoteUnrelatedNativeProperties()
    {
        var native = new ChatMessage(ChatRole.User, "ordinary")
        {
            AdditionalProperties = new() { ["metadata"] = "unrelated", ["private"] = "kept" }
        };
        var restored = Assert.Single(new[] { native }.AsAGUIMessages(AGUIJsonSerializerContext.Default.Options));
        Assert.Null(restored.Metadata);
        Assert.Equal("kept", native.AdditionalProperties["private"]);
        var forward = Assert.Single(new[] { new AGUIUserMessage() }.AsChatMessages());
        Assert.Null(forward.AdditionalProperties);
    }
}
