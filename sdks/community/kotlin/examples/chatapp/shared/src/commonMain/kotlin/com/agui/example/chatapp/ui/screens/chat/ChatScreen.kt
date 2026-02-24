package com.agui.example.chatapp.ui.screens.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.agui.example.chatapp.data.model.ClawgUiPairingState
import com.agui.example.chatapp.ui.screens.chat.components.ChatHeader
import com.agui.example.chatapp.ui.screens.chat.components.ChatInput
import com.agui.example.chatapp.ui.screens.chat.components.ClawgUiPairingDialog
import com.agui.example.chatapp.ui.screens.chat.components.MessageList
import com.agui.example.chatapp.ui.theme.AgentChatTheme
import org.jetbrains.compose.resources.stringResource
import agui4kclient.shared.generated.resources.Res
import agui4kclient.shared.generated.resources.go_to_settings
import agui4kclient.shared.generated.resources.no_agent_selected
import agui4kclient.shared.generated.resources.no_agent_selected_description

@Composable
fun ChatScreen(
    onOpenSettings: () -> Unit
) {
    val viewModel = rememberChatViewModel()
    val state by viewModel.state.collectAsState()

    Scaffold(
        topBar = {
            ChatHeader(
                agentName = state.activeAgent?.name ?: stringResource(Res.string.no_agent_selected),
                isConnected = state.isConnected,
                onSettingsClick = onOpenSettings
            )
        },
        bottomBar = {
            ChatInput(
                enabled = state.activeAgent != null && !state.isLoading,
                onSendMessage = { message ->
                    viewModel.sendMessage(message)
                }
            )
        }
    ) { paddingValues ->
        val defaultBackground = MaterialTheme.colorScheme.background
        val backgroundColor = remember(state.background, defaultBackground) {
            state.background.toComposeColor(defaultBackground)
        }

        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .background(backgroundColor)
        ) {
            when {
                state.activeAgent == null -> {
                    NoAgentSelected(onOpenSettings)
                }
                else -> {
                    MessageList(
                        messages = state.messages,
                        isLoading = state.isLoading,
                        a2uiSurfaces = state.a2uiSurfaces,
                        a2uiDataModels = state.a2uiDataModels,
                        onA2UiEvent = { event ->
                            viewModel.sendA2UiAction(event)
                        }
                    )
                }
            }
        }
    }

    // clawg-ui pairing dialog
    if (state.clawgUiPairingState !is ClawgUiPairingState.Idle) {
        ClawgUiPairingDialog(
            state = state.clawgUiPairingState,
            onComplete = { viewModel.completePairing() },
            onRetry = { viewModel.retryAfterApproval() },
            onDismiss = { viewModel.dismissPairing() }
        )
    }
}

@Composable
private fun NoAgentSelected(
    onGoToSettings: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(
            text = stringResource(Res.string.no_agent_selected),
            style = MaterialTheme.typography.headlineMedium,
            color = MaterialTheme.colorScheme.onSurface
        )

        Spacer(modifier = Modifier.height(16.dp))

        Text(
            text = stringResource(Res.string.no_agent_selected_description),
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center
        )

        Spacer(modifier = Modifier.height(32.dp))

        Button(onClick = onGoToSettings) {
            Text(stringResource(Res.string.go_to_settings))
        }
    }
}

private fun com.agui.example.tools.BackgroundStyle.toComposeColor(default: Color): Color {
    val hex = colorHex?.removePrefix("#") ?: return default
    return when (hex.length) {
        6 -> hex.toLongOrNull(16)?.let { Color((0xFF000000 or it).toInt()) } ?: default
        8 -> {
            val rgbPart = hex.substring(0, 6)
            val alphaPart = hex.substring(6, 8)
            val argb = (alphaPart + rgbPart).toLongOrNull(16) ?: return default
            Color(argb.toInt())
        }
        else -> default
    }
}
