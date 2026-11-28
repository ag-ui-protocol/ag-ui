// Pure drag math for the mobile chat panel (see use-mobile-chat.ts).
// Kept free of React so it can be covered by the dojo `tsx --test` suite.

export const MOBILE_CHAT_MIN_HEIGHT = 50;
export const MOBILE_CHAT_MAX_HEIGHT = 100;

/**
 * Maps a raw drag position (chat height in percent of the viewport) to the
 * height actually rendered and whether the drag should close the chat.
 *
 * The rendered panel stays clamped to [50, 100], but the close decision is
 * made on the raw drag position: clamping first and then testing the
 * clamped value for `< 50` can never close (ag-ui-protocol/ag-ui#2471).
 */
export function resolveMobileChatDragHeight(newHeightPercent: number): {
  displayHeight: number;
  shouldClose: boolean;
} {
  return {
    displayHeight: Math.max(
      MOBILE_CHAT_MIN_HEIGHT,
      Math.min(MOBILE_CHAT_MAX_HEIGHT, newHeightPercent),
    ),
    shouldClose: newHeightPercent < MOBILE_CHAT_MIN_HEIGHT,
  };
}
