# Changelog

All notable changes to the AG-UI-4K Chat App example will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Complete iOS implementation** of the chat app with feature parity to Android and Desktop versions
- iOS app structure with SwiftUI wrapper for Compose Multiplatform UI
- iOS-specific platform implementations:
  - `IosPlatform.kt` with NSUserDefaults-based settings storage
  - `MainViewController.kt` as the iOS app entry point using ComposeUIViewController
- iOS source set configuration with proper dependency hierarchy
- iOS-specific tests:
  - `IosSettingsTest.kt` for NSUserDefaults persistence testing
  - `IosUserIdManagerTest.kt` for iOS-specific UserIdManager functionality
- iOS app project (`iosApp/`) with:
  - Xcode project configuration
  - SwiftUI ContentView wrapping Kotlin Multiplatform UI
  - iOS 15.0+ deployment target
  - Framework integration with shared Kotlin code

### Changed
- **Replaced JVM-specific threading constructs** with Kotlin Multiplatform alternatives:
  - Replaced `@Volatile` and `synchronized` with `kotlinx.atomicfu.atomic` for thread-safe singletons
  - Updated `UserIdManager` and `AgentRepository` to use atomic operations
- **Fixed multiplatform compatibility issues**:
  - Replaced `String.format()` with multiplatform-compatible string formatting in file size utility
  - Removed `@TestOnly` annotation not available on iOS platforms
- **Enhanced ID generation** in `AgentConfig.generateId()` with random component to prevent duplicate IDs
- **Updated iOS deployment target** from 14.1 to 15.0 to match framework requirements
- **Improved string formatting** in `Extensions.kt` for cross-platform compatibility
- **Upgraded dependencies**:
  - Gradle wrapper upgraded to 8.14
  - Kotlin plugin upgraded to 2.2.0
- **Enhanced build configuration**:
  - Added `org.gradle.console=plain` to reduce console formatting errors
  - Fixed Gradle wrapper missing files
  - Configured iOS source set hierarchy with proper target dependencies

### Fixed
- **Xcode build script path issues** - corrected gradlew path resolution in iOS build phases
- **Java runtime detection** - resolved JDK path issues in Xcode build environment  
- **Threading compatibility** - eliminated JVM-specific concurrency constructs
- **Source set conflicts** - resolved duplicate platform implementations
- **Framework linking** - fixed Swift code integration with Kotlin framework
- **Build tool integration** - ensured proper Java/Gradle integration in Xcode environment

### Technical Details
- **Kotlin Multiplatform**: All three platforms (Android, Desktop, iOS) now share common business logic
- **Compose Multiplatform**: Unified UI framework across all platforms
- **Platform-specific storage**: 
  - Android: SharedPreferences
  - Desktop: Java Preferences  
  - iOS: NSUserDefaults
- **Authentication**: Cross-platform auth provider system with API Key, Bearer Token, and Basic Auth support
- **Testing**: Comprehensive test suite covering all platforms with platform-specific test implementations

### Platform Support
- ✅ Android (API 26+)
- ✅ Desktop/JVM (Java 21+)
- ✅ iOS (15.0+) - **NEW**

### Developer Experience
- Complete iOS development workflow documentation
- Xcode project ready for iOS development
- Cross-platform testing suite
- Unified build system supporting all platforms