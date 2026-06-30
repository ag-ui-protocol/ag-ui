using System.Text.Json;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class RunFinishedEventTest
{
    [Fact]
    public void Serialization_WithOutcomeAndResult()
    {
        var resultElement = JsonSerializer.SerializeToElement(new { answer = 42 });
        var evt = new RunFinishedEvent
        {
            ThreadId = "t1",
            RunId = "r1",
            Outcome = new RunFinishedSuccessOutcome(),
            Result = resultElement
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.RunFinishedEvent);
        using var doc = JsonDocument.Parse(json);

        Assert.Equal("RUN_FINISHED", doc.RootElement.GetProperty("type").GetString());
        Assert.Equal("t1", doc.RootElement.GetProperty("threadId").GetString());
        Assert.Equal("r1", doc.RootElement.GetProperty("runId").GetString());
        Assert.Equal("success", doc.RootElement.GetProperty("outcome").GetProperty("type").GetString());
        Assert.Equal(42, doc.RootElement.GetProperty("result").GetProperty("answer").GetInt32());
    }

    [Fact]
    public void Serialization_WithInterrupt()
    {
        var evt = new RunFinishedEvent
        {
            ThreadId = "t1",
            Outcome = new RunFinishedInterruptOutcome
            {
                Interrupts =
                [
                    new AGUIInterrupt
                    {
                        Id = "int-1",
                        Reason = InterruptReasons.InputRequired,
                        Message = "need_input"
                    }
                ]
            }
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.RunFinishedEvent);
        using var doc = JsonDocument.Parse(json);

        Assert.Equal("RUN_FINISHED", doc.RootElement.GetProperty("type").GetString());
        Assert.Equal("interrupt", doc.RootElement.GetProperty("outcome").GetProperty("type").GetString());

        var interrupts = doc.RootElement.GetProperty("outcome").GetProperty("interrupts");
        Assert.Equal(1, interrupts.GetArrayLength());
        Assert.Equal("int-1", interrupts[0].GetProperty("id").GetString());
        Assert.Equal("need_input", interrupts[0].GetProperty("message").GetString());
    }

    [Fact]
    public void Serialization_OmitsNullProperties()
    {
        var evt = new RunFinishedEvent();

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.RunFinishedEvent);
        using var doc = JsonDocument.Parse(json);

        Assert.Equal("RUN_FINISHED", doc.RootElement.GetProperty("type").GetString());
        Assert.Equal("", doc.RootElement.GetProperty("threadId").GetString());
        Assert.Equal("", doc.RootElement.GetProperty("runId").GetString());
        Assert.False(doc.RootElement.TryGetProperty("outcome", out _));
        Assert.False(doc.RootElement.TryGetProperty("result", out _));
    }
}
