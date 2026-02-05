package com.agui.example.chatapp.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Response from clawg-ui endpoint when pairing is required (HTTP 403).
 *
 * Expected JSON structure:
 * {
 *   "pairing_code": "ABCD1234",
 *   "bearer_token": "temp_token_xxx",
 *   "instructions": "Share the pairing code with the gateway owner...",
 *   "approval_command": "openclaw pairing approve clawg-ui ABCD1234"
 * }
 */
@Serializable
data class ClawgUiPairingResponse(
    @SerialName("pairing_code")
    val pairingCode: String,
    @SerialName("bearer_token")
    val bearerToken: String,
    val instructions: String? = null,
    @SerialName("approval_command")
    val approvalCommand: String? = null
)

/**
 * State for the clawg-ui pairing flow.
 */
sealed class ClawgUiPairingState {
    /** No pairing in progress */
    data object Idle : ClawgUiPairingState()

    /** Initiating pairing request */
    data object Initiating : ClawgUiPairingState()

    /** Pairing initiated, waiting for user to acknowledge and gateway owner to approve */
    data class PendingApproval(
        val pairingCode: String,
        val bearerToken: String,
        val instructions: String,
        val approvalCommand: String
    ) : ClawgUiPairingState()

    /** Token saved, retrying connection */
    data object RetryingConnection : ClawgUiPairingState()

    /** Awaiting gateway owner approval (connection still returns 403) */
    data class AwaitingApproval(
        val message: String = "Pairing code accepted. Waiting for gateway owner to approve..."
    ) : ClawgUiPairingState()

    /** Pairing failed with error */
    data class Failed(val error: String) : ClawgUiPairingState()
}
