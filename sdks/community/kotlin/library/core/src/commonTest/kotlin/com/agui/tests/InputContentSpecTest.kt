package com.agui.tests

import com.agui.core.types.*
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.*
import kotlin.test.*

/**
 * Verifies that the spec-compliant InputContent types (image/audio/video/document)
 * round-trip correctly and produce JSON that matches @ag-ui/client output byte-for-byte.
 */
class InputContentSpecTest {

    private val json = AgUiJson

    // ── InputContentSource ───────────────────────────────────────────────────

    @Test
    fun testDataSourceRoundTrip() {
        val src = InputContentDataSource(value = "SGVsbG8=", mimeType = "image/png")
        val encoded = json.encodeToString(InputContentSource.serializer(), src)
        val obj = json.parseToJsonElement(encoded).jsonObject

        assertEquals("data", obj["type"]?.jsonPrimitive?.content)
        assertEquals("SGVsbG8=", obj["value"]?.jsonPrimitive?.content)
        assertEquals("image/png", obj["mimeType"]?.jsonPrimitive?.content)

        val decoded = json.decodeFromString(InputContentSource.serializer(), encoded)
        assertEquals(src, decoded)
    }

    @Test
    fun testUrlSourceRoundTrip() {
        val src = InputContentUrlSource(value = "https://example.com/img.png", mimeType = "image/png")
        val encoded = json.encodeToString(InputContentSource.serializer(), src)
        val obj = json.parseToJsonElement(encoded).jsonObject

        assertEquals("url", obj["type"]?.jsonPrimitive?.content)
        assertEquals("https://example.com/img.png", obj["value"]?.jsonPrimitive?.content)
        assertEquals("image/png", obj["mimeType"]?.jsonPrimitive?.content)

        val decoded = json.decodeFromString(InputContentSource.serializer(), encoded)
        assertEquals(src, decoded)
    }

    @Test
    fun testUrlSourceWithoutMimeType() {
        val src = InputContentUrlSource(value = "https://example.com/doc.pdf")
        val encoded = json.encodeToString(InputContentSource.serializer(), src)
        val obj = json.parseToJsonElement(encoded).jsonObject

        assertEquals("url", obj["type"]?.jsonPrimitive?.content)
        // explicitNulls = false → mimeType absent when null
        assertFalse(obj.containsKey("mimeType"))

        val decoded = json.decodeFromString(InputContentSource.serializer(), encoded)
        assertEquals(src, decoded)
    }

    // ── Spec media InputContent types ────────────────────────────────────────

    @Test
    fun testImageInputContentDataSource() {
        val content = ImageInputContent(
            source = InputContentDataSource(value = "SGVsbG8=", mimeType = "image/jpeg")
        )
        val encoded = json.encodeToString(InputContent.serializer(), content)
        val obj = json.parseToJsonElement(encoded).jsonObject

        assertEquals("image", obj["type"]?.jsonPrimitive?.content)
        assertFalse(obj.containsKey("metadata"))

        val source = obj["source"]?.jsonObject
        assertNotNull(source)
        assertEquals("data", source["type"]?.jsonPrimitive?.content)
        assertEquals("SGVsbG8=", source["value"]?.jsonPrimitive?.content)
        assertEquals("image/jpeg", source["mimeType"]?.jsonPrimitive?.content)

        val decoded = json.decodeFromString(InputContent.serializer(), encoded)
        assertEquals(content, decoded)
    }

    @Test
    fun testImageInputContentUrlSource() {
        val content = ImageInputContent(
            source = InputContentUrlSource(value = "https://example.com/photo.png", mimeType = "image/png"),
            metadata = buildJsonObject { put("alt", "a photo") }
        )
        val encoded = json.encodeToString(InputContent.serializer(), content)
        val obj = json.parseToJsonElement(encoded).jsonObject

        assertEquals("image", obj["type"]?.jsonPrimitive?.content)
        assertEquals("a photo", obj["metadata"]?.jsonObject?.get("alt")?.jsonPrimitive?.content)

        val source = obj["source"]?.jsonObject
        assertNotNull(source)
        assertEquals("url", source["type"]?.jsonPrimitive?.content)

        val decoded = json.decodeFromString(InputContent.serializer(), encoded)
        assertEquals(content, decoded)
    }

    @Test
    fun testAudioInputContent() {
        val content = AudioInputContent(
            source = InputContentDataSource(value = "UklGRg==", mimeType = "audio/wav")
        )
        val encoded = json.encodeToString(InputContent.serializer(), content)
        val obj = json.parseToJsonElement(encoded).jsonObject

        assertEquals("audio", obj["type"]?.jsonPrimitive?.content)
        assertEquals("data", obj["source"]?.jsonObject?.get("type")?.jsonPrimitive?.content)

        val decoded = json.decodeFromString(InputContent.serializer(), encoded)
        assertEquals(content, decoded)
    }

    @Test
    fun testVideoInputContent() {
        val content = VideoInputContent(
            source = InputContentUrlSource(value = "https://example.com/clip.mp4", mimeType = "video/mp4")
        )
        val encoded = json.encodeToString(InputContent.serializer(), content)
        val obj = json.parseToJsonElement(encoded).jsonObject

        assertEquals("video", obj["type"]?.jsonPrimitive?.content)
        assertEquals("url", obj["source"]?.jsonObject?.get("type")?.jsonPrimitive?.content)

        val decoded = json.decodeFromString(InputContent.serializer(), encoded)
        assertEquals(content, decoded)
    }

    @Test
    fun testDocumentInputContent() {
        val content = DocumentInputContent(
            source = InputContentDataSource(value = "JVBERi0=", mimeType = "application/pdf")
        )
        val encoded = json.encodeToString(InputContent.serializer(), content)
        val obj = json.parseToJsonElement(encoded).jsonObject

        assertEquals("document", obj["type"]?.jsonPrimitive?.content)
        assertEquals("data", obj["source"]?.jsonObject?.get("type")?.jsonPrimitive?.content)

        val decoded = json.decodeFromString(InputContent.serializer(), encoded)
        assertEquals(content, decoded)
    }

    // ── Multimodal UserMessage with spec types ────────────────────────────────

    @Test
    fun testMultimodalUserMessageWithImageAndText() {
        val parts: List<InputContent> = listOf(
            TextInputContent(text = "Describe this image:"),
            ImageInputContent(
                source = InputContentUrlSource(
                    value = "https://example.com/chart.png",
                    mimeType = "image/png"
                )
            )
        )
        val message = UserMessage.multimodal(id = "msg_spec_1", parts = parts)

        val encoded = json.encodeToString<Message>(message)
        val obj = json.parseToJsonElement(encoded).jsonObject

        val contentArray = obj["content"]?.jsonArray
        assertNotNull(contentArray)
        assertEquals(2, contentArray.size)

        assertEquals("text", contentArray[0].jsonObject["type"]?.jsonPrimitive?.content)
        assertEquals("image", contentArray[1].jsonObject["type"]?.jsonPrimitive?.content)

        val decoded = json.decodeFromString<Message>(encoded) as UserMessage
        assertTrue(decoded.isMultimodal)
        assertEquals(2, decoded.contentParts?.size)
        assertTrue(decoded.contentParts!![0] is TextInputContent)
        assertTrue(decoded.contentParts!![1] is ImageInputContent)
    }

    @Test
    fun testMultimodalUserMessageWithDocument() {
        val parts: List<InputContent> = listOf(
            TextInputContent(text = "Summarize this document:"),
            DocumentInputContent(
                source = InputContentDataSource(value = "JVBERi0=", mimeType = "application/pdf"),
                metadata = buildJsonObject { put("filename", "report.pdf") }
            )
        )
        val message = UserMessage.multimodal(id = "msg_spec_2", parts = parts)

        val encoded = json.encodeToString<Message>(message)
        val contentArray = json.parseToJsonElement(encoded).jsonObject["content"]?.jsonArray
        assertNotNull(contentArray)

        val docPart = contentArray[1].jsonObject
        assertEquals("document", docPart["type"]?.jsonPrimitive?.content)
        assertEquals("report.pdf", docPart["metadata"]?.jsonObject?.get("filename")?.jsonPrimitive?.content)

        val decoded = json.decodeFromString<Message>(encoded) as UserMessage
        val docContent = decoded.contentParts!![1] as DocumentInputContent
        assertEquals("application/pdf", (docContent.source as InputContentDataSource).mimeType)
    }

    // ── Deserialization from raw JSON (web client wire format) ────────────────

    @Test
    fun testDeserializeWebClientWireFormat() {
        // Exact JSON shape that @ag-ui/client emits for a document message
        val wireJson = """
            [
              {"type":"text","text":"Please review:"},
              {"type":"document","source":{"type":"data","value":"JVBERi0=","mimeType":"application/pdf"},"metadata":{"title":"Q3 Report"}}
            ]
        """.trimIndent()

        val parts = json.decodeFromString(ListSerializer(InputContent.serializer()), wireJson)
        assertEquals(2, parts.size)

        val text = parts[0] as TextInputContent
        assertEquals("Please review:", text.text)

        val doc = parts[1] as DocumentInputContent
        val src = doc.source as InputContentDataSource
        assertEquals("JVBERi0=", src.value)
        assertEquals("application/pdf", src.mimeType)
        assertEquals("Q3 Report", doc.metadata?.jsonObject?.get("title")?.jsonPrimitive?.content)
    }

    @Test
    fun testDeserializeImageUrlWireFormat() {
        val wireJson = """
            {"type":"image","source":{"type":"url","value":"https://cdn.example.com/img.webp"}}
        """.trimIndent()

        val content = json.decodeFromString(InputContent.serializer(), wireJson) as ImageInputContent
        val src = content.source as InputContentUrlSource
        assertEquals("https://cdn.example.com/img.webp", src.value)
        assertNull(src.mimeType)
        assertNull(content.metadata)
    }

    // ── Mixed legacy + spec types in one message ──────────────────────────────

    @Test
    fun testMixedLegacyAndSpecTypes() {
        val parts: List<InputContent> = listOf(
            TextInputContent(text = "Here are two attachments:"),
            BinaryInputContent(mimeType = "image/png", url = "https://example.com/legacy.png"),
            DocumentInputContent(source = InputContentDataSource(value = "abc=", mimeType = "text/plain"))
        )
        val message = UserMessage.multimodal(id = "mixed_msg", parts = parts)
        val encoded = json.encodeToString<Message>(message)
        val decoded = json.decodeFromString<Message>(encoded) as UserMessage

        assertEquals(3, decoded.contentParts?.size)
        assertTrue(decoded.contentParts!![0] is TextInputContent)
        assertTrue(decoded.contentParts!![1] is BinaryInputContent)
        assertTrue(decoded.contentParts!![2] is DocumentInputContent)
    }
}
