#!/bin/bash

# ag-ui-4k Build Helper Script
# This script helps run builds from the library directory

echo "ag-ui-4k Build Helper"
echo "====================="
echo ""
echo "Navigating to library directory..."
cd library || exit 1

echo "Running Gradle build..."
./gradlew "$@"