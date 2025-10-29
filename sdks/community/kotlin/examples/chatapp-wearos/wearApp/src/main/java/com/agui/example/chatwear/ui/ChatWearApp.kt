package com.agui.example.chatwear.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.ProvideTextStyle
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import com.mikepenz.markdown.m3.markdownColor
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.ButtonDefaults
import androidx.wear.compose.material3.MaterialTheme as WearMaterialTheme
import androidx.wear.compose.material3.Text as WearText
import androidx.wear.compose.material.PositionIndicator
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.TimeText
import androidx.wear.compose.material.Vignette
import androidx.wear.compose.material.VignettePosition
import com.agui.example.chatwear.R
import com.agui.example.chatapp.chat.DisplayMessage
import com.agui.example.chatapp.chat.MessageRole
import com.agui.example.chatapp.data.model.AgentConfig
import com.agui.example.chatapp.data.model.AuthMethod
import com.mikepenz.markdown.m3.Markdown
import com.agui.example.chatwear.ui.theme.ChatWearTheme
import androidx.compose.ui.text.input.ImeAction
import com.agui.example.tools.BackgroundStyle

@Composable
fun ChatWearApp(
    modifier: Modifier = Modifier,
    viewModel: WearChatViewModel = viewModel()
) {
    val chatState by viewModel.chatState.collectAsStateWithLifecycle()
    val activeAgent by viewModel.activeAgent.collectAsStateWithLifecycle()
    val agents by viewModel.agents.collectAsStateWithLifecycle()
    var inputValue by rememberSaveable { mutableStateOf("") }
    val quickPrompts = viewModel.quickPrompts
    val listState = rememberScalingLazyListState()
    var showAgentManager by rememberSaveable { mutableStateOf(false) }

    ChatWearTheme {
        if (showAgentManager) {
            AgentManagerScreen(
                agents = agents,
                activeAgent = activeAgent,
                onClose = { showAgentManager = false },
                onCreateAgent = viewModel::createAgent,
                onUpdateAgent = viewModel::updateAgent,
                onDeleteAgent = viewModel::deleteAgent,
                onActivateAgent = viewModel::selectAgent
            )
            return@ChatWearTheme
        }

        val defaultBackground = WearMaterialTheme.colorScheme.background
        val backgroundColor = remember(chatState.background, defaultBackground) {
            chatState.background.toWearColor(defaultBackground)
        }

        Scaffold(
            modifier = modifier
                .fillMaxSize()
                .background(backgroundColor),
            timeText = { TimeText() },
            vignette = {
                if (chatState.messages.isNotEmpty()) {
                    Vignette(vignettePosition = VignettePosition.TopAndBottom)
                }
            },
            positionIndicator = { PositionIndicator(listState) }
        ) {
            ScalingLazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .background(backgroundColor),
                state = listState,
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                item {
                    AgentStatusCard(
                        activeAgent = activeAgent,
                        agents = agents,
                        isConnected = chatState.isConnected,
                        onNextAgent = viewModel::selectAgent,
                        onOpenManager = { showAgentManager = true }
                    )
                }

                chatState.error?.let { error ->
                    item {
                        ErrorCard(
                            message = error,
                            onDismiss = viewModel::clearError,
                            onRetry = {
                                activeAgent?.let(viewModel::selectAgent)
                            }
                        )
                    }
                }

                items(chatState.messages) { message ->
                    MessageBubble(message = message)
                }

                chatState.ephemeralMessage?.let { ephemeral ->
                    item {
                        MessageBubble(message = ephemeral, isEphemeral = true)
                    }
                }

                item {
                    ChatInputCard(
                        value = inputValue,
                        onValueChange = { inputValue = it },
                        enabled = activeAgent != null,
                        onSend = {
                            val trimmed = inputValue.trim()
                            if (trimmed.isNotEmpty()) {
                                viewModel.sendMessage(trimmed)
                                inputValue = ""
                            }
                        }
                    )
                }

                if (quickPrompts.isNotEmpty()) {
                    item {
                        QuickPromptRow(
                            prompts = quickPrompts,
                            onPromptSelected = viewModel::sendMessage
                        )
                    }
                }

                if (chatState.isLoading) {
                    item {
                        LoadingIndicator()
                    }
                }
            }
        }
    }
}

private fun BackgroundStyle.toWearColor(default: Color): Color {
    val hex = colorHex?.removePrefix("#") ?: return default
    return when (hex.length) {
        6 -> hex.toLongOrNull(16)?.let { Color((0xFF000000 or it).toInt()) } ?: default
        8 -> {
            val rgb = hex.substring(0, 6)
            val alpha = hex.substring(6, 8)
            val argb = (alpha + rgb).toLongOrNull(16) ?: return default
            Color(argb.toInt())
        }
        else -> default
    }
}

@Composable
private fun AgentStatusCard(
    activeAgent: AgentConfig?,
    agents: List<AgentConfig>,
    isConnected: Boolean,
    onNextAgent: (AgentConfig) -> Unit,
    onOpenManager: () -> Unit,
    modifier: Modifier = Modifier
) {
    val statusText = when {
        activeAgent == null -> "No agent configured"
        isConnected -> "Connected"
        else -> "Ready"
    }
    val canCycle = activeAgent != null && agents.size > 1
    Surface(
        modifier = modifier.fillMaxWidth(),
        color = WearMaterialTheme.colorScheme.surfaceContainer,
        contentColor = WearMaterialTheme.colorScheme.onSurface, // <-- FIX 1: Force the correct default
        tonalElevation = 6.dp
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 10.dp)
        ) {
            Text(
                text = activeAgent?.name ?: "Agent",
                style = WearMaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
                // This will now default to the readable 'onSurface'
            )
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = statusText,
                style = WearMaterialTheme.typography.bodySmall,
                color = WearMaterialTheme.colorScheme.onSurface.copy(alpha = 0.8f) // <-- FIX 2: Use readable 'onSurface'
            )
            if (activeAgent == null) {
                Spacer(modifier = Modifier.height(6.dp))
                Text(
                    text = "Set chatapp.wear.defaultAgentUrl in gradle.properties to seed an agent.",
                    style = WearMaterialTheme.typography.bodySmall,
                    color = WearMaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 3
                )
            }
            Spacer(modifier = Modifier.height(6.dp))
            Button(
                onClick = onOpenManager,
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.filledTonalButtonColors(
                    containerColor = WearMaterialTheme.colorScheme.secondary,
                    contentColor = WearMaterialTheme.colorScheme.onSecondary
                )
            ) {
                WearText(text = stringResource(id = R.string.manage_agents))
            }
            if (canCycle) {
                Spacer(modifier = Modifier.height(6.dp))
                Button(
                    onClick = {
                        val index = agents.indexOfFirst { it.id == activeAgent.id }
                        val next = agents.getOrNull((index + 1) % agents.size)
                        if (next != null) {
                            onNextAgent(next)
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                    colors = ButtonDefaults.filledTonalButtonColors(
                        containerColor = WearMaterialTheme.colorScheme.tertiary,
                        contentColor = WearMaterialTheme.colorScheme.onTertiary
                    )
                ) {
                    WearText(text = stringResource(id = R.string.switch_agent_button))
                }
            }
        }
    }
}

@Composable
private fun AgentManagerScreen(
    agents: List<AgentConfig>,
    activeAgent: AgentConfig?,
    onClose: () -> Unit,
    onCreateAgent: (name: String, url: String, description: String, apiKey: String, apiKeyHeader: String) -> Unit,
    onUpdateAgent: (agent: AgentConfig, name: String, url: String, description: String, apiKey: String, apiKeyHeader: String) -> Unit,
    onDeleteAgent: (AgentConfig) -> Unit,
    onActivateAgent: (AgentConfig) -> Unit,
    modifier: Modifier = Modifier
) {
    val listState = rememberScalingLazyListState()
    var showForm by rememberSaveable { mutableStateOf(false) }
    var editingAgent by remember { mutableStateOf<AgentConfig?>(null) }

    Scaffold(
        modifier = modifier.fillMaxSize(),
        timeText = { TimeText() },
        positionIndicator = { PositionIndicator(listState) },
        vignette = {
            if (agents.isNotEmpty()) {
                Vignette(vignettePosition = VignettePosition.TopAndBottom)
            }
        }
    ) {
        ScalingLazyColumn(
            modifier = Modifier.fillMaxSize(),
            state = listState,
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            item {
                Surface(
                    modifier = Modifier.fillMaxWidth(),
                    color = WearMaterialTheme.colorScheme.surfaceContainerHigh,
                    tonalElevation = 6.dp
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(12.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        Text(
                            text = stringResource(id = R.string.agent_manager_title),
                            style = WearMaterialTheme.typography.titleMedium
                        )
                        Text(
                            text = stringResource(id = R.string.agent_manager_description),
                            style = WearMaterialTheme.typography.bodySmall,
                            color = WearMaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Button(
                            onClick = onClose,
                            modifier = Modifier.fillMaxWidth(),
                            colors = ButtonDefaults.filledTonalButtonColors()
                        ) {
                            WearText(text = stringResource(id = R.string.back_to_chat))
                        }
                    }
                }
            }

            if (showForm) {
                item {
                    AgentEditorCard(
                        agent = editingAgent,
                        onSubmit = { name, url, description, apiKey, apiKeyHeader ->
                            val target = editingAgent
                            if (target == null) {
                                onCreateAgent(name, url, description, apiKey, apiKeyHeader)
                            } else {
                                onUpdateAgent(target, name, url, description, apiKey, apiKeyHeader)
                            }
                            showForm = false
                            editingAgent = null
                        },
                        onCancel = {
                            showForm = false
                            editingAgent = null
                        }
                    )
                }
            } else {
                item {
                    Button(
                        onClick = {
                            editingAgent = null
                            showForm = true
                        },
                        modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.filledTonalButtonColors()
                    ) {
                        WearText(text = stringResource(id = R.string.add_agent))
                    }
                }
            }

            items(agents) { agent ->
                AgentRow(
                    agent = agent,
                    isActive = agent.id == activeAgent?.id,
                    onActivate = { onActivateAgent(agent) },
                    onEdit = {
                        editingAgent = agent
                        showForm = true
                    },
                    onDelete = { onDeleteAgent(agent) }
                )
            }

            if (agents.isEmpty() && !showForm) {
                item {
                    Text(
                        text = stringResource(id = R.string.no_agents_message),
                        style = WearMaterialTheme.typography.bodyMedium,
                        color = WearMaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }
    }
}

@Composable
private fun AgentEditorCard(
    agent: AgentConfig?,
    onSubmit: (name: String, url: String, description: String, apiKey: String, apiKeyHeader: String) -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier
) {
    var name by remember(agent) { mutableStateOf(agent?.name.orEmpty()) }
    var url by remember(agent) { mutableStateOf(agent?.url.orEmpty()) }
    var description by remember(agent) { mutableStateOf(agent?.description.orEmpty()) }
    var apiKey by remember(agent) { mutableStateOf((agent?.authMethod as? AuthMethod.ApiKey)?.key.orEmpty()) }
    var apiKeyHeader by remember(agent) { mutableStateOf((agent?.authMethod as? AuthMethod.ApiKey)?.headerName.orEmpty()) }

    Surface(
        modifier = modifier.fillMaxWidth(),
        color = WearMaterialTheme.colorScheme.surfaceContainer,
        tonalElevation = 6.dp
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(10.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Text(
                text = if (agent == null) stringResource(id = R.string.add_agent) else stringResource(id = R.string.edit_agent),
                style = WearMaterialTheme.typography.titleMedium
            )
            WearTextField(
                label = stringResource(id = R.string.agent_name),
                value = name,
                onValueChange = { name = it }
            )
            WearTextField(
                label = stringResource(id = R.string.agent_url),
                value = url,
                onValueChange = { url = it }
            )
            WearTextField(
                label = stringResource(id = R.string.agent_description),
                value = description,
                onValueChange = { description = it },
                singleLine = false
            )
            WearTextField(
                label = stringResource(id = R.string.agent_api_key),
                value = apiKey,
                onValueChange = { apiKey = it }
            )
            WearTextField(
                label = stringResource(id = R.string.agent_api_key_header),
                value = apiKeyHeader,
                onValueChange = { apiKeyHeader = it }
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Button(
                    onClick = { onSubmit(name, url, description, apiKey, apiKeyHeader) },
                    modifier = Modifier.weight(1f),
                    enabled = name.isNotBlank() && url.isNotBlank()
                ) {
                    WearText(text = stringResource(id = R.string.save_agent))
                }
                TextButton(onClick = onCancel, modifier = Modifier.weight(1f)) {
                    Text(text = stringResource(id = R.string.cancel_operation))
                }
            }
        }
    }
}

@Composable
private fun WearTextField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    singleLine: Boolean = true
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        singleLine = singleLine,
        maxLines = if (singleLine) 1 else 4,
        label = { Text(text = label) },
        textStyle = WearMaterialTheme.typography.bodyMedium,
        colors = OutlinedTextFieldDefaults.colors(
            focusedContainerColor = WearMaterialTheme.colorScheme.surfaceContainer,
            unfocusedContainerColor = WearMaterialTheme.colorScheme.surfaceContainer,
            disabledContainerColor = WearMaterialTheme.colorScheme.surfaceContainer,
            focusedTextColor = WearMaterialTheme.colorScheme.onSurface,
            unfocusedTextColor = WearMaterialTheme.colorScheme.onSurface,
            disabledTextColor = WearMaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f),
            focusedBorderColor = WearMaterialTheme.colorScheme.primary,
            unfocusedBorderColor = WearMaterialTheme.colorScheme.outline
        ),
        modifier = modifier.fillMaxWidth()
    )
}

@Composable
private fun AgentRow(
    agent: AgentConfig,
    isActive: Boolean,
    onActivate: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
    modifier: Modifier = Modifier
) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        color = WearMaterialTheme.colorScheme.surfaceContainerHigh,
        tonalElevation = 6.dp
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(10.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = agent.name,
                    style = WearMaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                if (isActive) {
                    Text(
                        text = stringResource(id = R.string.active_agent_badge),
                        style = WearMaterialTheme.typography.labelSmall,
                        color = WearMaterialTheme.colorScheme.primary
                    )
                }
            }
            Text(
                text = agent.url,
                style = WearMaterialTheme.typography.bodySmall,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                color = WearMaterialTheme.colorScheme.onSurfaceVariant
            )
            agent.description?.takeIf { it.isNotBlank() }?.let { desc ->
                Text(
                    text = desc,
                    style = WearMaterialTheme.typography.bodySmall,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Button(
                    onClick = onActivate,
                    modifier = Modifier.weight(1f),
                    enabled = !isActive
                ) {
                    WearText(text = stringResource(id = R.string.make_active))
                }
                Button(
                    onClick = onEdit,
                    modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.filledTonalButtonColors()
                ) {
                    WearText(text = stringResource(id = R.string.edit))
                }
                Button(
                    onClick = onDelete,
                    modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.filledTonalButtonColors(containerColor = WearMaterialTheme.colorScheme.errorContainer)
                ) {
                    WearText(text = stringResource(id = R.string.delete))
                }
            }
        }
    }
}

@Composable
private fun MessageBubble(
    message: DisplayMessage,
    modifier: Modifier = Modifier,
    isEphemeral: Boolean = false
) {
    // This part is correct: get the background and (guaranteed readable) content color
    val (background, contentColor) = when (message.role) {
        MessageRole.USER -> WearMaterialTheme.colorScheme.primary to WearMaterialTheme.colorScheme.onPrimary
        MessageRole.ASSISTANT -> WearMaterialTheme.colorScheme.surfaceContainerHigh to WearMaterialTheme.colorScheme.onSurface
        MessageRole.SYSTEM, MessageRole.DEVELOPER -> WearMaterialTheme.colorScheme.surfaceContainer to WearMaterialTheme.colorScheme.onSurface
        MessageRole.ERROR -> WearMaterialTheme.colorScheme.error to WearMaterialTheme.colorScheme.onError
        MessageRole.TOOL_CALL -> WearMaterialTheme.colorScheme.tertiary to WearMaterialTheme.colorScheme.onTertiary
        MessageRole.STEP_INFO -> WearMaterialTheme.colorScheme.surfaceContainerLow to WearMaterialTheme.colorScheme.onSurfaceVariant
    }

    Card(
        modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = background,
            contentColor = contentColor // This provides the correct LocalContentColor
        )
    ) {
        Column(modifier = Modifier.padding(10.dp)) {
            Text(
                text = message.role.name.lowercase().replaceFirstChar { it.uppercase() },
                style = WearMaterialTheme.typography.labelSmall,
                color = LocalContentColor.current.copy(alpha = 0.8f)
            )
            Spacer(modifier = Modifier.height(4.dp))
            when {
                // This "streaming" block is for *ephemeral* messages and is fine.
                // Your "System" message was not ephemeral, it was a regular message.
                message.isStreaming -> {
                    Text(
                        text = message.content,
                        style = WearMaterialTheme.typography.bodyMedium,
                        color = LocalContentColor.current,
                        maxLines = 6,
                        overflow = TextOverflow.Ellipsis
                    )
                }

                // This "ephemeral" block is also fine.
                isEphemeral -> {
                    Text(
                        text = message.content,
                        style = WearMaterialTheme.typography.bodyMedium,
                        color = LocalContentColor.current,
                        maxLines = 6,
                        overflow = TextOverflow.Ellipsis
                    )
                }

                else -> {
                    // This is the readable contentColor (e.g., onSurface)
                    // guaranteed by our theme fix in Part 1
                    val textColor = contentColor

                    // 2. Only use Markdown for the Assistant
                    if (message.role == MessageRole.ASSISTANT) {
                        // --- THIS IS THE FIX ---
                        // Use the correct markdownColor function
                        Markdown(
                            content = message.content,
                            modifier = Modifier.fillMaxWidth(),
                            colors = markdownColor(
                                text = textColor,
                                codeBackground = WearMaterialTheme.colorScheme.surfaceContainerLow,
                                inlineCodeBackground = WearMaterialTheme.colorScheme.surfaceContainerLow,
                                dividerColor = textColor.copy(alpha = 0.3f),
                                tableBackground = Color.Transparent
                            )
                        )
                    } else {
                        // 3. Use plain, readable Text for SYSTEM (and others)
                        // This was the fix from last time and it works.
                        ProvideTextStyle(
                            WearMaterialTheme.typography.bodyMedium.copy(color = textColor)
                        ) {
                            Text(
                                text = message.content
                            )
                        }
                    }
                }
            }

            if (isEphemeral || message.isStreaming) {
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = if (message.isStreaming) "Streaming…" else "Ephemeral",
                    style = WearMaterialTheme.typography.bodySmall,
                    color = LocalContentColor.current.copy(alpha = 0.7f)
                )
            }
        }
    }
}

@Composable
private fun ChatInputCard(
    value: String,
    onValueChange: (String) -> Unit,
    enabled: Boolean,
    onSend: () -> Unit,
    modifier: Modifier = Modifier
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = WearMaterialTheme.colorScheme.surfaceContainer)
    ) {
        val keyboardController = LocalSoftwareKeyboardController.current
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(10.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            OutlinedTextField(
                value = value,
                onValueChange = onValueChange,
                enabled = enabled,
                singleLine = false,
                maxLines = 3,
                textStyle = WearMaterialTheme.typography.bodyMedium,
                placeholder = {
                    Text(
                        text = stringResource(id = R.string.chat_input_hint),
                        color = WearMaterialTheme.colorScheme.onSurfaceVariant
                    )
                },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(
                    onSend = {
                        if (enabled && value.isNotBlank()) {
                            onSend()
                            keyboardController?.hide()
                        }
                    }
                ),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedContainerColor = WearMaterialTheme.colorScheme.surfaceContainer,
                    unfocusedContainerColor = WearMaterialTheme.colorScheme.surfaceContainer,
                    disabledContainerColor = WearMaterialTheme.colorScheme.surfaceContainer,
                    focusedTextColor = WearMaterialTheme.colorScheme.onSurface,
                    unfocusedTextColor = WearMaterialTheme.colorScheme.onSurface,
                    disabledTextColor = WearMaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f),
                    focusedBorderColor = WearMaterialTheme.colorScheme.primary,
                    unfocusedBorderColor = WearMaterialTheme.colorScheme.outline
                ),
                modifier = Modifier.fillMaxWidth()
            )
            Button(
                onClick = {
                    onSend()
                    keyboardController?.hide()
                },
                enabled = enabled && value.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.filledTonalButtonColors(
                    containerColor = WearMaterialTheme.colorScheme.primary,
                    contentColor =WearMaterialTheme.colorScheme.onPrimary
                )
            ) {
                WearText(text = "Send")
            }
        }
    }
}

@Composable
private fun QuickPromptRow(
    prompts: List<String>,
    onPromptSelected: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    Column(modifier = modifier.fillMaxWidth()) {
        Text(
            text = stringResource(id = R.string.chip_prompt_summary),
            style = WearMaterialTheme.typography.labelSmall,
            color = WearMaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(modifier = Modifier.height(6.dp))
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            prompts.forEach { prompt ->
                AssistChip(
                    onClick = { onPromptSelected(prompt) },
                    label = { Text(text = prompt, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    colors = AssistChipDefaults.assistChipColors(
                        containerColor = WearMaterialTheme.colorScheme.secondaryContainer,
                        labelColor = WearMaterialTheme.colorScheme.onSecondaryContainer
                    )
                )
            }
        }
    }
}

@Composable
private fun ErrorCard(
    message: String,
    onDismiss: () -> Unit,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = WearMaterialTheme.colorScheme.errorContainer)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(10.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Text(
                text = message,
                style = WearMaterialTheme.typography.bodyMedium,
                color = WearMaterialTheme.colorScheme.onErrorContainer
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                TextButton(onClick = onDismiss, modifier = Modifier.weight(1f)) {
                    Text(text = "Dismiss", color = WearMaterialTheme.colorScheme.onErrorContainer)
                }
                Button(
                    onClick = onRetry,
                    modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.filledTonalButtonColors(
                        containerColor = WearMaterialTheme.colorScheme.onErrorContainer,
                        contentColor = WearMaterialTheme.colorScheme.errorContainer
                    )
                ) {
                    WearText(text = stringResource(id = R.string.retry))
                }
            }
        }
    }
}

@Composable
private fun LoadingIndicator(modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        contentAlignment = Alignment.Center
    ) {
        CircularProgressIndicator(color = WearMaterialTheme.colorScheme.primary)
    }
}
