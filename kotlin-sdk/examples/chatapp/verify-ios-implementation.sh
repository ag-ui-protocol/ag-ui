#!/bin/bash

echo "🔍 Verifying iOS Implementation..."
echo

# Check iOS App files
echo "📱 Checking iOS App files:"
files_to_check=(
    "iosApp/iosApp/iOSApp.swift"
    "iosApp/iosApp/ContentView.swift"
    "iosApp/iosApp/Info.plist"
    "iosApp/iosApp/Assets.xcassets/Contents.json"
    "iosApp/iosApp/Assets.xcassets/AppIcon.appiconset/Contents.json"
    "iosApp/iosApp.xcodeproj/project.pbxproj"
    "iosApp/README.md"
)

for file in "${files_to_check[@]}"; do
    if [ -f "$file" ]; then
        echo "✅ $file"
    else
        echo "❌ $file (missing)"
    fi
done

echo

# Check shared module iOS support
echo "🔄 Checking shared module iOS support:"
shared_files=(
    "shared/src/iosMain/kotlin/com/agui/example/chatapp/util/IosPlatform.kt"
    "shared/src/iosMain/kotlin/com/agui/example/chatapp/util/MainViewController.kt"
    "shared/src/iosTest/kotlin/com/agui/example/chatapp/IosPlatformTest.kt"
)

for file in "${shared_files[@]}"; do
    if [ -f "$file" ]; then
        echo "✅ $file"
    else
        echo "❌ $file (missing)"
    fi
done

echo

# Check tools module iOS support
echo "🛠️ Checking tools module iOS support:"
tools_files=(
    "../tools/src/iosMain/kotlin/com/agui/example/tools/IosLocationProvider.kt"
    "../tools/src/iosTest/kotlin/com/agui/example/tools/IosLocationProviderTest.kt"
)

for file in "${tools_files[@]}"; do
    if [ -f "$file" ]; then
        echo "✅ $file"
    else
        echo "❌ $file (missing)"
    fi
done

echo

# Check build configurations
echo "⚙️ Checking build configurations:"
echo -n "iOS targets in shared/build.gradle.kts: "
if grep -q "iosX64()" shared/build.gradle.kts; then
    echo "✅ Enabled"
else
    echo "❌ Not found"
fi

echo -n "iOS targets in tools/build.gradle.kts: "
if grep -q "iosX64()" ../tools/build.gradle.kts; then
    echo "✅ Enabled"
else
    echo "❌ Not found"
fi

echo
echo "🎉 iOS implementation verification complete!"
echo
echo "To build and test:"
echo "1. Open iosApp/iosApp.xcodeproj in Xcode"
echo "2. Build the shared framework: ./gradlew :shared:embedAndSignAppleFrameworkForXcode"
echo "3. Run the iOS app in Xcode or simulator"