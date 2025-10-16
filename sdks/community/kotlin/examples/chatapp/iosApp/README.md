# iOS App for AG-UI Kotlin SDK Chat Client

This is the iOS implementation of the AG-UI Kotlin SDK chat client example.

## Requirements

- **Xcode 15.0 or later** (recommended)
- **iOS 14.1+ deployment target**
- **macOS with Apple Silicon or Intel processor**
- **JDK 21** (for building Kotlin framework)

## Quick Start

### 1. Open in Xcode

```bash
# From the chatapp directory
open iosApp/iosApp.xcodeproj
```

### 2. Select Simulator and Run

1. In Xcode, select a simulator from the device dropdown (e.g., **iPhone 16 Pro**)
2. Press **Cmd+R** or click the **Play** button (▶️)
3. Xcode will automatically build the Kotlin framework and launch the app

## Building and Running

### Method 1: Using Xcode (Recommended)

**Step-by-Step Instructions:**

1. **Open the Xcode project:**
   ```bash
   open iosApp/iosApp.xcodeproj
   ```

2. **Wait for project indexing** to complete (first time may take a few minutes)

3. **Select your target:**
   - Click the device/simulator dropdown next to the scheme
   - Choose an iOS simulator (e.g., iPhone 16 Pro, iPad Pro)
   - Or connect a physical iOS device

4. **Build and run:**
   - Press **Cmd+R** or click the **Play** button
   - First build will take longer as it compiles the Kotlin framework
   - The app will launch automatically

### Method 2: Command Line Build

```bash
# Build only (without running)
xcodebuild -project iosApp/iosApp.xcodeproj -scheme iosApp -sdk iphonesimulator build

# Build and run on specific simulator
xcodebuild -project iosApp/iosApp.xcodeproj \
  -scheme iosApp \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  build
```

### Method 3: iOS Device (Requires Apple Developer Account)

1. **Connect your iPhone/iPad** via USB or wireless
2. **Trust the computer** on your device when prompted
3. **Select your device** in Xcode's device dropdown
4. **Configure signing:**
   - Go to project settings → Signing & Capabilities
   - Select your development team
   - Ensure bundle identifier is unique
5. **Build and run** (Cmd+R)

## Available Simulators

Check available simulators:
```bash
xcrun simctl list devices available | grep iPhone
```

Common simulators for testing:
- **iPhone 16 Pro** - Latest iPhone with all features
- **iPhone SE (3rd generation)** - Smaller screen testing
- **iPad Pro 11-inch** - Tablet interface testing

## How the Build Process Works

### Automatic Framework Building

The Xcode project includes a **"Run Script" build phase** that automatically:

1. **Builds the Kotlin Multiplatform framework** before compiling Swift code
2. **Executes:** `./gradlew :shared:embedAndSignAppleFrameworkForXcode`
3. **Generates:** Framework files in `shared/build/xcode-frameworks/`
4. **Links:** The framework with the iOS app

### Manual Framework Building (if needed)

If automatic building fails, build manually:

```bash
# From the chatapp directory
./gradlew :shared:embedAndSignAppleFrameworkForXcode

# Or clean and rebuild
./gradlew clean :shared:embedAndSignAppleFrameworkForXcode
```

## Project Structure

```
iosApp/
├── iosApp.xcodeproj/          # Xcode project file
│   └── project.pbxproj        # Project configuration
├── iosApp/                    # iOS app source
│   ├── iOSApp.swift          # Main app entry point (@main)
│   ├── ContentView.swift     # SwiftUI wrapper for Compose
│   ├── Info.plist            # iOS app configuration
│   └── Assets.xcassets/      # App icons and resources
└── README.md                  # This file
```

### Key Files Explained

- **`iOSApp.swift`** - Swift app entry point, sets up the main window
- **`ContentView.swift`** - Wraps the Kotlin Compose UI in SwiftUI
- **`Info.plist`** - iOS app metadata, permissions, deployment target
- **`project.pbxproj`** - Xcode project configuration, build settings

## Features

### ✅ Available Features

- **Full AG-UI Protocol Support** - Connect to AI agents
- **Native iOS Interface** - SwiftUI + Compose Multiplatform
- **Real-time Chat** - Message streaming and responses
- **Multiple Agents** - Switch between different AI services
- **Authentication Support** - API keys, Bearer tokens, Basic auth
- **Location Tools** - iOS CoreLocation integration for location-based AI tools
- **Cross-platform Data** - Shared settings and chat history

### 🚀 iOS-Specific Enhancements

- **Native iOS keyboard** handling
- **iOS navigation patterns**
- **Support for iOS dark/light mode**
- **Native iOS sharing** (if implemented)
- **iOS notification support** (if needed)

## Testing

### Built-in Tests

Run tests for iOS implementation:

```bash
# Test iOS location provider
./gradlew :tools:iosSimulatorArm64Test

# Test iOS platform functions
./gradlew :shared:iosSimulatorArm64Test

# Test all platforms
./gradlew test
```

### Manual Testing Checklist

**Basic Functionality:**
- [ ] App launches without crashes
- [ ] Chat interface appears correctly
- [ ] Can type messages in chat input
- [ ] Settings screen accessible

**Agent Connection:**
- [ ] Can add new agent configurations
- [ ] Authentication methods work (API key, Bearer token)
- [ ] Can connect to agents and send messages
- [ ] Responses appear correctly in chat

**iOS-Specific:**
- [ ] Keyboard shows/hides properly
- [ ] App works in portrait and landscape
- [ ] Switching between apps works
- [ ] Memory usage is reasonable

**Location Tools (if available):**
- [ ] Location permission dialog appears
- [ ] Location tools work when permission granted
- [ ] Proper error handling when permission denied

## Troubleshooting

### Common Build Issues

**1. Kotlin Framework Build Fails**
```bash
# Clean and rebuild framework
./gradlew clean
./gradlew :shared:embedAndSignAppleFrameworkForXcode
```

**2. Xcode Build Errors**
- **Clean build folder:** Shift+Cmd+K in Xcode
- **Derive data:** Xcode → Preferences → Locations → Derived Data → Delete
- **Restart Xcode** and try again

**3. Code Signing Issues**
- Go to **project settings → Signing & Capabilities**
- Select your **development team**
- Use **automatic signing** for development
- Ensure **bundle identifier is unique**

**4. Simulator Issues**
```bash
# Reset simulator
xcrun simctl erase all

# List available simulators
xcrun simctl list devices available

# Boot specific simulator
xcrun simctl boot "iPhone 16 Pro"
```

**5. Missing Command Line Tools**
```bash
# Install/update Xcode command line tools
xcode-select --install

# Verify installation
xcode-select -p
```

### Performance Tips

**First Build Optimization:**
- First build takes 2-5 minutes (compiles Kotlin framework)
- Subsequent builds are much faster (incremental compilation)
- Keep Xcode open to maintain build cache

**Memory Management:**
- Close unused simulators to free memory
- Use "Debug" build configuration for development
- "Release" builds are optimized for distribution

## Location Features

### Location Permission Setup

The app includes iOS CoreLocation integration. To use location features:

1. **Location permission is automatically requested** when location tools are used
2. **Add location usage description** (already included in Info.plist):
   ```xml
   <key>NSLocationWhenInUseUsageDescription</key>
   <string>This app needs location access to provide location-based features to AI agents</string>
   ```

### Testing Location Features

**In Simulator:**
- Simulator → Features → Location → Custom Location
- Enter coordinates to test location functionality
- Try different accuracy settings

**On Device:**
- Grant location permission when prompted
- Test in different environments (indoor/outdoor)
- Verify accuracy levels work correctly

## Advanced Configuration

### Custom Bundle Identifier

Update in project settings if needed:
```
com.agui.example.chatapp
```

### iOS Deployment Target

Current: **iOS 14.1+**
- Supports most modern iOS devices
- Compatible with SwiftUI and Compose Multiplatform
- Can be lowered if needed (check compatibility)

### Build Configurations

- **Debug:** Development builds with debugging enabled
- **Release:** Optimized builds for distribution

## Support and Next Steps

### Development Workflow

1. **Make changes** in Kotlin shared code
2. **Build framework:** `./gradlew :shared:embedAndSignAppleFrameworkForXcode`
3. **Run in Xcode** to test changes
4. **Repeat** as needed

### Distribution

For **TestFlight** or **App Store** distribution:
1. Archive the app (Product → Archive)
2. Upload to App Store Connect
3. Configure app metadata and screenshots
4. Submit for review

### Getting Help

- **Xcode issues:** Check Xcode Console for detailed error messages
- **Kotlin/Multiplatform issues:** Check Gradle build output
- **iOS-specific questions:** Refer to Apple Developer documentation
- **AG-UI protocol questions:** Check the main project documentation