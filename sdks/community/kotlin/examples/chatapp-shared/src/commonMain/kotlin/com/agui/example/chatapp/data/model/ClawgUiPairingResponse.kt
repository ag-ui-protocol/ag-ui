package com.agui.example.chatapp.data.model

import kotlinx.serialization.Serializable

/**
 * Response from clawg-ui endpoint when pairing is required (HTTP 403).
 *
 * Expected JSON structure:
 * {
 *   "error": {
 *     "type": "pairing_pending",
 *     "message": "Device pending approval",
 *     "pairing": {
 *       "pairingCode": "ABCD1234",
 *       "token": "MmRlOTA0ODIt...b71d",
 *       "instructions": "Save this token for use as a Bearer token..."
 *     }
 *   }
 * }
 */
@Serializable
data class ClawgUiPairingResponse(
    val error: ClawgUiError
)

@Serializable
data class ClawgUiError(
    val type: String,
    val message: String? = null,
    val pairing: ClawgUiPairingInfo? = null
)

@Serializable
data class ClawgUiPairingInfo(
    val pairingCode: String,
    val token: String,
    val instructions: String? = null
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
