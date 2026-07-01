# AG-UI C++ SDK Test Configuration

# Test 1: Event Handler Tests
add_executable(test_event_handler test_event_handler.cpp)
target_link_libraries(test_event_handler PRIVATE ag-ui GTest::gtest GTest::gtest_main)
add_test(NAME EventHandlerTests COMMAND test_event_handler)

# Test 2: State Manager Tests
add_executable(test_state_manager test_state_manager.cpp)
target_link_libraries(test_state_manager PRIVATE ag-ui GTest::gtest GTest::gtest_main)
add_test(NAME StateManagerTests COMMAND test_state_manager)

# Test 3: Apply Module Tests
add_executable(test_apply_module test_apply_module.cpp)
target_link_libraries(test_apply_module PRIVATE ag-ui GTest::gtest GTest::gtest_main)
add_test(NAME ApplyModuleTests COMMAND test_apply_module)

# Test 4: SSE Parser Tests
add_executable(test_sse_parser test_sse_parser.cpp)
target_link_libraries(test_sse_parser PRIVATE ag-ui GTest::gtest GTest::gtest_main)
add_test(NAME SSEParserTests COMMAND test_sse_parser)

# Test 5: HTTP Agent Tests
add_executable(test_http_agent test_http_agent.cpp)
target_link_libraries(test_http_agent PRIVATE ag-ui GTest::gtest GTest::gtest_main)
add_test(NAME HttpAgentTests COMMAND test_http_agent)

# Test 6: Middleware System Tests
add_executable(test_middleware test_middleware.cpp)
target_link_libraries(test_middleware PRIVATE ag-ui GTest::gtest GTest::gtest_main)
add_test(NAME MiddlewareTests COMMAND test_middleware)

# Test 7: SSE Server Integration Tests (requires Mock server)
add_executable(test_sse_server test_sse_server.cpp)
target_link_libraries(test_sse_server PRIVATE ag-ui GTest::gtest GTest::gtest_main)
add_test(NAME IntegrationTests COMMAND test_sse_server)

# Test 8: Activity Events Tests
add_executable(test_activity_events test_activity_events.cpp)
target_link_libraries(test_activity_events PRIVATE ag-ui GTest::gtest GTest::gtest_main)
add_test(NAME ActivityEventsTests COMMAND test_activity_events)

# Test 9: Event Verifier Tests
add_executable(test_event_verifier test_event_verifier.cpp)
target_link_libraries(test_event_verifier PRIVATE ag-ui GTest::gtest GTest::gtest_main)
add_test(NAME EventVerifierTests COMMAND test_event_verifier)

# Test 10: Event Parser Round-Trip Tests
add_executable(test_event_parser test_event_parser.cpp)
target_link_libraries(test_event_parser PRIVATE ag-ui GTest::gtest GTest::gtest_main)
add_test(NAME EventParserTests COMMAND test_event_parser)

# Test 11: AgentError Class Tests
add_executable(test_agent_error test_agent_error.cpp)
target_link_libraries(test_agent_error PRIVATE ag-ui GTest::gtest GTest::gtest_main)
add_test(NAME AgentErrorTests COMMAND test_agent_error)

set_tests_properties(EventParserTests PROPERTIES
    TIMEOUT 30
    LABELS "unit;event;parser"
)

set_tests_properties(AgentErrorTests PROPERTIES
    TIMEOUT 30
    LABELS "unit;error"
)

# Set test properties
set_tests_properties(EventHandlerTests PROPERTIES
    TIMEOUT 30
    LABELS "unit;event"
)

set_tests_properties(StateManagerTests PROPERTIES
    TIMEOUT 30
    LABELS "unit;state"
)

set_tests_properties(ApplyModuleTests PROPERTIES
    TIMEOUT 30
    LABELS "unit;apply"
)

set_tests_properties(SSEParserTests PROPERTIES
    TIMEOUT 30
    LABELS "unit;sse"
)

set_tests_properties(HttpAgentTests PROPERTIES
    TIMEOUT 30
    LABELS "unit;agent"
)

set_tests_properties(MiddlewareTests PROPERTIES
    TIMEOUT 30
    LABELS "unit;middleware"
)

set_tests_properties(IntegrationTests PROPERTIES
    TIMEOUT 60
    LABELS "integration;server"
)

set_tests_properties(ActivityEventsTests PROPERTIES
    TIMEOUT 30
    LABELS "unit;event;activity"
)

set_tests_properties(EventVerifierTests PROPERTIES
    TIMEOUT 30
    LABELS "unit;event;verifier"
)

# Print test information
message(STATUS "AG-UI Tests Configuration:")
message(STATUS "  test_event_handler: Event handler tests")
message(STATUS "  test_state_manager: State manager tests")
message(STATUS "  test_apply_module: Apply module tests")
message(STATUS "  test_sse_parser: SSE parser tests")
message(STATUS "  test_http_agent: HTTP Agent tests")
message(STATUS "  test_middleware: Middleware system tests")
message(STATUS "  test_sse_server: SSE server integration tests with Mock server")
message(STATUS "  test_activity_events: Activity events (ACTIVITY_SNAPSHOT/ACTIVITY_DELTA) tests")
message(STATUS "  test_event_verifier: Event sequence verifier tests")
message(STATUS "  test_event_parser: Event parser round-trip tests for all 27 event types")
message(STATUS "  test_agent_error: AgentError class unit tests")
