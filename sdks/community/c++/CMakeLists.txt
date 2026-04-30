cmake_minimum_required(VERSION 3.10)
project(ag-ui-cpp VERSION 1.0.0 LANGUAGES CXX)

# Set C++ standard
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Set default build type to Debug for better debugging experience
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Debug CACHE STRING "Choose the type of build (Debug or Release)" FORCE)
endif()

# Add debug symbols
if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    if(MSVC)
        add_compile_options(/Zi /Od)
    else()
        add_compile_options(-g -O0)
    endif()
    message(STATUS "Building in Debug mode with debug symbols")
endif()

# Compiler options
if(MSVC)
    add_compile_options(/W4)
else()
    add_compile_options(-Wall -Wextra -Wpedantic -Wno-unused-parameter)
endif()

# Find dependencies
find_package(nlohmann_json 3.2.0 REQUIRED)
find_package(PkgConfig REQUIRED)
pkg_check_modules(CURL REQUIRED libcurl)

# Source files
set(AG_UI_SOURCES
    src/core/error.cpp
    src/core/event.cpp
    src/core/event_verifier.cpp
    src/core/logger.cpp
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
    src/core/event_verifier.h
    src/core/logger.h
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

# Find thread library (must come before target_link_libraries)
find_package(Threads REQUIRED)

# Link dependencies
target_link_libraries(ag-ui
    PUBLIC
        nlohmann_json::nlohmann_json
    PRIVATE
        Threads::Threads
        ${CURL_LIBRARIES}
)

# Include curl headers
target_include_directories(ag-ui PRIVATE ${CURL_INCLUDE_DIRS})

# Set curl compile options
target_compile_options(ag-ui PRIVATE ${CURL_CFLAGS_OTHER})

# Set library properties (SOVERSION omitted: not applicable for static libraries)
set_target_properties(ag-ui PROPERTIES
    VERSION ${PROJECT_VERSION}
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
    
    # Find Google Test (required for building tests)
    find_package(GTest REQUIRED)
    
    add_subdirectory(tests)
endif()

# Install rules
include(GNUInstallDirs)

install(TARGETS ag-ui
    EXPORT ag-ui-targets
    LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
    ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
    RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
)

# Install headers preserving subdirectory structure so that #include "core/event.h" etc. remain valid
install(DIRECTORY src/
    DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/ag-ui
    FILES_MATCHING PATTERN "*.h"
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

# Print configuration
message(STATUS "AG-UI C++ SDK Configuration:")
message(STATUS "  Version: ${PROJECT_VERSION}")
message(STATUS "  C++ Standard: ${CMAKE_CXX_STANDARD}")
message(STATUS "  Build Examples: ${BUILD_EXAMPLES}")
message(STATUS "  Build Tests: ${BUILD_TESTS}")
message(STATUS "  Install Prefix: ${CMAKE_INSTALL_PREFIX}")

