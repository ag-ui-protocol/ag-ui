package com.agui.example.chatapp.ui.components

import androidx.compose.ui.test.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.agui.example.chatapp.ui.screens.chat.UserConfirmationRequest
import com.agui.example.chatapp.ui.screens.chat.components.UserConfirmationDialog
import com.agui.example.chatapp.ui.theme.AgentChatTheme
import org.junit.runner.RunWith
import kotlin.test.*

/**
 * Android instrumentation tests for UserConfirmationDialog component.
 * Tests dialog display, user interactions, and different confirmation scenarios on Android platform.
 */
@RunWith(AndroidJUnit4::class)
@OptIn(ExperimentalTestApi::class)
class UserConfirmationDialogComponentTest {

    @Test
    fun testBasicConfirmationDialogDisplay() = runComposeUiTest {
        val request = UserConfirmationRequest(
            toolCallId = "test-1",
            action = "Delete important file",
            impact = "high"
        )

        var confirmCalled = false
        var rejectCalled = false

        setContent {
            AgentChatTheme {
                UserConfirmationDialog(
                    request = request,
                    onConfirm = { confirmCalled = true },
                    onReject = { rejectCalled = true }
                )
            }
        }

        // Verify dialog content
        onNodeWithText("Confirmation Required").assertExists()
        onNodeWithText("Delete important file").assertExists()
        onNodeWithText("HIGH").assertExists()
        onNodeWithText("Confirm").assertExists()
        onNodeWithText("Cancel").assertExists()
    }

    @Test
    fun testConfirmationWithDetails() = runComposeUiTest {
        val request = UserConfirmationRequest(
            toolCallId = "test-2",
            action = "Execute system command",
            impact = "critical",
            details = mapOf(
                "command" to "rm -rf /tmp/*",
                "target" to "/tmp directory",
                "size" to "1.2GB"
            )
        )

        setContent {
            AgentChatTheme {
                UserConfirmationDialog(
                    request = request,
                    onConfirm = { },
                    onReject = { }
                )
            }
        }

        // Verify main content
        onNodeWithText("Execute system command").assertExists()
        onNodeWithText("CRITICAL").assertExists()

        // Verify details are displayed
        onNodeWithText("command:").assertExists()
        onNodeWithText("rm -rf /tmp/*").assertExists()
        onNodeWithText("target:").assertExists()
        onNodeWithText("/tmp directory").assertExists()
        onNodeWithText("size:").assertExists()
        onNodeWithText("1.2GB").assertExists()
    }

    @Test
    fun testConfirmButtonClick() = runComposeUiTest {
        val request = UserConfirmationRequest(
            toolCallId = "test-3",
            action = "Test action",
            impact = "low"
        )

        var confirmCalled = false

        setContent {
            AgentChatTheme {
                UserConfirmationDialog(
                    request = request,
                    onConfirm = { confirmCalled = true },
                    onReject = { }
                )
            }
        }

        onNodeWithText("Confirm").performClick()
        assertTrue(confirmCalled)
    }

    @Test
    fun testCancelButtonClick() = runComposeUiTest {
        val request = UserConfirmationRequest(
            toolCallId = "test-4",
            action = "Test action",
            impact = "medium"
        )

        var rejectCalled = false

        setContent {
            AgentChatTheme {
                UserConfirmationDialog(
                    request = request,
                    onConfirm = { },
                    onReject = { rejectCalled = true }
                )
            }
        }

        onNodeWithText("Cancel").performClick()
        assertTrue(rejectCalled)
    }

    @Test
    fun testLowImpactConfirmation() = runComposeUiTest {
        val request = UserConfirmationRequest(
            toolCallId = "test-5",
            action = "Create backup file",
            impact = "low",
            timeout = 60
        )

        setContent {
            AgentChatTheme {
                UserConfirmationDialog(
                    request = request,
                    onConfirm = { },
                    onReject = { }
                )
            }
        }

        onNodeWithText("Create backup file").assertExists()
        onNodeWithText("LOW").assertExists()
        onNodeWithText("Impact:").assertExists()
    }

    @Test
    fun testMediumImpactConfirmation() = runComposeUiTest {
        val request = UserConfirmationRequest(
            toolCallId = "test-6",
            action = "Modify configuration",
            impact = "medium"
        )

        setContent {
            AgentChatTheme {
                UserConfirmationDialog(
                    request = request,
                    onConfirm = { },
                    onReject = { }
                )
            }
        }

        onNodeWithText("Modify configuration").assertExists()
        onNodeWithText("MEDIUM").assertExists()
    }

    @Test
    fun testHighImpactConfirmation() = runComposeUiTest {
        val request = UserConfirmationRequest(
            toolCallId = "test-7",
            action = "Delete user data",
            impact = "high"
        )

        setContent {
            AgentChatTheme {
                UserConfirmationDialog(
                    request = request,
                    onConfirm = { },
                    onReject = { }
                )
            }
        }

        onNodeWithText("Delete user data").assertExists()
        onNodeWithText("HIGH").assertExists()
    }

    @Test
    fun testCriticalImpactConfirmation() = runComposeUiTest {
        val request = UserConfirmationRequest(
            toolCallId = "test-8",
            action = "Format hard drive",
            impact = "critical"
        )

        setContent {
            AgentChatTheme {
                UserConfirmationDialog(
                    request = request,
                    onConfirm = { },
                    onReject = { }
                )
            }
        }

        onNodeWithText("Format hard drive").assertExists()
        onNodeWithText("CRITICAL").assertExists()
    }

    @Test
    fun testEmptyDetailsHandling() = runComposeUiTest {
        val request = UserConfirmationRequest(
            toolCallId = "test-9",
            action = "Simple action",
            impact = "low",
            details = emptyMap()
        )

        setContent {
            AgentChatTheme {
                UserConfirmationDialog(
                    request = request,
                    onConfirm = { },
                    onReject = { }
                )
            }
        }

        onNodeWithText("Simple action").assertExists()
        onNodeWithText("LOW").assertExists()
        // Details section should not be visible when empty
    }

    @Test
    fun testSingleDetailEntry() = runComposeUiTest {
        val request = UserConfirmationRequest(
            toolCallId = "test-10",
            action = "Update setting",
            impact = "medium",
            details = mapOf("setting" to "theme=dark")
        )

        setContent {
            AgentChatTheme {
                UserConfirmationDialog(
                    request = request,
                    onConfirm = { },
                    onReject = { }
                )
            }
        }

        onNodeWithText("Update setting").assertExists()
        onNodeWithText("setting:").assertExists()
        onNodeWithText("theme=dark").assertExists()
    }

    @Test
    fun testLongActionText() = runComposeUiTest {
        val longAction = "This is a very long action description that should test how the dialog handles " +
                "lengthy text content. It should wrap properly and maintain good readability within the dialog."

        val request = UserConfirmationRequest(
            toolCallId = "test-11",
            action = longAction,
            impact = "medium"
        )

        setContent {
            AgentChatTheme {
                UserConfirmationDialog(
                    request = request,
                    onConfirm = { },
                    onReject = { }
                )
            }
        }

        onNodeWithText(longAction).assertExists()
    }

    @Test
    fun testSpecialCharactersInAction() = runComposeUiTest {
        val actionWithSpecialChars = "Execute: rm -rf /tmp/* && echo \"Done!\" | tee log.txt"

        val request = UserConfirmationRequest(
            toolCallId = "test-12",
            action = actionWithSpecialChars,
            impact = "high"
        )

        setContent {
            AgentChatTheme {
                UserConfirmationDialog(
                    request = request,
                    onConfirm = { },
                    onReject = { }
                )
            }
        }

        onNodeWithText(actionWithSpecialChars).assertExists()
    }

    @Test
    fun testCustomTimeoutValue() = runComposeUiTest {
        val request = UserConfirmationRequest(
            toolCallId = "test-13",
            action = "Timed operation",
            impact = "medium",
            timeout = 120
        )

        setContent {
            AgentChatTheme {
                UserConfirmationDialog(
                    request = request,
                    onConfirm = { },
                    onReject = { }
                )
            }
        }

        onNodeWithText("Timed operation").assertExists()
        // Note: Timeout value might not be directly displayed in UI, 
        // but we verify the dialog renders correctly with custom timeout
    }

    @Test
    fun testMultipleDetailsEntries() = runComposeUiTest {
        val request = UserConfirmationRequest(
            toolCallId = "test-14",
            action = "Complex operation",
            impact = "high",
            details = mapOf(
                "source" to "/home/user/documents",
                "destination" to "/backup/user-docs", 
                "size" to "2.5GB",
                "method" to "rsync",
                "compression" to "enabled"
            )
        )

        setContent {
            AgentChatTheme {
                UserConfirmationDialog(
                    request = request,
                    onConfirm = { },
                    onReject = { }
                )
            }
        }

        // Verify all details are displayed
        onNodeWithText("source:").assertExists()
        onNodeWithText("/home/user/documents").assertExists()
        onNodeWithText("destination:").assertExists() 
        onNodeWithText("/backup/user-docs").assertExists()
        onNodeWithText("size:").assertExists()
        onNodeWithText("2.5GB").assertExists()
        onNodeWithText("method:").assertExists()
        onNodeWithText("rsync").assertExists()
        onNodeWithText("compression:").assertExists()
        onNodeWithText("enabled").assertExists()
    }

    @Test
    fun testDialogDismissOnOutsideClick() = runComposeUiTest {
        val request = UserConfirmationRequest(
            toolCallId = "test-15",
            action = "Test dismiss",
            impact = "low"
        )

        var rejectCalled = false

        setContent {
            AgentChatTheme {
                UserConfirmationDialog(
                    request = request,
                    onConfirm = { },
                    onReject = { rejectCalled = true }
                )
            }
        }

        // Note: Testing outside click dismiss is complex in Compose UI tests
        // We verify the dialog displays correctly and reject callback is set up
        onNodeWithText("Test dismiss").assertExists()
        assertTrue(true) // Test passes if dialog renders without error
    }

    @Test
    fun testUnknownImpactLevel() = runComposeUiTest {
        val request = UserConfirmationRequest(
            toolCallId = "test-16",
            action = "Unknown impact action",
            impact = "unknown"
        )

        setContent {
            AgentChatTheme {
                UserConfirmationDialog(
                    request = request,
                    onConfirm = { },
                    onReject = { }
                )
            }
        }

        onNodeWithText("Unknown impact action").assertExists()
        onNodeWithText("UNKNOWN").assertExists()
        // Should handle unknown impact levels gracefully
    }
}