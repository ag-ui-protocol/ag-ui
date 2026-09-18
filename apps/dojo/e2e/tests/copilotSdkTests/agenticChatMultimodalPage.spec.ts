import { test, expect } from "./test";
import * as path from "path";
import { sendChatMessage, awaitLLMResponseDone, openChat } from "../../utils/copilot-actions";
import { CopilotSelectors } from "../../utils/copilot-selectors";

const integrationId = process.env.PLAYWRIGHT_SUITE ?? "copilot-sdk-typescript";
const TEST_IMAGE = path.join(import.meta.dirname, "../../fixtures/test-image.png");

// Image parts on the user message reach the model as SDK blob attachments.
test("[GitHub Copilot SDK] Agentic Chat Multimodal describes an uploaded image", async ({
  page,
}) => {
  await page.goto(`/${integrationId}/feature/agentic_chat_multimodal`);
  await openChat(page);

  await page.locator('input[type="file"]').setInputFiles(TEST_IMAGE);
  await sendChatMessage(page, "Tell me what do you see in this image");
  await awaitLLMResponseDone(page);

  await expect(CopilotSelectors.assistantMessages(page).last()).toContainText(
    /image|visual|content/i,
    { timeout: 10_000 },
  );
});
