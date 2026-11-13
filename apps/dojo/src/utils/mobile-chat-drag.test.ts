import assert from "node:assert/strict";
import test from "node:test";

import { resolveMobileChatDragHeight } from "./mobile-chat-drag";

test("dragging below the close threshold closes the chat but keeps the panel at the minimum height", () => {
  // Regression test for ag-ui-protocol/ag-ui#2471: the drag handler clamped
  // the stored height to >= 50% and then only closed when it was < 50%,
  // so dragging down could never close the mobile chat.
  assert.deepEqual(resolveMobileChatDragHeight(42), {
    displayHeight: 50,
    shouldClose: true,
  });
  assert.deepEqual(resolveMobileChatDragHeight(30), {
    displayHeight: 50,
    shouldClose: true,
  });
});

test("dragging just below the threshold closes, exactly at the threshold does not", () => {
  assert.deepEqual(resolveMobileChatDragHeight(49.9), {
    displayHeight: 50,
    shouldClose: true,
  });
  assert.deepEqual(resolveMobileChatDragHeight(50), {
    displayHeight: 50,
    shouldClose: false,
  });
});

test("dragging within range neither closes nor clamps", () => {
  assert.deepEqual(resolveMobileChatDragHeight(75), {
    displayHeight: 75,
    shouldClose: false,
  });
});

test("dragging above the maximum clamps the displayed height and does not close", () => {
  assert.deepEqual(resolveMobileChatDragHeight(120), {
    displayHeight: 100,
    shouldClose: false,
  });
});
