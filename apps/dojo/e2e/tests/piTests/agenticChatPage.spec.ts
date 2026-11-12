import { expect, test } from "../../test-isolation-helper";
import { gotoAndAwaitRuntimeInfo } from "../../utils/copilot-actions";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test("[Pi] Agentic Chat streams an answer for each new prompt", async ({ page }) => {
  await gotoAndAwaitRuntimeInfo(page, "/pi/feature/agentic_chat");
  const chat = new AgenticChatPage(page);
  await chat.openChat();

  await chat.sendMessage("What is the capital of France?");
  await chat.assertAgentReplyContains("Paris");

  await chat.sendMessage("I am duaa");
  await chat.assertAgentReplyContains("Hello duaa");
});

test("[Pi] Agentic Chat runs a client tool and continues the conversation", async ({ page }) => {
  await gotoAndAwaitRuntimeInfo(page, "/pi/feature/agentic_chat");
  const chat = new AgenticChatPage(page);
  await chat.openChat();

  const background = page.getByTestId("background-container");
  await chat.sendMessage("Change the background color to blue");
  await expect(background).toHaveCSS("background-color", "rgb(0, 0, 255)");

  await chat.sendMessage("What is the capital of France?");
  await chat.assertAgentReplyContains("Paris");
});
