import { test, expect } from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test("[CrewAI] Crew Chat sends and receives a message (dict state path)", async ({
  page,
}) => {
  await page.goto("/crewai/feature/crew_chat");

  const chat = new AgenticChatPage(page);

  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();
  await chat.sendMessage("Hello from crew test");

  await chat.assertUserMessageVisible("Hello from crew test");
  await chat.assertAgentReplyVisible(/crew chat assistant/i);
});

test("[CrewAI] Crew Chat handles follow-up messages (dict state path)", async ({
  page,
}) => {
  await page.goto("/crewai/feature/crew_chat");

  const chat = new AgenticChatPage(page);

  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();

  await chat.sendMessage("Hello from crew test");
  await chat.assertUserMessageVisible("Hello from crew test");
  await chat.assertAgentReplyVisible(/crew chat assistant/i);

  await chat.sendMessage("What is 2 plus 2");
  await chat.assertUserMessageVisible("What is 2 plus 2");
  await chat.assertAgentReplyVisible(/equals 4/i);
});

test("[CrewAI] Crew Chat handles crew_exit tool call (dict state path)", async ({
  page,
}) => {
  await page.goto("/crewai/feature/crew_chat");

  const chat = new AgenticChatPage(page);

  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();

  await chat.sendMessage("goodbye crew");
  await chat.assertUserMessageVisible("goodbye crew");
  await chat.assertAgentReplyVisible(/crew has been shut down/i);
});
