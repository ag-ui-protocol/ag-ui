package com.agui.example.chatapp.data.pairing

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ClawgUiPairingServiceTest {

    @Test
    fun isClawgUiEndpoint_detectsValidClawgUiUrls() {
        // Standard clawg-ui URLs
        assertTrue(ClawgUiPairingService.isClawgUiEndpoint("https://example.com/v1/clawg-ui"))
        assertTrue(ClawgUiPairingService.isClawgUiEndpoint("http://localhost:8080/v1/clawg-ui"))
        assertTrue(ClawgUiPairingService.isClawgUiEndpoint("https://api.example.com/v1/clawg-ui"))

        // With trailing path or query params
        assertTrue(ClawgUiPairingService.isClawgUiEndpoint("https://example.com/v1/clawg-ui/"))
        assertTrue(ClawgUiPairingService.isClawgUiEndpoint("https://example.com/v1/clawg-ui?foo=bar"))
        assertTrue(ClawgUiPairingService.isClawgUiEndpoint("https://example.com/v1/clawg-ui/agent"))

        // With prefix path
        assertTrue(ClawgUiPairingService.isClawgUiEndpoint("https://example.com/api/v1/clawg-ui"))
    }

    @Test
    fun isClawgUiEndpoint_rejectsNonClawgUiUrls() {
        // Standard AG-UI URLs
        assertFalse(ClawgUiPairingService.isClawgUiEndpoint("https://example.com/api/agent"))
        assertFalse(ClawgUiPairingService.isClawgUiEndpoint("https://example.com/v1/chat"))

        // Similar but not matching patterns
        assertFalse(ClawgUiPairingService.isClawgUiEndpoint("https://example.com/v2/clawg-ui"))
        assertFalse(ClawgUiPairingService.isClawgUiEndpoint("https://example.com/clawg-ui"))
        assertFalse(ClawgUiPairingService.isClawgUiEndpoint("https://example.com/v1/clawgui"))

        // Empty or invalid
        assertFalse(ClawgUiPairingService.isClawgUiEndpoint(""))
        assertFalse(ClawgUiPairingService.isClawgUiEndpoint("not-a-url"))
    }
}
