/**
 * @file test_sse_parser.cpp
 * @brief SSE Parser functionality tests
 * 
 * Tests SSE event parsing, chunking, multiline data, comments, and edge cases
 */

#include <gtest/gtest.h>
#include <string>

#include "stream/sse_parser.h"

using namespace agui;

// Basic functionality tests
TEST(SseParserTest, BasicEvent) {
    SseParser parser;
    parser.feed("data: {\"type\":\"TEST\"}\n\n");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TEST");
    ASSERT_FALSE(parser.hasEvent());
}

TEST(SseParserTest, MultipleEvents) {
    SseParser parser;
    parser.feed("data: {\"type\":\"EVENT1\"}\n\n");
    parser.feed("data: {\"type\":\"EVENT2\"}\n\n");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt1 = parser.nextEvent();
    nlohmann::json eventObj1 = nlohmann::json::parse(evt1);
    EXPECT_EQ(eventObj1["type"], "EVENT1");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt2 = parser.nextEvent();
    nlohmann::json eventObj2 = nlohmann::json::parse(evt2);
    EXPECT_EQ(eventObj2["type"], "EVENT2");
    
    ASSERT_FALSE(parser.hasEvent());
}

TEST(SseParserTest, EmptyData) {
    SseParser parser;
    parser.feed("\n\n");
    
    ASSERT_FALSE(parser.hasEvent());
}

TEST(SseParserTest, DataPrefixSplitFromContent) {
    SseParser parser;
    
    // data: prefix in one chunk
    parser.feed("data: ");
    ASSERT_FALSE(parser.hasEvent());
    
    // JSON content in another chunk
    parser.feed("{\"type\":\"TEST\"}\n\n");
    ASSERT_TRUE(parser.hasEvent());
    
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TEST");
}

TEST(SseParserTest, SplitAcrossMultipleChunks) {
    SseParser parser;
    
    parser.feed("data: {\"type\":");
    ASSERT_FALSE(parser.hasEvent());
    
    parser.feed("\"TEXT_MESSAGE");
    ASSERT_FALSE(parser.hasEvent());
    
    parser.feed("_CONTENT\",\"messageId\":");
    ASSERT_FALSE(parser.hasEvent());
    
    parser.feed("\"1\",\"delta\":\"Hello\"}\n\n");
    ASSERT_TRUE(parser.hasEvent());
    
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TEXT_MESSAGE_CONTENT");
    EXPECT_EQ(eventObj["messageId"], "1");
    EXPECT_EQ(eventObj["delta"], "Hello");
}

TEST(SseParserTest, NewlineSplitFromData) {
    SseParser parser;
    
    // data line in one chunk
    parser.feed("data: {\"type\":\"TEST\"}\n");
    ASSERT_FALSE(parser.hasEvent());
    
    // second newline in another chunk
    parser.feed("\n");
    ASSERT_TRUE(parser.hasEvent());
    
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TEST");
}

TEST(SseParserTest, MultilineData) {
    SseParser parser;
    parser.feed("data: {\n");
    parser.feed("data: \"type\": \"TEST\"\n");
    parser.feed("data: }\n\n");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TEST");
}

// Comment line tests
TEST(SseParserTest, MultipleComments) {
    SseParser parser;
    parser.feed(": comment 1\n");
    parser.feed(": comment 2\n");
    parser.feed("data: {\"type\":\"TEST\"}\n\n");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TEST");
}

// event and id field tests (AgUiSseParser ignores these fields)
TEST(SseParserTest, IgnoreEventField) {
    SseParser parser;
    parser.feed("event: message\n");
    parser.feed("data: {\"type\":\"TEST\"}\n\n");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TEST");
}

// Single chunk containing multiple events test
TEST(SseParserTest, MultipleEventsInSingleChunk) {
    SseParser parser;
    parser.feed("data: {\"type\":\"EVENT1\"}\n\ndata: {\"type\":\"EVENT2\"}\n\ndata: {\"type\":\"EVENT3\"}\n\n");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt1 = parser.nextEvent();
    nlohmann::json eventObj1 = nlohmann::json::parse(evt1);
    EXPECT_EQ(eventObj1["type"], "EVENT1");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt2 = parser.nextEvent();
    nlohmann::json eventObj2 = nlohmann::json::parse(evt2);
    EXPECT_EQ(eventObj2["type"], "EVENT2");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt3 = parser.nextEvent();
    nlohmann::json eventObj3 = nlohmann::json::parse(evt3);
    EXPECT_EQ(eventObj3["type"], "EVENT3");
    
    ASSERT_FALSE(parser.hasEvent());
}

// UTF-8 character tests
TEST(SseParserTest, Utf8Characters) {
    SseParser parser;
    parser.feed("data: {\"text\":\"你好\"}\n\n");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["text"], "你好");
}

TEST(SseParserTest, Utf8Emoji) {
    SseParser parser;
    parser.feed("data: {\"text\":\"Hello 🌍 World 🚀\"}\n\n");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["text"], "Hello 🌍 World 🚀");
}

// Stream end handling test (flush)
TEST(SseParserTest, FlushWithCompleteEvent) {
    SseParser parser;
    parser.feed("data: {\"type\":\"TEST\"}\n\n");
    
    ASSERT_TRUE(parser.hasEvent());
    parser.flush();
    
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TEST");
}

TEST(SseParserTest, FlushWithIncompleteEvent) {
    SseParser parser;
    parser.feed("data: {\"type\":\"TEST\"}\n");
    
    ASSERT_FALSE(parser.hasEvent());
    parser.flush();
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TEST");
}

TEST(SseParserTest, FlushWithIncompleteEventWithoutTrailingNewline) {
    SseParser parser;
    parser.feed("data: {\"type\":\"TEST\"}");

    ASSERT_FALSE(parser.hasEvent());
    parser.flush();

    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TEST");
}

TEST(SseParserTest, FlushWithNoData) {
    SseParser parser;
    parser.feed("event: test\n");
    
    ASSERT_FALSE(parser.hasEvent());
    parser.flush();
    
    ASSERT_FALSE(parser.hasEvent());
}

// Clear buffer test
TEST(SseParserTest, Clear) {
    SseParser parser;
    parser.feed("data: {\"type\":\"TEST1\"}\n\n");
    parser.feed("data: {\"type\":\"TEST2\"}\n");
    
    ASSERT_TRUE(parser.hasEvent());
    parser.clear();
    
    ASSERT_FALSE(parser.hasEvent());
    
    // Should be able to continue using after clear
    parser.feed("data: {\"type\":\"TEST3\"}\n\n");
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TEST3");
}

// Edge case tests
TEST(SseParserTest, EmptyChunk) {
    SseParser parser;
    parser.feed("");
    ASSERT_FALSE(parser.hasEvent());
}

TEST(SseParserTest, OnlyNewlines) {
    SseParser parser;
    parser.feed("\n\n\n\n");
    ASSERT_FALSE(parser.hasEvent());
}

TEST(SseParserTest, CarriageReturn) {
    SseParser parser;
    parser.feed("data: {\"type\":\"TEST\"}\r\n\r\n");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TEST");
}

TEST(SseParserTest, MixedNewlines) {
    SseParser parser;
    parser.feed("data: {\"type\":\"TEST\"}\r\n\n");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TEST");
}

TEST(SseParserTest, VeryLongData) {
    SseParser parser;
    std::string longValue(10000, 'A');
    parser.feed("data: {\"value\":\"" + longValue + "\"}\n\n");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["value"], longValue);
}

// AG-UI real scenario tests
TEST(SseParserTest, AgUiTextMessageStart) {
    SseParser parser;
    parser.feed("data: {\"type\":\"TEXT_MESSAGE_START\",\"messageId\":\"1\",\"role\":\"assistant\"}\n\n");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TEXT_MESSAGE_START");
    EXPECT_EQ(eventObj["messageId"], "1");
    EXPECT_EQ(eventObj["role"], "assistant");
}

TEST(SseParserTest, AgUiTextMessageContent) {
    SseParser parser;
    parser.feed("data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"1\",\"delta\":\"Hello\"}\n\n");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TEXT_MESSAGE_CONTENT");
    EXPECT_EQ(eventObj["messageId"], "1");
    EXPECT_EQ(eventObj["delta"], "Hello");
}

TEST(SseParserTest, AgUiCompleteConversation) {
    SseParser parser;
    
    // START event
    parser.feed("data: {\"type\":\"TEXT_MESSAGE_START\",\"messageId\":\"1\"}\n\n");
    ASSERT_TRUE(parser.hasEvent());
    auto evt1 = parser.nextEvent();
    nlohmann::json eventObj1 = nlohmann::json::parse(evt1);
    EXPECT_EQ(eventObj1["type"], "TEXT_MESSAGE_START");
    
    // CONTENT event 1
    parser.feed("data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"1\",\"delta\":\"Hello\"}\n\n");
    ASSERT_TRUE(parser.hasEvent());
    auto evt2 = parser.nextEvent();
    nlohmann::json eventObj2 = nlohmann::json::parse(evt2);
    EXPECT_EQ(eventObj2["delta"], "Hello");
    
    // CONTENT event 2
    parser.feed("data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"1\",\"delta\":\" World\"}\n\n");
    ASSERT_TRUE(parser.hasEvent());
    auto evt3 = parser.nextEvent();
    nlohmann::json eventObj3 = nlohmann::json::parse(evt3);
    EXPECT_EQ(eventObj3["delta"], " World");
    
    // END event
    parser.feed("data: {\"type\":\"TEXT_MESSAGE_END\",\"messageId\":\"1\"}\n\n");
    ASSERT_TRUE(parser.hasEvent());
    auto evt4 = parser.nextEvent();
    nlohmann::json eventObj4 = nlohmann::json::parse(evt4);
    EXPECT_EQ(eventObj4["type"], "TEXT_MESSAGE_END");
    
    ASSERT_FALSE(parser.hasEvent());
}

TEST(SseParserTest, AgUiToolCallStart) {
    SseParser parser;
    parser.feed("data: {\"type\":\"TOOL_CALL_START\",\"toolCallId\":\"call_123\",\"toolCallName\":\"search\"}\n\n");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TOOL_CALL_START");
    EXPECT_EQ(eventObj["toolCallId"], "call_123");
    EXPECT_EQ(eventObj["toolCallName"], "search");
}

TEST(SseParserTest, AgUiNestedJson) {
    SseParser parser;
    parser.feed("data: {\"type\":\"TEST\",\"data\":{\"nested\":{\"value\":123}}}\n\n");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TEST");
    EXPECT_EQ(eventObj["data"]["nested"]["value"], 123);
}

TEST(SseParserTest, LargeNumberOfEventsCorrectness) {
    SseParser parser;
    
    const int eventCount = 1000;
    for (int i = 0; i < eventCount; i++) {
        parser.feed("data: {\"index\":" + std::to_string(i) + "}\n\n");
    }
    
    int count = 0;
    while (parser.hasEvent()) {
        auto evt = parser.nextEvent();
        nlohmann::json eventObj = nlohmann::json::parse(evt);
        EXPECT_EQ(eventObj["index"], count);
        count++;
    }
    
    EXPECT_EQ(count, eventCount);
}

TEST(SseParserTest, IncrementalFeedCorrectness) {
    SseParser parser;
    
    // Simulate feeding one character at a time
    std::string data = "data: {\"type\":\"TEST\"}\n\n";
    for (char c : data) {
        parser.feed(std::string(1, c));
    }
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TEST");
}

// Error handling tests
TEST(SseParserTest, InvalidJson) {
    SseParser parser;
    parser.feed("data: {invalid json}\n\n");
    
    // SSE format is valid, so an event should be created
    // even though the JSON content is invalid
    ASSERT_TRUE(parser.hasEvent());
    
    // Upper layer is responsible for JSON parsing
    auto jsonStr = parser.nextEvent();
    bool parseError = false;
    try {
        nlohmann::json eventJson = nlohmann::json::parse(jsonStr);
        (void)eventJson;
    } catch (const nlohmann::json::parse_error&) {
        parseError = true;
    }
    ASSERT_TRUE(parseError);
}

// Note: getLastError() was removed (dead code — m_lastError was never set).
// JSON parse errors are handled in HttpAgent::processAvailableEvents via try-catch.

// Buffer size limit test
TEST(SseParserTest, BufferSizeExceeded) {
    SseParser parser;
    
    // Feed data that exceeds the 10 MB limit
    std::string hugeData(SseParser::kMaxBufferSize + 1, 'A');
    
    EXPECT_THROW(parser.feed(hugeData), SseBufferExceededError);
}

TEST(SseParserTest, BufferSizeNearLimit) {
    SseParser parser;
    
    // Feed data that is just under the limit - should not throw
    std::string nearLimitData(SseParser::kMaxBufferSize / 2, 'A');
    
    EXPECT_NO_THROW(parser.feed(nearLimitData));
}

TEST(SseParserTest, BufferSizeExactlyAtLimit) {
    SseParser parser;
    
    // Feed data that is exactly at the limit - should not throw
    std::string exactLimitData(SseParser::kMaxBufferSize, 'A');
    
    EXPECT_NO_THROW(parser.feed(exactLimitData));
}

TEST(SseParserTest, EventAccumulatorSizeExceeded) {
    SseParser parser;

    // A single event whose data is never terminated by a blank line, delivered
    // as many small chunks. Each chunk is consumed out of m_buffer immediately,
    // so the buffer stays small while the per-event accumulator keeps growing.
    const size_t kChunkPayload = 64 * 1024;
    const std::string chunk = "data: " + std::string(kChunkPayload, 'A') + "\n";
    const size_t iterations = (SseParser::kMaxBufferSize / kChunkPayload) + 8;

    EXPECT_THROW({
        for (size_t i = 0; i < iterations; ++i) {
            parser.feed(chunk);
        }
    }, SseBufferExceededError);
}

// JSON nesting depth limit tests

// `depth` levels of nested arrays, one container per level.
static std::string nestedArrays(int depth) {
    return std::string(static_cast<size_t>(depth), '[') + std::string(static_cast<size_t>(depth), ']');
}

TEST(SseParserTest, JsonDepthLimitAdmitsTheLimit) {
    // The deepest payload that gets through has exactly kMaxJsonDepth containers.
    const std::string atLimit = nestedArrays(SseParser::kMaxJsonDepth);

    nlohmann::json parsed;
    EXPECT_NO_THROW(parsed = parseJsonWithDepthLimit(atLimit));
    EXPECT_EQ(parsed, nlohmann::json::parse(atLimit));
}

TEST(SseParserTest, JsonDepthLimitRefusesOneLevelPast) {
    const std::string pastLimit = nestedArrays(SseParser::kMaxJsonDepth + 1);

    EXPECT_THROW(parseJsonWithDepthLimit(pastLimit), JsonDepthExceededError);
}

TEST(SseParserTest, JsonDepthLimitCountsObjectsLikeArrays) {
    // `depth` levels of nested objects, one container per level.
    auto nestedObjects = [](int depth) {
        std::string open;
        std::string close;
        for (int level = 0; level < depth; ++level) {
            open += "{\"k\":";
            close += "}";
        }
        return open + "1" + close;
    };

    EXPECT_NO_THROW(parseJsonWithDepthLimit(nestedObjects(SseParser::kMaxJsonDepth)));
    EXPECT_THROW(parseJsonWithDepthLimit(nestedObjects(SseParser::kMaxJsonDepth + 1)),
                 JsonDepthExceededError);
}

TEST(SseParserTest, JsonDepthLimitRefusesPayloadFarPastLimitWithParseError) {
    // Far past the limit, but well under kMaxBufferSize: the byte cap alone
    // does not stop this.
    const std::string deeplyNested = nestedArrays(100000);
    ASSERT_LT(deeplyNested.size(), SseParser::kMaxBufferSize);

    try {
        parseJsonWithDepthLimit(deeplyNested);
        FAIL() << "Expected JsonDepthExceededError";
    } catch (const JsonDepthExceededError& e) {
        EXPECT_EQ(e.type(), ErrorType::Parse);
        EXPECT_EQ(e.code(), ErrorCode::ParseJsonError);
        EXPECT_NE(e.message().find(std::to_string(SseParser::kMaxJsonDepth)), std::string::npos);
    }
}

TEST(SseParserTest, JsonDepthLimitAcceptsLegitimatelyDeepPayloads) {
    // An absolute depth, deliberately not derived from kMaxJsonDepth, so the
    // limit cannot drift below what real state or activity content reaches.
    const std::string nested = nestedArrays(64);
    const std::string payload = "{\"type\":\"CUSTOM\",\"name\":\"deep\",\"value\":" + nested + "}";

    EXPECT_NO_THROW(parseJsonWithDepthLimit(payload));
}

TEST(SseParserTest, JsonDepthLimitDoesNotCountBracketsInsideStrings) {
    const std::string brackets(static_cast<size_t>(SseParser::kMaxJsonDepth) * 2, '[');
    const std::string payload = "{\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"m1\",\"delta\":\"" +
                                brackets + "\"}";

    nlohmann::json parsed;
    EXPECT_NO_THROW(parsed = parseJsonWithDepthLimit(payload));
    EXPECT_EQ(parsed["delta"], brackets);
}

TEST(SseParserTest, JsonDepthLimitParsesNormalInputUnchanged) {
    const std::string payload =
        "{\"type\":\"STATE_SNAPSHOT\",\"snapshot\":{\"items\":[1,2.5,\"three\",null,true,"
        "{\"nested\":{\"list\":[[],{}]}}],\"empty\":{},\"text\":\"a\\\"b\"},\"timestamp\":123}";

    EXPECT_EQ(parseJsonWithDepthLimit(payload), nlohmann::json::parse(payload));
}

TEST(SseParserTest, JsonDepthLimitStillReportsMalformedJsonAsParseError) {
    EXPECT_THROW(parseJsonWithDepthLimit("{not valid json}"), nlohmann::json::parse_error);
}
