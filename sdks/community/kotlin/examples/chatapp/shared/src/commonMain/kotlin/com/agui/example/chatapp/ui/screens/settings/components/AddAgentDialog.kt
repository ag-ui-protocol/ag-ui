package com.agui.example.chatapp.ui.screens.settings.components

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.agui.example.chatapp.data.model.AgentConfig
import com.agui.example.chatapp.data.model.AuthMethod
import org.jetbrains.compose.resources.stringResource
import agui4kclient.shared.generated.resources.*
import com.agui.example.chatapp.util.Strings

fun getAuthMethodLabel(authMethod: AuthMethod): String {
    return when (authMethod) {
        is AuthMethod.None -> "No Authentication" // Will be replaced with string resource
        is AuthMethod.ApiKey -> "API Key"
        is AuthMethod.BearerToken -> "Bearer Token"
        is AuthMethod.BasicAuth -> "Basic Auth"
        is AuthMethod.OAuth2 -> "OAuth 2.0"
        is AuthMethod.Custom -> "Custom"
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AddAgentDialog(
    agent: AgentConfig? = null,
    onDismiss: () -> Unit,
    onConfirm: (AgentConfig) -> Unit
) {
    var name by remember { mutableStateOf(agent?.name ?: "") }
    var url by remember { mutableStateOf(agent?.url ?: "") }
    var description by remember { mutableStateOf(agent?.description ?: "") }
    var systemPrompt by remember { mutableStateOf(agent?.systemPrompt ?: "") }
    var authMethod by remember { mutableStateOf(agent?.authMethod ?: AuthMethod.None()) }

    var nameError by remember { mutableStateOf<String?>(null) }
    var urlError by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(if (agent != null) stringResource(Res.string.edit_agent) else stringResource(Res.string.add_agent))
        },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                // Name field
                OutlinedTextField(
                    value = name,
                    onValueChange = {
                        name = it
                        nameError = null
                    },
                    label = { Text(stringResource(Res.string.agent_name)) },
                    placeholder = { Text(stringResource(Res.string.agent_name_hint)) },
                    singleLine = true,
                    isError = nameError != null,
                    supportingText = nameError?.let { { Text(it) } },
                    modifier = Modifier.fillMaxWidth()
                )

                // URL field
                OutlinedTextField(
                    value = url,
                    onValueChange = {
                        url = it
                        urlError = null
                    },
                    label = { Text(stringResource(Res.string.agent_url)) },
                    placeholder = { Text(stringResource(Res.string.agent_url_hint)) },
                    singleLine = true,
                    isError = urlError != null,
                    supportingText = urlError?.let { { Text(it) } },
                    modifier = Modifier.fillMaxWidth()
                )

                // Description field
                OutlinedTextField(
                    value = description,
                    onValueChange = { description = it },
                    label = { Text(stringResource(Res.string.agent_description)) },
                    placeholder = { Text(stringResource(Res.string.agent_description_hint)) },
                    minLines = 2,
                    maxLines = 3,
                    modifier = Modifier.fillMaxWidth()
                )

                // Auth method section
                AuthMethodSelector(
                    authMethod = authMethod,
                    onAuthMethodChange = { authMethod = it }
                )

                // System Prompt field
                OutlinedTextField(
                    value = systemPrompt,
                    onValueChange = { systemPrompt = it },
                    label = { Text("System Prompt") },
                    placeholder = { Text("Optional initial system message...") },
                    minLines = 3,
                    maxLines = 5,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    // Validate inputs
                    var hasError = false

                    if (name.isBlank()) {
                        nameError = Strings.NAME_REQUIRED
                        hasError = true
                    }

                    if (url.isBlank()) {
                        urlError = Strings.URL_REQUIRED
                        hasError = true
                    } else if (!url.startsWith("http://") && !url.startsWith("https://")) {
                        urlError = Strings.URL_INVALID
                        hasError = true
                    }

                    if (!hasError) {
                        val config = if (agent != null) {
                            agent.copy(
                                name = name.trim(),
                                url = url.trim(),
                                description = description.trim().takeIf { it.isNotEmpty() },
                                authMethod = authMethod,
                                systemPrompt = systemPrompt.trim().takeIf { it.isNotEmpty() }
                            )
                        } else {
                            AgentConfig(
                                id = AgentConfig.generateId(),
                                name = name.trim(),
                                url = url.trim(),
                                description = description.trim().takeIf { it.isNotEmpty() },
                                authMethod = authMethod,
                                systemPrompt = systemPrompt.trim().takeIf { it.isNotEmpty() }
                            )
                        }
                        onConfirm(config)
                    }
                }
            ) {
                Text(if (agent != null) stringResource(Res.string.save) else stringResource(Res.string.add))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(Res.string.cancel))
            }
        }
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AuthMethodSelector(
    authMethod: AuthMethod,
    onAuthMethodChange: (AuthMethod) -> Unit
) {
    var expanded by remember { mutableStateOf(false) }

    Column(
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Text(
            text = stringResource(Res.string.authentication),
            style = MaterialTheme.typography.labelLarge
        )

        ExposedDropdownMenuBox(
            expanded = expanded,
            onExpandedChange = { expanded = it }
        ) {
            OutlinedTextField(
                value = getAuthMethodLabel(authMethod),
                onValueChange = { },
                readOnly = true,
                trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
                modifier = Modifier
                    .fillMaxWidth()
                    .menuAnchor(MenuAnchorType.PrimaryNotEditable)
            )

            ExposedDropdownMenu(
                expanded = expanded,
                onDismissRequest = { expanded = false }
            ) {
                DropdownMenuItem(
                    text = { Text(stringResource(Res.string.auth_none)) },
                    onClick = {
                        onAuthMethodChange(AuthMethod.None())
                        expanded = false
                    }
                )
                DropdownMenuItem(
                    text = { Text(stringResource(Res.string.auth_api_key)) },
                    onClick = {
                        onAuthMethodChange(AuthMethod.ApiKey("", "X-API-Key"))
                        expanded = false
                    }
                )
                DropdownMenuItem(
                    text = { Text(stringResource(Res.string.auth_bearer_token)) },
                    onClick = {
                        onAuthMethodChange(AuthMethod.BearerToken(""))
                        expanded = false
                    }
                )
                DropdownMenuItem(
                    text = { Text(stringResource(Res.string.auth_basic)) },
                    onClick = {
                        onAuthMethodChange(AuthMethod.BasicAuth("", ""))
                        expanded = false
                    }
                )
            }
        }

        // Auth method specific fields
        when (authMethod) {
            is AuthMethod.ApiKey -> {
                var apiKey by remember(authMethod) { mutableStateOf(authMethod.key) }
                var headerName by remember(authMethod) { mutableStateOf(authMethod.headerName) }

                OutlinedTextField(
                    value = apiKey,
                    onValueChange = {
                        apiKey = it
                        onAuthMethodChange(authMethod.copy(key = it))
                    },
                    label = { Text(stringResource(Res.string.auth_api_key)) },
                    visualTransformation = PasswordVisualTransformation(),
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )

                OutlinedTextField(
                    value = headerName,
                    onValueChange = {
                        headerName = it
                        onAuthMethodChange(authMethod.copy(headerName = it))
                    },
                    label = { Text(stringResource(Res.string.header_name)) },
                    placeholder = { Text(stringResource(Res.string.header_name_hint)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
            }

            is AuthMethod.BearerToken -> {
                var token by remember(authMethod) { mutableStateOf(authMethod.token) }

                OutlinedTextField(
                    value = token,
                    onValueChange = {
                        token = it
                        onAuthMethodChange(authMethod.copy(token = it))
                    },
                    label = { Text(stringResource(Res.string.auth_bearer_token)) },
                    visualTransformation = PasswordVisualTransformation(),
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
            }

            is AuthMethod.BasicAuth -> {
                var username by remember(authMethod) { mutableStateOf(authMethod.username) }
                var password by remember(authMethod) { mutableStateOf(authMethod.password) }

                OutlinedTextField(
                    value = username,
                    onValueChange = {
                        username = it
                        onAuthMethodChange(authMethod.copy(username = it))
                    },
                    label = { Text(stringResource(Res.string.username)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )

                OutlinedTextField(
                    value = password,
                    onValueChange = {
                        password = it
                        onAuthMethodChange(authMethod.copy(password = it))
                    },
                    label = { Text(stringResource(Res.string.password)) },
                    visualTransformation = PasswordVisualTransformation(),
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
            }

            else -> {
                // No additional fields for None or other auth methods
            }
        }
    }
}