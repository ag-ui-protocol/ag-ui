#!/bin/bash

# Script to run all Python tests
# This script will execute all test_*.py files using pytest

echo "Running all Python tests..."
echo "=========================="

# Get all test files
test_files=$(ls test_*.py 2>/dev/null)

if [ -z "$test_files" ]; then
    echo "No test files found (test_*.py pattern)"
    exit 1
fi

# Count total test files
total_tests=$(echo "$test_files" | wc -l)
echo "Found $total_tests test files"
echo

# Run all tests at once (recommended approach)
echo "Running all tests together:"
pytest test_*.py -v

echo
echo "=========================="
echo "All tests completed!"

# Alternative: Run each test file individually (uncomment if needed)
# echo
# echo "Running tests individually:"
# echo "=========================="
# 
# current=1
# for test_file in $test_files; do
#     echo "[$current/$total_tests] Running $test_file..."
#     pytest "$test_file" -v
#     echo
#     ((current++))
# done