import { UserMessageSchema, assertUserMessageHasBody, userMessageHasBody } from "../types";
import { MessagesSnapshotEventSchema, EventType } from "../events";

describe("UserMessageSchema attachments", () => {
  it("accepts messages with text content only", () => {
    const message = UserMessageSchema.parse({
      id: "msg-1",
      role: "user",
      content: "Hello",
    });

    expect(message.content).toBe("Hello");
    expect(message.attachments).toBeUndefined();
  });

  it("accepts messages with attachments only", () => {
    const message = UserMessageSchema.parse({
      id: "msg-2",
      role: "user",
      attachments: [
        {
          url: "data:image/png;base64,somepngbytes",
        },
      ],
    });

    expect(message.content).toBeUndefined();
    expect(message.attachments?.length).toBe(1);
    expect(message.attachments?.[0].url).toBe("https://example.com/file.pdf");
    expect(userMessageHasBody(message)).toBe(true);
  });

  it("rejects messages without content or attachments", () => {
    expect(() =>
      UserMessageSchema.parse({
        id: "msg-3",
        role: "user",
      }),
    ).toThrow(/must include content or at least one attachment/);
  });

  it("rejects attachments with invalid URLs", () => {
    expect(() =>
      UserMessageSchema.parse({
        id: "msg-4",
        role: "user",
        attachments: [
          {
            url: "not-a-valid-url",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects empty attachment arrays when content missing", () => {
    expect(() =>
      UserMessageSchema.parse({
        id: "msg-5",
        role: "user",
        attachments: [],
      }),
    ).toThrow(/must include content or at least one attachment/);
  });

  it("throws via assert helper when body missing", () => {
    expect(() =>
      assertUserMessageHasBody({
        id: "msg-6",
        role: "user",
      } as any),
    ).toThrow(/must include content or at least one attachment/);
  });

  it("parses message snapshots containing attachments", () => {
    const parsed = MessagesSnapshotEventSchema.parse({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        {
          id: "msg-7",
          role: "user",
          attachments: [
            {
              url: "data:application/json;base64,somejsonbytes",
            },
          ],
        },
      ],
    });

    expect(parsed.messages[0].attachments?.[0].url).toBe(
      "data:application/json;base64,somejsonbytes",
    );
  });
});
