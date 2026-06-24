using System.Text.Json;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class RunErrorEventTest
{
    [Fact]
    public void Serialization_RoundTrips()
    {
        var evt = new RunErrorEvent
        {
            Message = "Something went wrong",
            Code = "ERR_001"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.RunErrorEvent);
        using var doc = JsonDocument.Parse(json);

        Assert.Equal("RUN_ERROR", doc.RootElement.GetProperty("type").GetString());
        Assert.Equal("Something went wrong", doc.RootElement.GetProperty("message").GetString());
        Assert.Equal("ERR_001", doc.RootElement.GetProperty("code").GetString());
    }

    [Fact]
    public void Serialization_OmitsNullCode()
    {
        var evt = new RunErrorEvent
        {
            Message = "error"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.RunErrorEvent);
        using var doc = JsonDocument.Parse(json);

        Assert.Equal("RUN_ERROR", doc.RootElement.GetProperty("type").GetString());
        Assert.Equal("error", doc.RootElement.GetProperty("message").GetString());
        Assert.False(doc.RootElement.TryGetProperty("code", out _));
    }
}
