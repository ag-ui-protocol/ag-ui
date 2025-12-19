package com.agui.a2ui.util

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration

/**
 * Parses basic markdown formatting and returns an AnnotatedString.
 *
 * Supported formatting:
 * - **bold** or __bold__
 * - *italic* or _italic_
 * - [link text](url)
 * - # Header (h1), ## Header (h2), ### Header (h3)
 *
 * This is a simple parser for basic inline formatting.
 * It does not support complex markdown features like tables, code blocks, or lists.
 */
fun parseBasicMarkdown(text: String): AnnotatedString {
    return buildAnnotatedString {
        var i = 0
        val length = text.length

        while (i < length) {
            when {
                // Bold with **
                text.startsWith("**", i) -> {
                    val endIndex = text.indexOf("**", i + 2)
                    if (endIndex != -1) {
                        val boldText = text.substring(i + 2, endIndex)
                        pushStyle(SpanStyle(fontWeight = FontWeight.Bold))
                        append(boldText)
                        pop()
                        i = endIndex + 2
                    } else {
                        append(text[i])
                        i++
                    }
                }

                // Bold with __
                text.startsWith("__", i) -> {
                    val endIndex = text.indexOf("__", i + 2)
                    if (endIndex != -1) {
                        val boldText = text.substring(i + 2, endIndex)
                        pushStyle(SpanStyle(fontWeight = FontWeight.Bold))
                        append(boldText)
                        pop()
                        i = endIndex + 2
                    } else {
                        append(text[i])
                        i++
                    }
                }

                // Italic with * (but not **)
                text[i] == '*' && (i + 1 >= length || text[i + 1] != '*') -> {
                    val endIndex = text.indexOf('*', i + 1)
                    if (endIndex != -1 && (endIndex + 1 >= length || text[endIndex + 1] != '*')) {
                        val italicText = text.substring(i + 1, endIndex)
                        pushStyle(SpanStyle(fontStyle = FontStyle.Italic))
                        append(italicText)
                        pop()
                        i = endIndex + 1
                    } else {
                        append(text[i])
                        i++
                    }
                }

                // Italic with _ (but not __)
                text[i] == '_' && (i + 1 >= length || text[i + 1] != '_') -> {
                    val endIndex = text.indexOf('_', i + 1)
                    if (endIndex != -1 && (endIndex + 1 >= length || text[endIndex + 1] != '_')) {
                        val italicText = text.substring(i + 1, endIndex)
                        pushStyle(SpanStyle(fontStyle = FontStyle.Italic))
                        append(italicText)
                        pop()
                        i = endIndex + 1
                    } else {
                        append(text[i])
                        i++
                    }
                }

                // Link [text](url)
                text[i] == '[' -> {
                    val closeBracket = text.indexOf(']', i + 1)
                    if (closeBracket != -1 && closeBracket + 1 < length && text[closeBracket + 1] == '(') {
                        val closeParen = text.indexOf(')', closeBracket + 2)
                        if (closeParen != -1) {
                            val linkText = text.substring(i + 1, closeBracket)
                            val url = text.substring(closeBracket + 2, closeParen)

                            pushStyle(SpanStyle(
                                textDecoration = TextDecoration.Underline,
                                fontWeight = FontWeight.Medium
                            ))
                            pushStringAnnotation(tag = "URL", annotation = url)
                            append(linkText)
                            pop()
                            pop()
                            i = closeParen + 1
                        } else {
                            append(text[i])
                            i++
                        }
                    } else {
                        append(text[i])
                        i++
                    }
                }

                else -> {
                    append(text[i])
                    i++
                }
            }
        }
    }
}

/**
 * Strips markdown formatting and returns plain text.
 */
fun stripMarkdown(text: String): String {
    return text
        .replace(Regex("\\*\\*(.+?)\\*\\*"), "$1")
        .replace(Regex("__(.+?)__"), "$1")
        .replace(Regex("\\*(.+?)\\*"), "$1")
        .replace(Regex("_(.+?)_"), "$1")
        .replace(Regex("\\[(.+?)\\]\\(.+?\\)"), "$1")
        .replace(Regex("^#{1,6}\\s+"), "")
}
