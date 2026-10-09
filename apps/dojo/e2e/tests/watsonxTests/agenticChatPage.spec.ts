import { expect, test } from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";
import { gotoAndAwaitRuntimeInfo } from "../../utils/copilot-actions";
import { WATSONX_PROMPTS, WATSONX_REPLIES } from "../../watsonx-fixtures";

// The watsonx agent runs in-process with the Dojo and, in keyless runs, talks
// to aimock through its OpenAI-compatible orchestrate endpoint (see
// apps/dojo/e2e/watsonx-fixtures.ts).
const INTEGRATION_ID = "watsonx";
const PAGE = `/${INTEGRATION_ID}/feature/agentic_chat`;

test("[watsonx] Agentic Chat sends and receives a message", async ({
  page,
}) => {
  await gotoAndAwaitRuntimeInfo(page, PAGE);

  const chat = new AgenticChatPage(page);
  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();

  await chat.sendMessage(WATSONX_PROMPTS.greeting);

  await chat.assertUserMessageVisible(WATSONX_PROMPTS.greeting);
  await chat.assertAgentReplyVisible(new RegExp(WATSONX_REPLIES.greeting));
});

test("[watsonx] Agentic Chat forwards the conversation history", async ({
  page,
}) => {
  await gotoAndAwaitRuntimeInfo(page, PAGE);

  const chat = new AgenticChatPage(page);
  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();

  await chat.sendMessage(WATSONX_PROMPTS.greeting);
  await chat.assertAgentReplyVisible(new RegExp(WATSONX_REPLIES.greeting));

  await chat.sendMessage(WATSONX_PROMPTS.recallName);
  await chat.assertUserMessageVisible(WATSONX_PROMPTS.recallName);
  await chat.assertAgentReplyVisible(new RegExp(WATSONX_REPLIES.recallName));
});

test("[watsonx] Agentic Chat calls the frontend change_background tool", async ({
  page,
}) => {
  await gotoAndAwaitRuntimeInfo(page, PAGE);

  const chat = new AgenticChatPage(page);
  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();

  const backgroundContainer = page.locator(
    '[data-testid="background-container"]',
  );
  const getBackground = () =>
    backgroundContainer.evaluate((el) => el.style.background);
  const initialBackground = await getBackground();

  await chat.sendMessage(WATSONX_PROMPTS.backgroundBlue);
  await chat.assertUserMessageVisible(WATSONX_PROMPTS.backgroundBlue);
  await expect.poll(getBackground).not.toBe(initialBackground);
  const backgroundAfterBlue = await getBackground();
  // The closing turn ran on the tool result the adapter sent back to watsonx.
  await chat.assertAgentReplyVisible(
    new RegExp(WATSONX_REPLIES.backgroundChanged),
  );

  await chat.sendMessage(WATSONX_PROMPTS.backgroundPink);
  await chat.assertUserMessageVisible(WATSONX_PROMPTS.backgroundPink);
  await expect.poll(getBackground).not.toBe(backgroundAfterBlue);
  expect(await getBackground()).not.toBe(initialBackground);

  // Repeating a color must be a new tool call, not arguments appended to the
  // first blue call.
  await chat.sendMessage(WATSONX_PROMPTS.backgroundBlue);
  await expect.poll(getBackground).toBe(backgroundAfterBlue);
});
