package com.agui.a2ui.catalog.widgets

import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.TextStyle
import com.agui.a2ui.model.CatalogItem
import com.agui.a2ui.model.DataContext
import com.agui.a2ui.model.DataReferenceParser
import com.agui.a2ui.model.LiteralString
import com.agui.a2ui.model.PathString
import com.agui.a2ui.util.parseBasicMarkdown
import kotlinx.serialization.json.JsonObject

/**
 * Text widget that displays a string with optional markdown formatting.
 *
 * JSON Schema:
 * ```json
 * {
 *   "text": {"literalString": "Hello"} | {"path": "/user/name"},
 *   "usageHint": "h1" | "h2" | "h3" | "body" | "caption" (optional)
 * }
 * ```
 */
val TextWidget = CatalogItem(
    name = "Text"
) { componentId, data, buildChild, dataContext, onEvent ->
    TextWidgetContent(data = data, dataContext = dataContext)
}

@Composable
private fun TextWidgetContent(
    data: JsonObject,
    dataContext: DataContext
) {
    val textRef = DataReferenceParser.parseString(data["text"])
    val usageHint = data["usageHint"]?.let {
        DataReferenceParser.parseString(it)
    }

    val text = when (textRef) {
        is LiteralString -> textRef.value
        is PathString -> dataContext.getString(textRef.path) ?: ""
        else -> ""
    }

    val hint = when (usageHint) {
        is LiteralString -> usageHint.value
        is PathString -> dataContext.getString(usageHint.path)
        else -> null
    }

    val style = getTextStyle(hint)
    val annotatedString = parseBasicMarkdown(text)

    Text(
        text = annotatedString,
        style = style
    )
}

@Composable
private fun getTextStyle(usageHint: String?): TextStyle {
    return when (usageHint?.lowercase()) {
        "h1" -> MaterialTheme.typography.headlineLarge
        "h2" -> MaterialTheme.typography.headlineMedium
        "h3" -> MaterialTheme.typography.headlineSmall
        "title" -> MaterialTheme.typography.titleLarge
        "subtitle" -> MaterialTheme.typography.titleMedium
        "body" -> MaterialTheme.typography.bodyLarge
        "caption" -> MaterialTheme.typography.bodySmall
        "label" -> MaterialTheme.typography.labelMedium
        else -> LocalTextStyle.current
    }
}
