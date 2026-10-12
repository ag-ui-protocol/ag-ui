import { test, expect } from "../../test-isolation-helper";
import * as path from "path";
import {
  sendChatMessage,
  awaitLLMResponseDone,
  openChat,
} from "../../utils/copilot-actions";
import { CopilotSelectors } from "../../utils/copilot-selectors";
import { ANTIGRAVITY_IMAGE_SEEN } from "../../antigravity-chat-fixtures";

const TEST_IMAGE = path.join(
  import.meta.dirname,
  "../../fixtures/test-image.png",
);

test.describe("[Integration] Antigravity - Agentic Chat Multimodal", () => {
  test("should upload an image and receive a description", async ({
    page,
  }) => {
    await page.goto("/antigravity/feature/agentic_chat_multimodal");
    await openChat(page);

    // Upload a test image — v2 CopilotChat attaches files silently
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(TEST_IMAGE);

    // Send a message asking about the image
    await sendChatMessage(page, "Tell me what do you see in this image");
    await awaitLLMResponseDone(page);

    // Only the fixture that sees no "[Attached image ... not forwarded]" note
    // in the prompt answers with this text, so it proves the image reached
    // the model as media rather than being dropped.
    const lastAssistant = CopilotSelectors.assistantMessages(page).last();
    await expect(lastAssistant).toContainText(ANTIGRAVITY_IMAGE_SEEN, {
      timeout: 10000,
    });
  });
});
