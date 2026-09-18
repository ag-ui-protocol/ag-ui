package com.agui.core.types

import kotlinx.serialization.modules.SerializersModule
import kotlinx.serialization.modules.polymorphic
import kotlinx.serialization.modules.subclass

/**
 * Defines polymorphic serialization for all AG-UI Data Types.
 */
val AgUiSerializersModule by lazy {
    SerializersModule {
        // Polymorphic serialization for events
        polymorphic(BaseEvent::class) {
            // Lifecycle Events (5)
            subclass(RunStartedEvent::class)
            subclass(RunFinishedEvent::class)
            subclass(RunErrorEvent::class)
            subclass(StepStartedEvent::class)
            subclass(StepFinishedEvent::class)

            // Text Message Events (3)
            subclass(TextMessageStartEvent::class)
            subclass(TextMessageContentEvent::class)
            subclass(TextMessageEndEvent::class)

            // Tool Call Events (3)
            subclass(ToolCallStartEvent::class)
            subclass(ToolCallArgsEvent::class)
            subclass(ToolCallEndEvent::class)
            subclass(ToolCallResultEvent::class)

            // State Management Events (3)
            subclass(StateSnapshotEvent::class)
            subclass(StateDeltaEvent::class)
            subclass(MessagesSnapshotEvent::class)

            // Special Events (2)
            subclass(RawEvent::class)
            subclass(CustomEvent::class)

            subclass(TextMessageChunkEvent::class)
            subclass(ToolCallChunkEvent::class)
            subclass(ActivitySnapshotEvent::class)
            subclass(ActivityDeltaEvent::class)
            subclass(ReasoningStartEvent::class)
            subclass(ReasoningMessageStartEvent::class)
            subclass(ReasoningMessageContentEvent::class)
            subclass(ReasoningMessageEndEvent::class)
            subclass(ReasoningMessageChunkEvent::class)
            subclass(ReasoningEndEvent::class)
            subclass(ReasoningEncryptedValueEvent::class)
            subclass(SubagentStartedEvent::class)
            subclass(SubagentFinishedEvent::class)
            subclass(SubagentErrorEvent::class)
        }

        polymorphic(Message::class) {
            subclass(DeveloperMessage::class)
            subclass(SystemMessage::class)
            subclass(AssistantMessage::class)
            subclass(UserMessage::class)
            subclass(ToolMessage::class)
            subclass(ActivityMessage::class)
            subclass(ReasoningMessage::class)
        }

        // Polymorphic serialization for RUN_FINISHED outcomes
        polymorphic(RunFinishedOutcome::class) {
            subclass(RunFinishedSuccessOutcome::class)
            subclass(RunFinishedInterruptOutcome::class)
            subclass(RunFinishedCancelledOutcome::class)
        }

        polymorphic(SubagentFinishedOutcome::class) {
            subclass(SubagentFinishedSuccessOutcome::class)
            subclass(SubagentFinishedSuspendedOutcome::class)
        }
    }
}
