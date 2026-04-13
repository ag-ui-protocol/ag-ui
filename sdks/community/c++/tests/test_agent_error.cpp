/**
 * @file test_agent_error.cpp
 * @brief AgentError class unit tests
 *
 * Covers construction, message formatting, stack trace, static factories,
 * and the what() interface required by std::exception.
 */

#include <gtest/gtest.h>
#include <string>

#include "core/error.h"

using namespace agui;

// ── Construction & Basic Fields ────────────────────────────────────────────

TEST(AgentErrorTest, BasicConstruction) {
    AgentError err(ErrorType::Network, ErrorCode::NetworkError, "connection refused");

    EXPECT_EQ(err.type(), ErrorType::Network);
    EXPECT_EQ(err.code(), ErrorCode::NetworkError);
    EXPECT_EQ(err.message(), "connection refused");
}

TEST(AgentErrorTest, DefaultSeverityIsError) {
    AgentError err(ErrorType::Parse, ErrorCode::ParseJsonError, "bad json");
    EXPECT_EQ(err.severity(), ErrorSeverity::Error);
}

TEST(AgentErrorTest, CustomSeverity) {
    AgentError err(ErrorType::Validation, ErrorCode::ValidationError, "missing field",
                   ErrorSeverity::Warning);
    EXPECT_EQ(err.severity(), ErrorSeverity::Warning);
}

// ── what() interface ───────────────────────────────────────────────────────

TEST(AgentErrorTest, WhatIsNonEmpty) {
    AgentError err(ErrorType::Execution, ErrorCode::ExecutionAgentFailed, "run failed");
    EXPECT_NE(err.what(), nullptr);
    EXPECT_GT(std::string(err.what()).size(), 0u);
}

TEST(AgentErrorTest, WhatContainsMessage) {
    AgentError err(ErrorType::Network, ErrorCode::NetworkTimeout, "timed out after 30s");
    std::string w(err.what());
    EXPECT_NE(w.find("timed out after 30s"), std::string::npos);
}

// ── fullMessage ────────────────────────────────────────────────────────────

TEST(AgentErrorTest, FullMessageContainsCode) {
    AgentError err(ErrorType::Network, ErrorCode::NetworkError, "refused");
    std::string full = err.fullMessage();
    // Code 20005 should appear
    EXPECT_NE(full.find("20005"), std::string::npos);
}

TEST(AgentErrorTest, FullMessageContainsMessage) {
    AgentError err(ErrorType::State, ErrorCode::StatePatchFailed, "patch op /foo not found");
    std::string full = err.fullMessage();
    EXPECT_NE(full.find("patch op /foo not found"), std::string::npos);
}

// ── Stack Trace ────────────────────────────────────────────────────────────

TEST(AgentErrorTest, StackTraceInitiallyEmpty) {
    AgentError err(ErrorType::Unknown, ErrorCode::Unknown, "oops");
    EXPECT_TRUE(err.stackTrace().empty());
}

TEST(AgentErrorTest, AddStackFrame) {
    AgentError err(ErrorType::Unknown, ErrorCode::Unknown, "oops");
    err.addStackFrame("myFunction", "myfile.cpp", 42);

    ASSERT_EQ(err.stackTrace().size(), 1u);
    EXPECT_EQ(err.stackTrace()[0].function, "myFunction");
    EXPECT_EQ(err.stackTrace()[0].file, "myfile.cpp");
    EXPECT_EQ(err.stackTrace()[0].line, 42);
}

TEST(AgentErrorTest, FullMessageContainsStackFrame) {
    AgentError err(ErrorType::Unknown, ErrorCode::Unknown, "oops");
    err.addStackFrame("myFunc", "foo.cpp", 10);
    std::string full = err.fullMessage();
    EXPECT_NE(full.find("myFunc"), std::string::npos);
    EXPECT_NE(full.find("foo.cpp"), std::string::npos);
}

// ── Recovery Strategy ──────────────────────────────────────────────────────

TEST(AgentErrorTest, DefaultRecoveryStrategyIsNone) {
    AgentError err(ErrorType::Unknown, ErrorCode::Unknown, "x");
    EXPECT_EQ(err.recoveryStrategy(), RecoveryStrategy::None);
}

TEST(AgentErrorTest, SetRecoveryStrategy) {
    AgentError err(ErrorType::Network, ErrorCode::NetworkError, "retry me");
    err.withRecoveryStrategy(RecoveryStrategy::Retry);
    EXPECT_EQ(err.recoveryStrategy(), RecoveryStrategy::Retry);
}

// ── Static Factory Methods ─────────────────────────────────────────────────

TEST(AgentErrorTest, StaticNetwork) {
    auto err = AgentError::network(ErrorCode::NetworkConnectionFailed, "connect failed");
    EXPECT_EQ(err.type(), ErrorType::Network);
    EXPECT_EQ(err.code(), ErrorCode::NetworkConnectionFailed);
    EXPECT_EQ(err.message(), "connect failed");
}

TEST(AgentErrorTest, StaticParse) {
    auto err = AgentError::parse(ErrorCode::ParseJsonError, "invalid json");
    EXPECT_EQ(err.type(), ErrorType::Parse);
}

TEST(AgentErrorTest, StaticExecution) {
    auto err = AgentError::execution(ErrorCode::ExecutionAgentFailed, "agent error");
    EXPECT_EQ(err.type(), ErrorType::Execution);
}

TEST(AgentErrorTest, StaticValidation) {
    auto err = AgentError::validation(ErrorCode::ValidationError, "missing field");
    EXPECT_EQ(err.type(), ErrorType::Validation);
}

TEST(AgentErrorTest, StaticState) {
    auto err = AgentError::state(ErrorCode::StatePatchFailed, "bad patch");
    EXPECT_EQ(err.type(), ErrorType::State);
}

TEST(AgentErrorTest, StaticUnknown) {
    auto err = AgentError::unknown("unexpected");
    EXPECT_EQ(err.type(), ErrorType::Unknown);
    EXPECT_EQ(err.code(), ErrorCode::Unknown);
}

// ── Error Code Values ──────────────────────────────────────────────────────

TEST(AgentErrorTest, UnknownCodeIs99999) {
    // Verifies the XYYZZ (5-digit) scheme; was erroneously 990000 before fix
    EXPECT_EQ(static_cast<int>(ErrorCode::Unknown), 99999);
}

TEST(AgentErrorTest, ErrorCodesAre5Digits) {
    // All defined codes should be 10000–99999
    auto check = [](ErrorCode code) {
        int v = static_cast<int>(code);
        EXPECT_GE(v, 10000) << "code " << v << " is less than 5 digits";
        EXPECT_LE(v, 99999) << "code " << v << " exceeds 5 digits";
    };
    check(ErrorCode::ValidationError);
    check(ErrorCode::NetworkConnectionFailed);
    check(ErrorCode::NetworkTimeout);
    check(ErrorCode::NetworkInvalidResponse);
    check(ErrorCode::NetworkSslError);
    check(ErrorCode::NetworkError);
    check(ErrorCode::ParseJsonError);
    check(ErrorCode::ParseSseError);
    check(ErrorCode::ParseEventError);
    check(ErrorCode::ParseMessageError);
    check(ErrorCode::ExecutionAgentFailed);
    check(ErrorCode::ExecutionToolCallFailed);
    check(ErrorCode::ExecutionStateUpdateFailed);
    check(ErrorCode::ValidationInvalidInput);
    check(ErrorCode::ValidationInvalidState);
    check(ErrorCode::ValidationInvalidEvent);
    check(ErrorCode::ValidationInvalidArgument);
    check(ErrorCode::StateInvalidTransition);
    check(ErrorCode::StatePatchFailed);
    check(ErrorCode::Unknown);
}

// ── std::exception interface ───────────────────────────────────────────────

TEST(AgentErrorTest, IsThrowableAsStdException) {
    bool caught = false;
    try {
        throw AgentError(ErrorType::Execution, ErrorCode::ExecutionAgentFailed, "thrown");
    } catch (const std::exception& e) {
        caught = true;
        EXPECT_NE(std::string(e.what()).find("thrown"), std::string::npos);
    }
    EXPECT_TRUE(caught);
}
