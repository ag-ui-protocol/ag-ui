package com.agui.example.chatapp.ui.screens.chat.components

import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.text
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.agui.example.chatapp.ui.screens.chat.DisplayMessage
import com.agui.example.chatapp.ui.screens.chat.MessageRole
import com.halilibo.richtext.commonmark.Markdown
import com.halilibo.richtext.ui.material3.RichText
import kotlinx.datetime.Instant
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime

@Composable
fun MessageBubble(
    message: DisplayMessage,
    modifier: Modifier = Modifier
) {
    val isUser = message.role == MessageRole.USER
    val isError = message.role == MessageRole.ERROR
    val isSystem = message.role == MessageRole.SYSTEM
    val isToolCall = message.role == MessageRole.TOOL_CALL
    val isStepInfo = message.role == MessageRole.STEP_INFO
    val isEphemeral = message.ephemeralGroupId != null
    val messageTextColor = when {
        isUser -> MaterialTheme.colorScheme.onPrimary
        isError -> MaterialTheme.colorScheme.onError
        isSystem -> MaterialTheme.colorScheme.onTertiary
        isToolCall -> MaterialTheme.colorScheme.onSecondaryContainer
        isStepInfo -> MaterialTheme.colorScheme.onTertiaryContainer
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }

    // Enhanced fade-in animation
    val animatedAlpha = remember(message.id) { Animatable(0f) }
    LaunchedEffect(message.id) {
        if (isEphemeral) {
            // Slower, more noticeable fade for ephemeral messages
            animatedAlpha.animateTo(
                targetValue = 0.8f,  // Don't go fully opaque
                animationSpec = tween(
                    durationMillis = 800,  // Slower fade
                    easing = FastOutSlowInEasing
                )
            )
        } else {
            // Quick fade for regular messages
            animatedAlpha.animateTo(
                targetValue = 1f,
                animationSpec = tween(durationMillis = 200)
            )
        }
    }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 4.dp)
            .alpha(animatedAlpha.value),  // Apply fade
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = 280.dp)
                .clip(
                    RoundedCornerShape(
                        topStart = 12.dp,
                        topEnd = 12.dp,
                        bottomStart = if (isUser) 12.dp else 4.dp,
                        bottomEnd = if (isUser) 4.dp else 12.dp
                    )
                )
                .background(
                    when {
                        isUser -> MaterialTheme.colorScheme.primary
                        isError -> MaterialTheme.colorScheme.error
                        isSystem -> MaterialTheme.colorScheme.tertiary
                        isToolCall -> MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.7f)
                        isStepInfo -> MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.7f)
                        else -> MaterialTheme.colorScheme.surfaceVariant
                    }
                )
                .padding(horizontal = 12.dp, vertical = 8.dp)
        ) {
            if (message.isStreaming) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Text(
                        text = message.content,
                        style = MaterialTheme.typography.bodyLarge,
                        color = messageTextColor
                    )
                    CircularProgressIndicator(
                        modifier = Modifier.size(12.dp),
                        strokeWidth = 2.dp,
                        color = if (isUser) {
                            MaterialTheme.colorScheme.onPrimary
                        } else {
                            MaterialTheme.colorScheme.primary
                        }
                    )
                }
            } else {
                // Main message text
                if (isEphemeral) {
                    // For ephemeral messages, create a shimmering text
                    val infiniteTransition = rememberInfiniteTransition(label = "textShimmer")
                    val shimmerTranslateAnim by infiniteTransition.animateFloat(
                        initialValue = 0f,
                        targetValue = 200f,
                        animationSpec = infiniteRepeatable(
                            animation = tween(800, easing = LinearEasing),
                            repeatMode = RepeatMode.Restart
                        ),
                        label = "textShimmer"
                    )

                    val textColor = messageTextColor

                    Box {
                        Text(
                            text = message.content,
                            style = MaterialTheme.typography.bodyMedium,
                            color = textColor,
                            modifier = Modifier.drawWithContent {
                                drawContent()

                                // Draw shimmer overlay
                                val shimmerBrush = Brush.linearGradient(
                                    colors = listOf(
                                        Color.Transparent,
                                        Color.White.copy(alpha = 0.3f),
                                        Color.Transparent
                                    ),
                                    start = Offset(shimmerTranslateAnim - 100f, 0f),
                                    end = Offset(shimmerTranslateAnim + 100f, 0f)
                                )

                                drawRect(
                                    brush = shimmerBrush,
                                    blendMode = BlendMode.SrcOver
                                )
                            }
                        )
                    }
                } else {
                    // Regular text for non-ephemeral messages
                    ProvideTextStyle(MaterialTheme.typography.bodyLarge) {
                        CompositionLocalProvider(LocalContentColor provides messageTextColor) {
                            RichText(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .semantics { text = AnnotatedString(message.content) }
                            ) {
                                Markdown(message.content)
                            }
                        }
                    }
                }
            }

            // Always show timestamp when message is complete
            if (!message.isStreaming && !isEphemeral) {  // Don't show timestamp for ephemeral messages
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = formatTimestamp(message.timestamp),
                    style = MaterialTheme.typography.labelSmall,
                    color = when {
                        isUser -> MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.7f)
                        isError -> MaterialTheme.colorScheme.onError.copy(alpha = 0.7f)
                        isSystem -> MaterialTheme.colorScheme.onTertiary.copy(alpha = 0.7f)
                        else -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f)
                    },
                    textAlign = if (isUser) TextAlign.End else TextAlign.Start,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        }
    }
}

@Composable
private fun formatTimestamp(timestamp: Long): String {
    val instant = Instant.fromEpochMilliseconds(timestamp)
    val localDateTime = instant.toLocalDateTime(TimeZone.currentSystemDefault())
    return "${localDateTime.hour.toString().padStart(2, '0')}:${localDateTime.minute.toString().padStart(2, '0')}"
}
