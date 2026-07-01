import { Page } from "@playwright/test";

/**
 * Centralized CopilotKit element selectors using data-testid attributes.
 * Import these instead of defining fragile CSS/role selectors in page objects.
 */
export const CopilotSelectors = {
  /** Main chat container — also carries data-copilot-running attribute */
  chat: (page: Page) => page.getByTestId("copilot-chat"),
  /** Chat text input (textarea) */
  chatTextarea: (page: Page) => page.getByTestId("copilot-chat-textarea"),
  /** Send / Stop button */
  sendButton: (page: Page) => page.getByTestId("copilot-send-button"),
  /** All assistant messages */
  assistantMessages: (page: Page) =>
    page.getByTestId("copilot-assistant-message"),
  /** All user messages */
  userMessages: (page: Page) => page.getByTestId("copilot-user-message"),
  /** Message list container */
  messageList: (page: Page) => page.getByTestId("copilot-message-list"),
  /** Loading cursor (AI thinking indicator) */
  loadingCursor: (page: Page) => page.getByTestId("copilot-loading-cursor"),
  /** Regenerate button on assistant messages */
  regenerateButton: (page: Page) =>
    page.getByTestId("copilot-regenerate-button"),
  /** Chat toggle (open/close) button */
  chatToggle: (page: Page) => page.getByTestId("copilot-chat-toggle"),
  /** Sidebar container */
  sidebar: (page: Page) => page.getByTestId("copilot-sidebar"),
  /** Popup dialog */
  popup: (page: Page) => page.getByTestId("copilot-popup"),
  /** Suggestion pills container */
  suggestions: (page: Page) => page.getByTestId("copilot-suggestions"),
  /** Individual suggestion pills */
  suggestion: (page: Page) => page.getByTestId("copilot-suggestion"),
  /** Modal header */
  modalHeader: (page: Page) => page.getByTestId("copilot-modal-header"),
  /** Modal close button */
  closeButton: (page: Page) => page.getByTestId("copilot-close-button"),
  /** Welcome screen */
  welcomeScreen: (page: Page) => page.getByTestId("copilot-welcome-screen"),
  /** Scroll to bottom button */
  scrollToBottom: (page: Page) =>
    page.getByTestId("copilot-scroll-to-bottom"),
  /** Input pill container */
  chatInput: (page: Page) => page.getByTestId("copilot-chat-input"),
  /** Slash commands menu */
  slashMenu: (page: Page) => page.getByTestId("copilot-slash-menu"),
} as const;
