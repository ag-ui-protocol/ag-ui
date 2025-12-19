package com.agui.a2ui.catalog.widgets

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import coil3.compose.AsyncImagePainter
import coil3.compose.SubcomposeAsyncImage
import com.agui.a2ui.model.CatalogItem
import com.agui.a2ui.model.DataContext
import com.agui.a2ui.model.DataReferenceParser
import com.agui.a2ui.model.LiteralString
import com.agui.a2ui.model.PathString
import kotlinx.serialization.json.JsonObject

/**
 * Image widget that displays an image from a URL.
 *
 * JSON Schema:
 * ```json
 * {
 *   "url": {"literalString": "https://example.com/image.jpg"} | {"path": "/item/imageUrl"},
 *   "contentDescription": {"literalString": "Description"} (optional),
 *   "height": 200 (optional, in dp)
 * }
 * ```
 */
val ImageWidget = CatalogItem(
    name = "Image"
) { componentId, data, buildChild, dataContext, onEvent ->
    ImageWidgetContent(data = data, dataContext = dataContext)
}

@Composable
private fun ImageWidgetContent(
    data: JsonObject,
    dataContext: DataContext
) {
    val urlRef = DataReferenceParser.parseString(data["url"])
    val descriptionRef = DataReferenceParser.parseString(data["contentDescription"])
    val heightRef = DataReferenceParser.parseNumber(data["height"])

    val url = when (urlRef) {
        is LiteralString -> urlRef.value
        is PathString -> dataContext.getString(urlRef.path)
        else -> null
    }

    val description = when (descriptionRef) {
        is LiteralString -> descriptionRef.value
        is PathString -> dataContext.getString(descriptionRef.path)
        else -> null
    }

    val height = when (heightRef) {
        is com.agui.a2ui.model.LiteralNumber -> heightRef.value.dp
        is com.agui.a2ui.model.PathNumber -> dataContext.getNumber(heightRef.path)?.dp
        else -> null
    }

    if (url != null) {
        val modifier = if (height != null) {
            Modifier.fillMaxWidth().height(height)
        } else {
            Modifier.fillMaxWidth()
        }

        SubcomposeAsyncImage(
            model = url,
            contentDescription = description,
            modifier = modifier,
            contentScale = ContentScale.Crop,
            loading = {
                Box(
                    modifier = Modifier.fillMaxWidth().height(100.dp),
                    contentAlignment = Alignment.Center
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(24.dp))
                }
            },
            error = {
                Box(
                    modifier = Modifier.fillMaxWidth().height(100.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text("Failed to load image")
                }
            }
        )
    }
}
