package com.agui.example.chatapp.ui.screens.chat.components

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.agui.example.chatapp.ui.screens.chat.UserConfirmationRequest

@Composable
fun UserConfirmationDialog(
    request: UserConfirmationRequest,
    onConfirm: () -> Unit,
    onReject: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onReject,
        icon = {
            val iconColor = when (request.impact) {
                "critical" -> MaterialTheme.colorScheme.error
                "high" -> MaterialTheme.colorScheme.error.copy(alpha = 0.7f)
                "medium" -> MaterialTheme.colorScheme.tertiary
                else -> MaterialTheme.colorScheme.primary
            }
            Icon(
                Icons.Default.Warning,
                contentDescription = null,
                tint = iconColor,
                modifier = Modifier.size(48.dp)
            )
        },
        title = {
            Text(
                text = "Confirmation Required",
                style = MaterialTheme.typography.headlineSmall
            )
        },
        text = {
            Column(
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                Text(
                    text = request.action,
                    style = MaterialTheme.typography.bodyLarge
                )

                if (request.details.isNotEmpty()) {
                    Card(
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.surfaceVariant
                        )
                    ) {
                        Column(
                            modifier = Modifier.padding(12.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            request.details.forEach { (key, value) ->
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween
                                ) {
                                    Text(
                                        text = "$key:",
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                    Text(
                                        text = value,
                                        style = MaterialTheme.typography.bodyMedium
                                    )
                                }
                            }
                        }
                    }
                }

                // Impact indicator
                val impactColor = when (request.impact) {
                    "critical" -> MaterialTheme.colorScheme.error
                    "high" -> MaterialTheme.colorScheme.error.copy(alpha = 0.7f)
                    "medium" -> MaterialTheme.colorScheme.tertiary
                    else -> MaterialTheme.colorScheme.primary
                }

                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Text(
                        text = "Impact:",
                        style = MaterialTheme.typography.labelLarge
                    )
                    AssistChip(
                        onClick = { },
                        label = {
                            Text(
                                text = request.impact.uppercase(),
                                style = MaterialTheme.typography.labelSmall
                            )
                        },
                        colors = AssistChipDefaults.assistChipColors(
                            containerColor = impactColor.copy(alpha = 0.2f),
                            labelColor = impactColor
                        )
                    )
                }
            }
        },
        confirmButton = {
            Button(
                onClick = onConfirm,
                colors = if (request.impact == "critical" || request.impact == "high") {
                    ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.error
                    )
                } else {
                    ButtonDefaults.buttonColors()
                }
            ) {
                Text("Confirm")
            }
        },
        dismissButton = {
            TextButton(onClick = onReject) {
                Text("Cancel")
            }
        }
    )
}