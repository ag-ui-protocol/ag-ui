#!/bin/bash

# Script to run Dart SDK integration tests
# Usage: ./scripts/run_integration_tests.sh [docker|python|all]

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"

cd "$PROJECT_ROOT"

MODE="${1:-docker}"

echo "========================================="
echo "AG-UI Dart SDK Integration Tests"
echo "========================================="
echo ""

case "$MODE" in
  docker)
    echo "Running Docker-based integration tests..."
    echo "-----------------------------------------"
    dart test test/integration/simple_qa_docker_test.dart --reporter=expanded
    ;;
    
  python)
    echo "Running Python server integration tests..."
    echo "-----------------------------------------"
    dart test test/integration/simple_qa_test.dart test/integration/tool_generative_ui_test.dart --reporter=expanded
    ;;
    
  fixtures)
    echo "Running fixture integration tests..."
    echo "-----------------------------------------"
    dart test test/integration/fixtures_integration_test.dart test/integration/event_decoding_integration_test.dart --reporter=expanded
    ;;
    
  all)
    echo "Running all integration tests..."
    echo "-----------------------------------------"
    dart test test/integration/ --reporter=expanded
    ;;
    
  unit)
    echo "Running unit tests only..."
    echo "-----------------------------------------"
    dart test test/client/ test/encoder/ test/sse/ test/types/ test/events/ --reporter=compact
    ;;
    
  *)
    echo "Usage: $0 [docker|python|fixtures|all|unit]"
    echo ""
    echo "Options:"
    echo "  docker   - Run Docker-based integration tests (default)"
    echo "  python   - Run Python server integration tests"
    echo "  fixtures - Run fixture-based integration tests"
    echo "  all      - Run all integration tests"
    echo "  unit     - Run unit tests only"
    exit 1
    ;;
esac

echo ""
echo "========================================="
echo "Test run complete"
echo "========================================="