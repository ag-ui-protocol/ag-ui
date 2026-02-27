# AG-UI C++ SDK Test Configuration

# Test 3: SSE Parser Tests
add_executable(test_sse_parser test_sse_parser.cpp)
target_link_libraries(test_sse_parser PRIVATE ag-ui)
add_test(NAME SSEParserTests COMMAND test_sse_parser)

# Test 5: HttpAgent Tests
add_executable(test_http_agent test_http_agent.cpp)
target_link_libraries(test_http_agent PRIVATE ag-ui)
add_test(NAME HttpAgentTests COMMAND test_http_agent)

# Test 6: Middleware System Tests
add_executable(test_middleware test_middleware.cpp)
target_link_libraries(test_middleware PRIVATE ag-ui)
add_test(NAME MiddlewareTests COMMAND test_middleware)

# Test 7: Integration Tests (requires Mock server)
add_executable(test_sse_server test_sse_server.cpp)
target_link_libraries(test_sse_server PRIVATE ag-ui)
add_test(NAME IntegrationTests COMMAND test_sse_server)

# Set test properties
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

# Print test information
message(STATUS "AG-UI Tests Configuration:")
message(STATUS "  test_basic: Basic functionality tests")
message(STATUS "  test_events: All 23 event types tests")
message(STATUS "  test_sse_parser: SSE parser tests")
message(STATUS "  test_http_client: HTTP client tests")
message(STATUS "  test_http_agent: HttpAgent tests")
message(STATUS "  test_middleware: Middleware system tests")
message(STATUS "  test_integration_with_server: Integration tests with Mock server")
