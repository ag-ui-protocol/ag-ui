import { test, expect } from "../../test-isolation-helper";
import * as path from "path";
import {
  sendChatMessage,
  awaitLLMResponseDone,
  gotoAndAwaitRuntimeInfo,
  openChat,
} from "../../utils/copilot-actions";
import { CopilotSelectors } from "../../utils/copilot-selectors";
import { CLOUDFLARE_IMAGE_SEEN } from "../../cloudflare-agents-fixtures";

const TEST_IMAGE = path.join(
  import.meta.dirname,
  "../../fixtures/test-image.png",
);

test.describe("[Cloudflare Agents] Agentic Chat Multimodal", () => {
  test("[Cloudflare Agents] should upload an image and receive a description", async ({
    page,
  }) => {
    await gotoAndAwaitRuntimeInfo(
      page,
      "/cloudflare-agents/feature/agentic_chat_multimodal",
    );
    await openChat(page);

    // Upload a test image — v2 CopilotChat attaches files silently
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(TEST_IMAGE);

    await sendChatMessage(page, "Tell me what do you see in this image");
    await awaitLLMResponseDone(page);

    // Only the fixture that finds an image part in the model request answers
    // with this text, so it proves the image reached the model.
    const lastAssistant = CopilotSelectors.assistantMessages(page).last();
    await expect(lastAssistant).toContainText(CLOUDFLARE_IMAGE_SEEN, {
      timeout: 10000,
    });
  });
});
