package com.agui.example.chatapp.ui.screens.chat

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import cafe.adriel.voyager.core.model.rememberScreenModel
import cafe.adriel.voyager.core.screen.Screen
import cafe.adriel.voyager.navigator.LocalNavigator
import cafe.adriel.voyager.navigator.currentOrThrow
import com.agui.example.chatapp.ui.screens.chat.components.ChatHeader
import com.agui.example.chatapp.ui.screens.chat.components.ChatInput
import com.agui.example.chatapp.ui.screens.chat.components.MessageList
import com.agui.example.chatapp.ui.screens.chat.components.UserConfirmationDialog
import com.agui.example.chatapp.ui.screens.settings.SettingsScreen
import org.jetbrains.compose.resources.stringResource
import agui4kclient.shared.generated.resources.*

class ChatScreen : Screen {
    @Composable
    override fun Content() {
        val navigator = LocalNavigator.currentOrThrow
        val viewModel = rememberScreenModel { ChatViewModel() }
        val state by viewModel.state.collectAsState()

        Scaffold(
            topBar = {
                ChatHeader(
                    agentName = state.activeAgent?.name ?: stringResource(Res.string.no_agent_selected),
                    isConnected = state.isConnected,
                    onSettingsClick = {
                        navigator.push(SettingsScreen())
                    }
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
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(paddingValues)
            ) {
                when {
                    state.activeAgent == null -> {
                        NoAgentSelected(
                            onGoToSettings = {
                                navigator.push(SettingsScreen())
                            }
                        )
                    }
                    else -> {
                        MessageList(
                            messages = state.messages,
                            isLoading = state.isLoading
                        )
                    }
                }
            }
        }

        // Show confirmation dialog if there's a pending confirmation
        state.pendingConfirmation?.let { confirmation ->
            UserConfirmationDialog(
                request = confirmation,
                onConfirm = { viewModel.confirmAction() },
                onReject = { viewModel.rejectAction() }
            )
        }
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

        Button(
            onClick = onGoToSettings
        ) {
            Text(stringResource(Res.string.go_to_settings))
        }
    }
}