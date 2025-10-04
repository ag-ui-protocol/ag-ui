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

            // State Management Events (3)
            subclass(StateSnapshotEvent::class)
            subclass(StateDeltaEvent::class)
            subclass(MessagesSnapshotEvent::class)

            // Special Events (2)
            subclass(RawEvent::class)
            subclass(CustomEvent::class)
        }

        polymorphic(Message::class) {
            subclass(DeveloperMessage::class)
            subclass(SystemMessage::class)
            subclass(AssistantMessage::class)
            subclass(UserMessage::class)
            subclass(ToolMessage::class)
        }
    }
}