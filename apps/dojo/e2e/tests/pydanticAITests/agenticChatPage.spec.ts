import {
  test,
  expect,
  retryOnAIFailure,
} from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test("[PydanticAI] Agentic Chat sends and receives a message", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto(
      "/pydantic-ai/feature/agentic_chat"
    );

    const chat = new AgenticChatPage(page);

    await chat.openChat();
    await expect(chat.agentGreeting).toBeVisible();
    await chat.sendMessage("Hi, I am duaa");

    await chat.assertUserMessageVisible("Hi, I am duaa");
    await chat.assertAgentReplyVisible(/Hello/i);
  });
});

test("[PydanticAI] Agentic Chat changes background on message and reset", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto(
      "/pydantic-ai/feature/agentic_chat"
    );

    const chat = new AgenticChatPage(page);

    await chat.openChat();
    await expect(chat.agentGreeting).toBeVisible();

    const backgroundContainer = page.locator('[data-testid="background-container"]');
    const getBackground = () => backgroundContainer.evaluate(el => el.style.background);
    const initialBackground = await getBackground();

    // 1. Send message to change background to blue
    await chat.sendMessage("Hi change the background color to blue");
    await chat.assertUserMessageVisible(
      "Hi change the background color to blue"
    );

    await expect.poll(getBackground).not.toBe(initialBackground);
    const backgroundAfterBlue = await getBackground();

    // 2. Change to pink
    await chat.sendMessage("Hi change the background color to pink");
    await chat.assertUserMessageVisible(
      "Hi change the background color to pink"
    );

    await expect.poll(getBackground).not.toBe(backgroundAfterBlue);
  });
});

test("[PydanticAI] Agentic Chat retains memory of user messages during a conversation", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto(
      "/pydantic-ai/feature/agentic_chat"
    );

    const chat = new AgenticChatPage(page);
    await chat.openChat();
    await chat.agentGreeting.click();

    await chat.sendMessage("Hey there");
    await chat.assertUserMessageVisible("Hey there");
    await chat.assertAgentReplyVisible(/how can I assist you/i);

    const favFruit = "Mango";
    await chat.sendMessage(`My favorite fruit is ${favFruit}`);
    await chat.assertUserMessageVisible(`My favorite fruit is ${favFruit}`);
    await chat.assertAgentReplyVisible(new RegExp(favFruit, "i"));

    await chat.sendMessage("and I love listening to Kaavish");
    await chat.assertUserMessageVisible("and I love listening to Kaavish");
    await chat.assertAgentReplyVisible(/Kaavish/i);

    await chat.sendMessage("tell me an interesting fact about Moon");
    await chat.assertUserMessageVisible(
      "tell me an interesting fact about Moon"
    );
    await chat.assertAgentReplyVisible(/Moon/i);

    await chat.sendMessage("Can you remind me what my favorite fruit is?");
    await chat.assertUserMessageVisible(
      "Can you remind me what my favorite fruit is?"
    );
    await chat.assertAgentReplyVisible(new RegExp(favFruit, "i"));
  });
});
