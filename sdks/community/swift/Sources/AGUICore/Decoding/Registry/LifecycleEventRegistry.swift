// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

enum LifecycleEventRegistry {
    typealias DecodeHandler = AGUIEventDecoder.DecodeHandler

    static func registry() -> [EventType: DecodeHandler] {
        [
            .runStarted: { data, decoder in
                try RunStartedEventDTO.decode(from: data, decoder: decoder).toDomain(rawEvent: data)
            },
            .runFinished: { data, decoder in
                try RunFinishedEventDTO.decode(from: data, decoder: decoder).toDomain(rawEvent: data)
            },
            .runError: { data, decoder in
                try RunErrorEventDTO.decode(from: data, decoder: decoder).toDomain(rawEvent: data)
            },
            .stepStarted: { data, decoder in
                try decoder.decode(StepStartedEventDTO.self, from: data).toDomain(rawEvent: data)
            },
            .stepFinished: { data, decoder in
                try decoder.decode(StepFinishedEventDTO.self, from: data).toDomain(rawEvent: data)
            },
            .subagentStarted: subagent(.subagentStarted),
            .subagentFinished: subagent(.subagentFinished),
            .subagentError: subagent(.subagentError)
        ]
    }

    private static func subagent(_ type: EventType) -> DecodeHandler {
        { data, _ in
            guard let object = (try JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let id = object["subagentRunId"] as? String else {
                throw EventDecodingError.decodingFailed("Missing subagentRunId")
            }
            return SubagentEvent(eventType: type, subagentRunId: id, name: object["name"] as? String,
                                 timestamp: object["timestamp"] as? Int64, rawEvent: data)
        }
    }
}
