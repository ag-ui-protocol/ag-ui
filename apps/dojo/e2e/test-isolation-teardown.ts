import { teardownLLMock } from "./llmock-setup";

async function globalTeardown() {
  await teardownLLMock();
}

export default globalTeardown;
