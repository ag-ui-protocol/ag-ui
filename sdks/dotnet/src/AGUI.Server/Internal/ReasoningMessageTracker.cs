using System.Collections.Generic;
using AGUI.Abstractions;

namespace AGUI.Server;

internal sealed class ReasoningMessageTracker
{
    private string? _phaseMessageId;
    private string? _currentMessageId;

    public bool IsActive => _phaseMessageId is not null;

    public IEnumerable<BaseEvent> Open(string messageId)
    {
        if (_phaseMessageId is null)
        {
            _phaseMessageId = messageId;
            yield return new ReasoningStartEvent { MessageId = messageId };
        }

        if (_currentMessageId is null)
        {
            _currentMessageId = messageId;
            yield return new ReasoningMessageStartEvent { MessageId = messageId };
        }
    }

    public BaseEvent EmitDelta(string delta) =>
        new ReasoningMessageContentEvent
        {
            MessageId = _currentMessageId!,
            Delta = delta
        };

    public IEnumerable<BaseEvent> Close()
    {
        if (_currentMessageId is { } messageId)
        {
            _currentMessageId = null;
            yield return new ReasoningMessageEndEvent { MessageId = messageId };
        }

        if (_phaseMessageId is { } phaseId)
        {
            _phaseMessageId = null;
            yield return new ReasoningEndEvent { MessageId = phaseId };
        }
    }
}
