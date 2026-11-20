using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Server.UnitTests;

public sealed class RunAgentInputExtensionsTest
{
    [Fact]
    public void TryGetRunAgentState_NoInput_ReturnsFalse()
    {
        var options = new ChatOptions();

        Assert.False(options.TryGetRunAgentState(RunAgentStateJsonSerializerContext.Default.DocumentState, out var state));
        Assert.Null(state);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("null")]
    public void TryGetRunAgentState_NoState_ReturnsFalse(string? json)
    {
        var options = CreateOptions(json);

        Assert.False(options.TryGetRunAgentState(RunAgentStateJsonSerializerContext.Default.DocumentState, out var state));
        Assert.Null(state);
    }

    [Fact]
    public void TryGetRunAgentState_UndefinedState_ReturnsFalse()
    {
        var input = new RunAgentInput { State = default(JsonElement) };
        var options = input.ToChatRequestContext(AGUIJsonSerializerContext.Default.Options).ChatOptions;

        Assert.False(options.TryGetRunAgentState(RunAgentStateJsonSerializerContext.Default.DocumentState, out var state));
        Assert.Null(state);
    }

    [Fact]
    public void TryGetRunAgentState_Object_UsesProvidedMetadataAndDoesNotMutateInput()
    {
        var options = CreateOptions("""{"document_title":"Draft","revision":2}""");

        Assert.True(options.TryGetRunAgentState(RunAgentStateJsonSerializerContext.Default.DocumentState, out var state));
        Assert.NotNull(state);
        Assert.Equal("Draft", state.DocumentTitle);
        Assert.Equal(2, state.Revision);

        state.DocumentTitle = "Changed";
        Assert.True(options.TryGetRunAgentInput(out var input));
        Assert.Equal("Draft", input.State!.Value.GetProperty("document_title").GetString());
        Assert.Equal(2, input.State.Value.GetProperty("revision").GetInt32());
    }

    [Fact]
    public void TryGetRunAgentState_CustomConverter_ReturningNullStillReportsSuppliedState()
    {
        var options = CreateOptions("{}");
        var serializerOptions = new JsonSerializerOptions();
        serializerOptions.Converters.Add(new NullDocumentStateConverter());
        var context = new RunAgentStateJsonSerializerContext(serializerOptions);

        Assert.True(options.TryGetRunAgentState(context.DocumentState, out var state));
        Assert.Null(state);
    }

    [Fact]
    public void TryGetRunAgentState_EmptyObject_ReturnsTrue()
    {
        var options = CreateOptions("{}");

        Assert.True(options.TryGetRunAgentState(RunAgentStateJsonSerializerContext.Default.DocumentState, out var state));
        Assert.NotNull(state);
        Assert.Equal(string.Empty, state.DocumentTitle);
        Assert.Equal(0, state.Revision);
    }

    [Theory]
    [InlineData("0", 0)]
    [InlineData("42", 42)]
    public void TryGetRunAgentState_ValueType_ReturnsTrue(string json, int expected)
    {
        var options = CreateOptions(json);

        Assert.True(options.TryGetRunAgentState(RunAgentStateJsonSerializerContext.Default.Int32, out var state));
        Assert.Equal(expected, state);
    }

    [Fact]
    public void TryGetRunAgentState_MissingValueType_ReturnsFalseWithDefault()
    {
        var options = CreateOptions(null);

        Assert.False(options.TryGetRunAgentState(RunAgentStateJsonSerializerContext.Default.Int32, out var state));
        Assert.Equal(0, state);
    }

    [Fact]
    public void TryGetRunAgentState_Array_ReturnsTypedArray()
    {
        var options = CreateOptions("[1,2]");

        Assert.True(options.TryGetRunAgentState(RunAgentStateJsonSerializerContext.Default.Int32Array, out var state));
        Assert.Equal(new[] { 1, 2 }, state);
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("42")]
    [InlineData("{\"revision\":\"invalid\"}")]
    public void TryGetRunAgentState_IncompatibleState_ThrowsJsonException(string json)
    {
        var options = CreateOptions(json);

        Assert.Throws<JsonException>(() => options.TryGetRunAgentState(RunAgentStateJsonSerializerContext.Default.DocumentState, out _));
    }

    [Fact]
    public void TryGetRunAgentState_NullOptions_ThrowsArgumentNullException()
    {
        Assert.Throws<ArgumentNullException>("options", () =>
            ((ChatOptions)null!).TryGetRunAgentState(RunAgentStateJsonSerializerContext.Default.DocumentState, out _));
    }

    [Fact]
    public void TryGetRunAgentState_NullMetadata_ThrowsEvenWithoutState()
    {
        Assert.Throws<ArgumentNullException>("jsonTypeInfo", () =>
            new ChatOptions().TryGetRunAgentState((JsonTypeInfo<DocumentState>)null!, out _));
    }

    private static ChatOptions CreateOptions(string? json)
    {
        using var document = json is null ? null : JsonDocument.Parse(json);
        var input = new RunAgentInput { State = document?.RootElement.Clone() };
        return input.ToChatRequestContext(AGUIJsonSerializerContext.Default.Options).ChatOptions;
    }
}
