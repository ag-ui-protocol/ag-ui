/*
 * MIT License
 *
 * Copyright (c) 2025 Mark Fogle
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
package com.agui.example.chatapp.ui.screens.chat.components

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import org.jetbrains.compose.resources.stringResource
import agui4kclient.shared.generated.resources.*

@Composable
fun ChatInput(
    enabled: Boolean,
    onSendMessage: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    var textFieldValue by remember { mutableStateOf(TextFieldValue()) }

    Surface(
        modifier = modifier,
        shadowElevation = 8.dp
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(8.dp),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            OutlinedTextField(
                value = textFieldValue,
                onValueChange = { textFieldValue = it },
                modifier = Modifier.weight(1f),
                enabled = enabled,
                placeholder = {
                    Text(
                        text = if (enabled)
                            stringResource(Res.string.type_message_hint)
                        else
                            stringResource(Res.string.select_agent_hint),
                        style = MaterialTheme.typography.bodyLarge
                    )
                },
                keyboardOptions = KeyboardOptions(
                    imeAction = ImeAction.Send
                ),
                keyboardActions = KeyboardActions(
                    onSend = {
                        if (textFieldValue.text.isNotBlank()) {
                            onSendMessage(textFieldValue.text)
                            textFieldValue = TextFieldValue()
                        }
                    }
                ),
                singleLine = true, // This ensures Enter sends the message
                shape = RoundedCornerShape(24.dp)
            )

            FloatingActionButton(
                onClick = {
                    if (textFieldValue.text.isNotBlank()) {
                        onSendMessage(textFieldValue.text)
                        textFieldValue = TextFieldValue()
                    }
                },
                modifier = Modifier.size(48.dp),
                containerColor = MaterialTheme.colorScheme.primary,
                contentColor = MaterialTheme.colorScheme.onPrimary,
                elevation = FloatingActionButtonDefaults.elevation(
                    defaultElevation = 0.dp
                )
            ) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.Send,
                    contentDescription = stringResource(Res.string.send),
                    modifier = Modifier.size(24.dp)
                )
            }
        }
    }
}