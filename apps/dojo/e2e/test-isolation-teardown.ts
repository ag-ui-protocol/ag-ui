import { teardownLLMock } from "./aimock-setup";

async function globalTeardown() {
  await teardownLLMock();
}

export default globalTeardown;
