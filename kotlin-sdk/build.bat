@echo off

REM ag-ui-4k Build Helper Script
REM This script helps run builds from the library directory

echo ag-ui-4k Build Helper
echo =====================
echo.
echo Navigating to library directory...
cd library || exit /b 1

echo Running Gradle build...
gradlew.bat %*