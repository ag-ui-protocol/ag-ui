#include "stream/sse_parser.h"
#include <cassert>
#include <iostream>
#include <string>

using namespace agui;

// Simple test framework
int g_test_count = 0;
int g_test_passed = 0;
int g_test_failed = 0;

#define TEST_CASE(name) \
    void test_##name(); \
    struct TestRegistrar_##name { \
        TestRegistrar_##name() { \
            std::cout << "Running test: " << #name << std::endl; \
            g_test_count++; \
            try { \
                test_##name(); \
                g_test_passed++; \
                std::cout << "   PASSED" << std::endl; \
            } catch (const std::exception& e) { \
                g_test_failed++; \
                std::cout << "   FAILED: " << e.what() << std::endl; \
            } catch (...) { \
                g_test_failed++; \
                std::cout << "   FAILED: Unknown exception" << std::endl; \
            } \
        } \
    } g_test_registrar_##name; \
    void test_##name()

#define ASSERT_TRUE(condition) \
    if (!(condition)) { \
        throw std::runtime_error("Assertion failed: " #condition); \
    }

#define ASSERT_FALSE(condition) \
    if (condition) { \
        throw std::runtime_error("Assertion failed: !" #condition); \
    }

#define EXPECT_EQ(a, b) \
    if ((a) != (b)) { \
        throw std::runtime_error(std::string("Expected equal: ") + #a + " != " + #b); \
    }

// Basic functionality tests

TEST_CASE(BasicEvent) {
    SseParser parser;
    parser.feed("data: {\"type\":\"TEST\"}\n\n");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TEST");
    ASSERT_FALSE(parser.hasEvent());
}

TEST_CASE(MultipleEvents) {
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

TEST_CASE(EmptyData) {
    SseParser parser;
    parser.feed("\n\n");
    
    ASSERT_FALSE(parser.hasEvent());
}

// Cross-chunk split tests

TEST_CASE(SplitEvent) {
    SseParser parser;
    
    // First chunk: incomplete event
    parser.feed("data: {\"type\":");
    ASSERT_FALSE(parser.hasEvent());
    
    // Second chunk: complete event
    parser.feed("\"TEST\"}\n\n");
    ASSERT_TRUE(parser.hasEvent());
    
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TEST");
}

TEST_CASE(SplitAcrossMultipleChunks) {
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

TEST_CASE(DataPrefixSplitFromContent) {
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

TEST_CASE(NewlineSplitFromData) {
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

TEST_CASE(MultilineData) {
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

TEST_CASE(CommentLine) {
    SseParser parser;
    parser.feed(": this is a comment\n");
    parser.feed("data: {\"type\":\"TEST\"}\n\n");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TEST");
}

TEST_CASE(MultipleComments) {
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

TEST_CASE(IgnoreEventField) {
    SseParser parser;
    parser.feed("event: message\n");
    parser.feed("data: {\"type\":\"TEST\"}\n\n");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TEST");
}

TEST_CASE(IgnoreIdField) {
    SseParser parser;
    parser.feed("id: 123\n");
    parser.feed("data: {\"type\":\"TEST\"}\n\n");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TEST");
}

// Single chunk containing multiple events test

TEST_CASE(MultipleEventsInSingleChunk) {
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

TEST_CASE(Utf8Characters) {
    SseParser parser;
    parser.feed("data: {\"text\":\"Hello World\"}\n\n");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["text"], "Hello World");
}

TEST_CASE(Utf8Emoji) {
    SseParser parser;
    parser.feed("data: {\"text\":\"Hello  World \"}\n\n");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["text"], "Hello  World ");
}

// Stream end handling test (flush)

TEST_CASE(FlushWithCompleteEvent) {
    SseParser parser;
    parser.feed("data: {\"type\":\"TEST\"}\n\n");
    
    ASSERT_TRUE(parser.hasEvent());
    parser.flush();
    
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TEST");
}

TEST_CASE(FlushWithIncompleteEvent) {
    SseParser parser;
    parser.feed("data: {\"type\":\"TEST\"}\n");
    
    ASSERT_FALSE(parser.hasEvent());
    parser.flush();
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TEST");
}

TEST_CASE(FlushWithNoData) {
    SseParser parser;
    parser.feed("event: test\n");
    
    ASSERT_FALSE(parser.hasEvent());
    parser.flush();
    
    ASSERT_FALSE(parser.hasEvent());
}

// Clear buffer test

TEST_CASE(Clear) {
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

TEST_CASE(EmptyChunk) {
    SseParser parser;
    parser.feed("");
    ASSERT_FALSE(parser.hasEvent());
}

TEST_CASE(OnlyNewlines) {
    SseParser parser;
    parser.feed("\n\n\n\n");
    ASSERT_FALSE(parser.hasEvent());
}

TEST_CASE(CarriageReturn) {
    SseParser parser;
    parser.feed("data: {\"type\":\"TEST\"}\r\n\r\n");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TEST");
}

TEST_CASE(MixedNewlines) {
    SseParser parser;
    parser.feed("data: {\"type\":\"TEST\"}\r\n\n");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TEST");
}

TEST_CASE(VeryLongData) {
    SseParser parser;
    std::string longValue(10000, 'A');
    parser.feed("data: {\"value\":\"" + longValue + "\"}\n\n");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["value"], longValue);
}

// AG-UI real scenario tests

TEST_CASE(AgUiTextMessageStart) {
    SseParser parser;
    parser.feed("data: {\"type\":\"TEXT_MESSAGE_START\",\"messageId\":\"1\",\"role\":\"assistant\"}\n\n");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TEXT_MESSAGE_START");
    EXPECT_EQ(eventObj["messageId"], "1");
    EXPECT_EQ(eventObj["role"], "assistant");
}

TEST_CASE(AgUiTextMessageContent) {
    SseParser parser;
    parser.feed("data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"1\",\"delta\":\"Hello\"}\n\n");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TEXT_MESSAGE_CONTENT");
    EXPECT_EQ(eventObj["messageId"], "1");
    EXPECT_EQ(eventObj["delta"], "Hello");
}

TEST_CASE(AgUiCompleteConversation) {
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

TEST_CASE(AgUiToolCallStart) {
    SseParser parser;
    parser.feed("data: {\"type\":\"TOOL_CALL_START\",\"toolCallId\":\"call_123\",\"toolCallName\":\"search\"}\n\n");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TOOL_CALL_START");
    EXPECT_EQ(eventObj["toolCallId"], "call_123");
    EXPECT_EQ(eventObj["toolCallName"], "search");
}

TEST_CASE(AgUiNestedJson) {
    SseParser parser;
    parser.feed("data: {\"type\":\"TEST\",\"data\":{\"nested\":{\"value\":123}}}\n\n");
    
    ASSERT_TRUE(parser.hasEvent());
    auto evt = parser.nextEvent();
    nlohmann::json eventObj = nlohmann::json::parse(evt);
    EXPECT_EQ(eventObj["type"], "TEST");
    EXPECT_EQ(eventObj["data"]["nested"]["value"], 123);
}

// Performance tests

TEST_CASE(LargeNumberOfEvents) {
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

TEST_CASE(IncrementalFeedPerformance) {
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

TEST_CASE(InvalidJson) {
    SseParser parser;
    parser.feed("data: {invalid json}\n\n");
    
    ASSERT_TRUE(!parser.hasEvent());
}

TEST_CASE(GetLastError) {
    SseParser parser;
    
    // Initial state has no error
    EXPECT_EQ(parser.getLastError(), "");
    
    // Feed invalid JSON
    parser.feed("data: {invalid}\n\n");
    ASSERT_TRUE(!parser.hasEvent());
    
    // Should have error message
    ASSERT_FALSE(parser.getLastError().empty());
}

// Main function

int main() {
    std::cout << "\n========================================" << std::endl;
    std::cout << "AgUi SSE Parser Test Suite" << std::endl;
    std::cout << "========================================\n" << std::endl;
    
    // Tests will run automatically when global objects are initialized
    
    std::cout << "\n========================================" << std::endl;
    std::cout << "Test Results:" << std::endl;
    std::cout << "  Total:  " << g_test_count << std::endl;
    std::cout << "  Passed: " << g_test_passed << std::endl;
    std::cout << "  Failed: " << g_test_failed << std::endl;
    std::cout << "========================================" << std::endl;
    
    return g_test_failed > 0 ? 1 : 0;
}
