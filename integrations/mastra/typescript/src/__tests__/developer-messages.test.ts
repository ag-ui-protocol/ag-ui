import { MessageList } from "@mastra/core/agent/message-list";
import { convertAGUIMessagesToMastra } from "../utils";
import {
  collectEvents,
  FakeLocalAgent,
  FakeMemory,
  FakeRemoteAgent,
  makeInput,
  makeLocalMastraAgent,
  makeRemoteMastraAgent,
} from "./helpers";

const developer = {
  id: "d1",
  role: "developer" as const,
  content: "Answer in German.",
};

it("keeps developer instructions out of stored user history on replay", () => {
  const converted = convertAGUIMessagesToMastra([developer]);
  const first = new MessageList({ threadId: "t", resourceId: "r" });
  first.add(converted, "input");
  expect(first.get.all.db()).toEqual([]);

  const second = new MessageList({ threadId: "t", resourceId: "r" });
  second.add(first.get.all.db(), "memory");
  second.add(converted, "input");
  expect(second.get.all.db()).toEqual([]);
  expect(second.getAllSystemMessages()).toEqual([
    expect.objectContaining({ role: "system", content: developer.content }),
  ]);
});

it("retains current developer instructions even when their id is recalled", async () => {
  const memory = new FakeMemory();
  memory.recallMessages = [
    { id: "d1", role: "user" },
    { id: "u1", role: "user" },
  ];
  const agent = makeLocalMastraAgent({ memory });
  await collectEvents(
    agent,
    makeInput({
      messages: [
        { id: "u1", role: "user", content: "Earlier turn" },
        developer,
        { id: "u2", role: "user", content: "Hi" },
      ],
    }),
  );
  expect((agent.agent as unknown as FakeLocalAgent).lastStreamMessages).toEqual(
    [
      { id: "d1", role: "system", content: developer.content },
      { id: "u2", role: "user", content: "Hi" },
    ],
  );
});

it("forwards developer-only input to a remote agent as system instructions", async () => {
  const agent = makeRemoteMastraAgent();
  await collectEvents(agent, makeInput({ messages: [developer] }));
  expect(
    (agent.agent as unknown as FakeRemoteAgent).lastStreamMessages,
  ).toEqual([{ id: "d1", role: "system", content: developer.content }]);
});
