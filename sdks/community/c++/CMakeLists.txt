cmake_minimum_required(VERSION 3.10)
project(ag-ui-cpp VERSION 1.0.0 LANGUAGES CXX)

# Set C++ standard
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Compiler options
if(MSVC)
    add_compile_options(/W4)
else()
    add_compile_options(-Wall -Wextra -Wpedantic -Wno-unused-parameter -Wno-unused-variable)
endif()

# Find dependencies
find_package(nlohmann_json 3.2.0 REQUIRED)
find_package(PkgConfig REQUIRED)
pkg_check_modules(CURL REQUIRED libcurl)

# Source files
set(AG_UI_SOURCES
    src/core/error.cpp
    src/core/event.cpp
    src/core/state.cpp
    src/core/subscriber.cpp
    src/core/session_types.cpp
    src/core/uuid.cpp
    src/middleware/middleware.cpp
    src/http/http_service.cpp
    src/stream/sse_parser.cpp
    src/agent/http_agent.cpp
    src/apply/apply.cpp
)

# Header files
set(AG_UI_HEADERS
    src/core/error.h
    src/core/event.h
    src/core/state.h
    src/core/subscriber.h
    src/core/session_types.h
    src/core/uuid.h
    src/middleware/middleware.h
    src/http/http_service.h
    src/stream/sse_parser.h
    src/agent/agent.h
    src/agent/http_agent.h
    src/apply/apply.h
)

# Create library
add_library(ag-ui STATIC ${AG_UI_SOURCES} ${AG_UI_HEADERS})

# Set include directories
target_include_directories(ag-ui
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/src>
        $<INSTALL_INTERFACE:include>
)

# Link dependencies
target_link_libraries(ag-ui
    PUBLIC
        nlohmann_json::nlohmann_json
    PRIVATE
        ${CMAKE_THREAD_LIBS_INIT}
        ${CURL_LIBRARIES}
)

# Include curl headers
target_include_directories(ag-ui PRIVATE ${CURL_INCLUDE_DIRS})

# Set curl compile options
target_compile_options(ag-ui PRIVATE ${CURL_CFLAGS_OTHER})

# Find thread library
find_package(Threads REQUIRED)
target_link_libraries(ag-ui PRIVATE Threads::Threads)

# Set library properties
set_target_properties(ag-ui PROPERTIES
    VERSION ${PROJECT_VERSION}
    SOVERSION 1
    PUBLIC_HEADER "${AG_UI_HEADERS}"
)

# Optional: Build examples
option(BUILD_EXAMPLES "Build example programs" OFF)
if(BUILD_EXAMPLES AND EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/examples")
    add_subdirectory(examples)
endif()

# Optional: Build tests
option(BUILD_TESTS "Build test programs" OFF)
if(BUILD_TESTS AND EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/tests")
    enable_testing()
    add_subdirectory(tests)
endif()

# Install rules
include(GNUInstallDirs)

install(TARGETS ag-ui
    EXPORT ag-ui-targets
    LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
    ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
    RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
    PUBLIC_HEADER DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/ag-ui
)

install(EXPORT ag-ui-targets
    FILE ag-ui-targets.cmake
    NAMESPACE ag-ui::
    DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/ag-ui
)

# Generate config files
include(CMakePackageConfigHelpers)

if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/cmake/ag-ui-config.cmake.in")
    configure_package_config_file(
        ${CMAKE_CURRENT_SOURCE_DIR}/cmake/ag-ui-config.cmake.in
        ${CMAKE_CURRENT_BINARY_DIR}/ag-ui-config.cmake
        INSTALL_DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/ag-ui
    )

    write_basic_package_version_file(
        ${CMAKE_CURRENT_BINARY_DIR}/ag-ui-config-version.cmake
        VERSION ${PROJECT_VERSION}
        COMPATIBILITY SameMajorVersion
    )

    install(FILES
        ${CMAKE_CURRENT_BINARY_DIR}/ag-ui-config.cmake
        ${CMAKE_CURRENT_BINARY_DIR}/ag-ui-config-version.cmake
        DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/ag-ui
    )
endif()

# VSCode test program
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/vscode_test.cpp")
    add_executable(vscode_test vscode_test.cpp)
    target_link_libraries(vscode_test PRIVATE ag-ui)
    message(STATUS "  VSCode Test: Enabled")
endif()

# Print configuration
message(STATUS "AG-UI C++ SDK Configuration:")
message(STATUS "  Version: ${PROJECT_VERSION}")
message(STATUS "  C++ Standard: ${CMAKE_CXX_STANDARD}")
message(STATUS "  Build Examples: ${BUILD_EXAMPLES}")
message(STATUS "  Build Tests: ${BUILD_TESTS}")
message(STATUS "  Install Prefix: ${CMAKE_INSTALL_PREFIX}")

