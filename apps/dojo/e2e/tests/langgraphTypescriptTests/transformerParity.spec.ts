import { test, expect } from "../../event-trace-test";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";
import { transformerParityEventTrace } from "./transformerParity.event-trace";
test("LangGraph greeting preserves the established V2 contract", async ({
  page,
  eventTrace,
}) => {
  await page.goto("/langgraph-typescript/feature/agentic_chat");
  const chat = new AgenticChatPage(page);
  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();
  await chat.sendMessage("Hi, I am duaa");
  await chat.assertAgentReplyVisible(
    /Hello duaa! How can I assist you today\?/,
  );
  await eventTrace.expectJourney(transformerParityEventTrace.greeting);
});
