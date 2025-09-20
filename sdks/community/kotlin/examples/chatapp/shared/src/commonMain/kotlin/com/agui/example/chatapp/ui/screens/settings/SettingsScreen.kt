package com.agui.example.chatapp.ui.screens.settings

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cafe.adriel.voyager.core.model.rememberScreenModel
import cafe.adriel.voyager.core.screen.Screen
import cafe.adriel.voyager.navigator.LocalNavigator
import cafe.adriel.voyager.navigator.currentOrThrow
import com.agui.example.chatapp.ui.screens.settings.components.AddAgentDialog
import com.agui.example.chatapp.ui.screens.settings.components.AgentCard
import org.jetbrains.compose.resources.stringResource
import agui4kclient.shared.generated.resources.*

class SettingsScreen : Screen {
    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    override fun Content() {
        val navigator = LocalNavigator.currentOrThrow
        val viewModel = rememberScreenModel { SettingsViewModel() }
        val state by viewModel.state.collectAsState()

        var showAddDialog by remember { mutableStateOf(false) }

        Scaffold(
            topBar = {
                TopAppBar(
                    title = { Text(stringResource(Res.string.settings)) },
                    navigationIcon = {
                        IconButton(onClick = { navigator.pop() }) {
                            Icon(
                                imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                                contentDescription = stringResource(Res.string.back)
                            )
                        }
                    }
                )
            },
            floatingActionButton = {
                FloatingActionButton(
                    onClick = { showAddDialog = true }
                ) {
                    Icon(
                        imageVector = Icons.Default.Add,
                        contentDescription = stringResource(Res.string.add_agent)
                    )
                }
            }
        ) { paddingValues ->
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(paddingValues),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                // Agents Section Header
                item {
                    Text(
                        text = stringResource(Res.string.agents),
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.padding(vertical = 8.dp)
                    )
                }

                if (state.agents.isEmpty()) {
                    item {
                        EmptyAgentsCard(
                            onAddClick = { showAddDialog = true }
                        )
                    }
                } else {
                    items(
                        items = state.agents,
                        key = { it.id }
                    ) { agent ->
                        AgentCard(
                            agent = agent,
                            isActive = agent.id == state.activeAgent?.id,
                            onActivate = { viewModel.setActiveAgent(agent) },
                            onEdit = { viewModel.editAgent(agent) },
                            onDelete = { viewModel.deleteAgent(agent.id) }
                        )
                    }
                }
            }
        }

        if (showAddDialog) {
            AddAgentDialog(
                onDismiss = { showAddDialog = false },
                onConfirm = { config ->
                    viewModel.addAgent(config)
                    showAddDialog = false
                }
            )
        }

        state.editingAgent?.let { agent ->
            AddAgentDialog(
                agent = agent,
                onDismiss = { viewModel.cancelEdit() },
                onConfirm = { config ->
                    viewModel.updateAgent(config)
                }
            )
        }
    }
}

@Composable
private fun EmptyAgentsCard(
    onAddClick: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
        )
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Icon(
                imageVector = Icons.Default.Info,
                contentDescription = null,
                modifier = Modifier.size(48.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant
            )

            Spacer(modifier = Modifier.height(16.dp))

            Text(
                text = stringResource(Res.string.no_agents_configured),
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            Text(
                text = stringResource(Res.string.add_agent_to_start),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            Spacer(modifier = Modifier.height(16.dp))

            Button(onClick = onAddClick) {
                Icon(
                    imageVector = Icons.Default.Add,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp)
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(stringResource(Res.string.add_agent))
            }
        }
    }
}