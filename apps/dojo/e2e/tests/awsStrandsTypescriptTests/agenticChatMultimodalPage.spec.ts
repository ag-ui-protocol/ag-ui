import { test, expect } from "../../test-isolation-helper";
import * as path from "path";
import {
  sendChatMessage,
  awaitLLMResponseDone,
  openChat,
} from "../../utils/copilot-actions";
import { CopilotSelectors } from "../../utils/copilot-selectors";

const TEST_IMAGE = path.join(
  import.meta.dirname,
  "../../fixtures/test-image.png",
);

test.describe("[Integration] AWS Strands (TS) - Agentic Chat Multimodal", () => {
  test("should upload an image and receive a description", async ({ page }) => {
    await page.goto("/aws-strands-typescript/feature/agentic_chat_multimodal");
    await openChat(page);

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(TEST_IMAGE);

    await sendChatMessage(page, "Tell me what do you see in this image");
    await awaitLLMResponseDone(page);

    const lastAssistant = CopilotSelectors.assistantMessages(page).last();
    await expect(lastAssistant).toContainText(/image|visual|content/i, {
      timeout: 10000,
    });
  });
});
