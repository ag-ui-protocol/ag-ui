package com.agui.tests

import com.agui.core.types.*
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull

@OptIn(ExperimentalSerializationApi::class)
class LegacyBinaryRunInputTest {
    private val metadata = AgUiJson.parseToJsonElement("""{"label":"attachment","detail":null}""").jsonObject
    private val binary = BinaryInputContent(
        mimeType = "application/octet-stream",
        id = "asset-1",
        url = "https://example.test/asset.bin",
        data = "AQID",
        filename = "asset.bin",
        metadata = metadata,
    )

    @Test
    fun runInputWriterKeepsDeclaredProtocolVersionHonestForLegacyBinaryParts() {
        val expectedPart = AgUiJson.parseToJsonElement(
            """{"type":"binary","mimeType":"application/octet-stream","id":"asset-1","url":"https://example.test/asset.bin","data":"AQID","filename":"asset.bin","metadata":{"label":"attachment","detail":null}}""",
        )

        for (message in legacyMessages()) {
            val input = fullInput(listOf(message))
            val encoded = encode(input)

            assertFalse("protocolVersion" in encoded)
            val encodedMessage = encoded.getValue("messages").jsonArray.single().jsonObject
            assertEquals(expectedPart, encodedMessage.getValue("content").jsonArray.single())
            assertEquals(AgUiJson.encodeToJsonElement(Message.serializer(), message), encodedMessage)

            val decoded = AgUiJson.decodeFromJsonElement(RunAgentInput.serializer(), encoded)
            assertNull(decoded.protocolVersion)
            assertEquals(input.copy(protocolVersion = null), decoded)
            assertEquals(encoded, encode(decoded))
        }
    }

    @Test
    fun individualLegacySourcesKeepTheirOriginalShape() {
        val parts = listOf(
            BinaryInputContent(mimeType = "image/png", url = "https://example.test/image.png"),
            BinaryInputContent(mimeType = "audio/wav", data = "AQID"),
            BinaryInputContent(mimeType = "application/pdf", id = "file-1"),
        )

        for (part in parts) {
            for (message in legacyMessages(part)) {
                val encoded = encode(RunAgentInput("thread", "run", messages = listOf(message)))
                assertFalse("protocolVersion" in encoded)
                assertEquals(
                    AgUiJson.encodeToJsonElement(ContentPart.serializer(), part),
                    encoded.getValue("messages").jsonArray.single().jsonObject.getValue("content").jsonArray.single(),
                )
            }
        }
    }

    @Test
    fun absentVersionDecodesAsAbsentAndStaysAbsent() {
        val wire = AgUiJson.parseToJsonElement("""{"threadId":"thread","runId":"run","messages":[]}""")
        for (baseJson in listOf(AgUiJson, AgUiStrictJson)) {
            for (encodeDefaults in listOf(false, true)) {
                for (explicitNulls in listOf(false, true)) {
                    val json = Json(from = baseJson) {
                        this.encodeDefaults = encodeDefaults
                        this.explicitNulls = explicitNulls
                    }
                    val decoded = json.decodeFromJsonElement(RunAgentInput.serializer(), wire)
                    assertNull(decoded.protocolVersion)
                    assertEquals(RunAgentInput("thread", "run", protocolVersion = null), decoded)
                    val encoded = encode(decoded, json)
                    assertFalse("protocolVersion" in encoded)
                    assertEquals(JsonArray(emptyList()), encoded["messages"])
                    assertEquals(decoded, json.decodeFromJsonElement(RunAgentInput.serializer(), encoded))
                }
            }
        }
        assertNull(AgUiV1.decodeRunAgentInput(wire).protocolVersion)
    }

    @Test
    fun nullAndLegacyVersionsStayOmittedAcrossJsonConfigurations() {
        for (encodeDefaults in listOf(false, true)) {
            for (explicitNulls in listOf(false, true)) {
                val json = Json(from = AgUiJson) {
                    this.encodeDefaults = encodeDefaults
                    this.explicitNulls = explicitNulls
                }
                for (message in legacyMessages()) {
                    for (version in listOf(AG_UI_PROTOCOL_VERSION, null)) {
                        val input = fullInput(listOf(message)).copy(protocolVersion = version)
                        val encoded = encode(input, json)
                        assertFalse("protocolVersion" in encoded)
                        val decoded = json.decodeFromJsonElement(RunAgentInput.serializer(), encoded)
                        assertEquals(input.copy(protocolVersion = null), decoded)
                        assertEquals(encoded, encode(decoded, json))
                    }
                }
                val textInput = RunAgentInput(
                    "thread",
                    "run",
                    protocolVersion = null,
                    messages = listOf(UserMessage("message", "hello")),
                )
                assertFalse("protocolVersion" in encode(textInput, json))
            }
        }
    }

    @Test
    fun defaultV1RequestsDeclareVersionAndStrictDecode() {
        val messages = listOf<Message>(
            UserMessage("text", "hello"),
            UserMessage.multimodal(
                "image",
                listOf(ImagePart(UrlSource("https://example.test/image.png", "image/png"))),
            ),
            ToolMessage.multimodal(
                "document",
                listOf(DocumentPart(FileSource("file-1", "provider", "application/pdf"))),
                "call-1",
            ),
        )
        for (message in messages) {
            val input = RunAgentInput("thread", "run", messages = listOf(message))
            for (encodeDefaults in listOf(false, true)) {
                val json = Json(from = AgUiJson) { this.encodeDefaults = encodeDefaults }
                val encoded = encode(input, json)
                assertEquals(AG_UI_PROTOCOL_VERSION, encoded.getValue("protocolVersion").jsonPrimitive.content)
                assertEquals(input, AgUiV1.decodeRunAgentInput(encoded))
            }
        }
    }

    @Test
    fun emptyV1RequestsKeepRequiredMessagesWhenDefaultsAreDisabled() {
        val input = RunAgentInput("thread", "run")
        for (explicitNulls in listOf(false, true)) {
            val json = Json(from = AgUiJson) {
                encodeDefaults = false
                this.explicitNulls = explicitNulls
            }
            val encoded = encode(input, json)

            assertEquals(AG_UI_PROTOCOL_VERSION, encoded.getValue("protocolVersion").jsonPrimitive.content)
            assertEquals(JsonArray(emptyList()), encoded["messages"])
            assertFalse("tools" in encoded)
            assertEquals(input, AgUiV1.decodeRunAgentInput(encoded))
        }
    }

    @Test
    fun explicitOtherVersionsRemainUnchanged() {
        for (version in listOf("0.9", "1.1", "2.0")) {
            for (message in legacyMessages() + UserMessage("text", "hello")) {
                val input = fullInput(listOf(message)).copy(protocolVersion = version)
                val encoded = encode(input)
                assertEquals(version, encoded.getValue("protocolVersion").jsonPrimitive.content)
                assertEquals(input, AgUiJson.decodeFromJsonElement(RunAgentInput.serializer(), encoded))
            }
        }
    }

    @Test
    fun everyRunInputFieldSurvivesStrictAndTolerantRoundTrips() {
        val input = fullInput(listOf(UserMessage("message", "hello", metadata = metadata, subagentRunId = "sub-1")))
        for (json in listOf(AgUiJson, AgUiStrictJson)) {
            val encoded = encode(input, json)
            assertEquals(
                setOf("threadId", "runId", "protocolVersion", "parentRunId", "state", "messages", "tools", "context", "forwardedProps", "resume"),
                encoded.keys,
            )
            assertEquals(input, json.decodeFromJsonElement(RunAgentInput.serializer(), encoded))
            assertEquals(input, AgUiV1.decodeRunAgentInput(encoded))
        }
    }

    @Test
    fun opaqueApplicationDataDoesNotTriggerLegacyBinaryDetection() {
        val opaque = AgUiJson.parseToJsonElement("""{"type":"binary","content":[{"type":"binary"}]}""").jsonObject
        val input = fullInput(listOf(UserMessage("message", "binary", metadata = opaque))).copy(
            state = opaque,
            forwardedProps = opaque,
        )
        val encoded = encode(input)
        assertEquals(AG_UI_PROTOCOL_VERSION, encoded.getValue("protocolVersion").jsonPrimitive.content)
        assertEquals(input, AgUiV1.decodeRunAgentInput(encoded))
    }

    @Test
    fun strictReadersRejectUnknownRootFieldsAndCompatibilityReaderPreservesKnownFields() {
        val input = fullInput(listOf(UserMessage("message", "hello")))
        val wire = JsonObject(encode(input) + ("futureField" to JsonPrimitive("newer-peer")))

        assertFailsWith<SerializationException> {
            AgUiStrictJson.decodeFromJsonElement(RunAgentInput.serializer(), wire)
        }
        assertFailsWith<SerializationException> { AgUiV1.decodeRunAgentInput(wire) }
        assertEquals(input, AgUiJson.decodeFromJsonElement(RunAgentInput.serializer(), wire))
    }

    @Test
    fun strictValidationStillRejectsLegacyBinaryParts() {
        for (message in legacyMessages()) {
            val unversioned = encode(RunAgentInput("thread", "run", messages = listOf(message)))
            val versioned = JsonObject(unversioned + ("protocolVersion" to JsonPrimitive(AG_UI_PROTOCOL_VERSION)))
            for (wire in listOf(unversioned, versioned)) {
                val error = assertFailsWith<IllegalArgumentException> { AgUiV1.decodeRunAgentInput(wire) }
                assertEquals("Unknown AG-UI 1.0 content part: binary", error.message)
            }
        }
    }

    private fun legacyMessages(part: BinaryInputContent = binary): List<Message> = listOf(
        UserMessage.multimodal("user-message", listOf(part), name = "caller", metadata = metadata, subagentRunId = "sub-1"),
        ToolMessage.multimodal("tool-message", listOf(part), "call-1", metadata = metadata, subagentRunId = "sub-1"),
    )

    private fun fullInput(messages: List<Message>) = RunAgentInput(
        threadId = "thread",
        runId = "run",
        parentRunId = "parent-run",
        state = AgUiJson.parseToJsonElement("""{"items":[1,2],"optional":null}"""),
        messages = messages,
        tools = listOf(
            Tool("lookup", "Look up an item", AgUiJson.parseToJsonElement("""{"type":"object","default":null}"""), metadata),
        ),
        context = listOf(Context("locale", "en-US")),
        forwardedProps = AgUiJson.parseToJsonElement("""{"flag":true,"optional":null}"""),
        resume = listOf(
            ResumeEntry("interrupt-1", ResumeStatus.RESOLVED, AgUiJson.parseToJsonElement("""{"answer":42,"optional":null}"""), metadata),
            ResumeEntry("interrupt-2", ResumeStatus.CANCELLED),
        ),
    )

    private fun encode(input: RunAgentInput, json: Json = AgUiJson): JsonObject =
        json.encodeToJsonElement(RunAgentInput.serializer(), input).jsonObject
}
