import { TextMessageStartEventSchema, TextMessageChunkEventSchema, EventType } from "../events";

describe("Event role defaults", () => {
  it("should default TextMessageStartEvent role to 'assistant' when not provided", () => {
    const eventData = {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "test-msg",
      // role not provided
    };

    const parsed = TextMessageStartEventSchema.parse(eventData);
    
    expect(parsed.type).toBe(EventType.TEXT_MESSAGE_START);
    expect(parsed.messageId).toBe("test-msg");
    expect(parsed.role).toBe("assistant"); // Should default to assistant
  });

  it("should allow overriding the default role in TextMessageStartEvent", () => {
    const eventData = {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "test-msg",
      role: "user",
    };

    const parsed = TextMessageStartEventSchema.parse(eventData);
    
    expect(parsed.type).toBe(EventType.TEXT_MESSAGE_START);
    expect(parsed.messageId).toBe("test-msg");
    expect(parsed.role).toBe("user"); // Should use provided role
  });

  it("should accept all valid text message roles in TextMessageStartEvent", () => {
    const textMessageRoles = ["developer", "system", "assistant", "user"];
    
    textMessageRoles.forEach(role => {
      const eventData = {
        type: EventType.TEXT_MESSAGE_START,
        messageId: `test-msg-${role}`,
        role,
      };

      const parsed = TextMessageStartEventSchema.parse(eventData);
      expect(parsed.role).toBe(role);
    });
  });

  it("should keep role optional in TextMessageChunkEvent", () => {
    const eventDataWithoutRole = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "test-msg",
      delta: "test content",
      // role not provided
    };

    const parsed1 = TextMessageChunkEventSchema.parse(eventDataWithoutRole);
    expect(parsed1.role).toBeUndefined(); // Should be undefined when not provided

    const eventDataWithRole = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "test-msg",
      role: "user",
      delta: "test content",
    };

    const parsed2 = TextMessageChunkEventSchema.parse(eventDataWithRole);
    expect(parsed2.role).toBe("user"); // Should use provided role
  });

  it("should reject invalid roles", () => {
    const invalidEventData = {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "test-msg",
      role: "invalid_role",
    };

    expect(() => {
      TextMessageStartEventSchema.parse(invalidEventData);
    }).toThrow();
  });

  it("should reject 'tool' role for text messages", () => {
    // Test TextMessageStartEvent with tool role
    const startEventWithToolRole = {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "test-msg",
      role: "tool",
    };

    expect(() => {
      TextMessageStartEventSchema.parse(startEventWithToolRole);
    }).toThrow();

    // Test TextMessageChunkEvent with tool role
    const chunkEventWithToolRole = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "test-msg",
      role: "tool",
      delta: "content",
    };

    expect(() => {
      TextMessageChunkEventSchema.parse(chunkEventWithToolRole);
    }).toThrow();
  });
});