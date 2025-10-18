rootProject.name = "agui-kotlin-sdk-example-chatapp"

include(":shared")
include(":androidApp")
include(":desktopApp")

// Include example tools module
include(":tools")
project(":tools").projectDir = file("../tools")

// Library modules will be pulled from Maven instead of local build

pluginManagement {
    repositories {
        google()
        gradlePluginPortal()
        mavenCentral()
        maven("https://maven.pkg.jetbrains.space/public/p/compose/dev")
    }

    plugins {
        val kotlinVersion = "2.1.21"
        val composeVersion = "1.7.3"
        val agpVersion = "8.10.1"

        kotlin("multiplatform") version kotlinVersion
        kotlin("android") version kotlinVersion
        kotlin("plugin.serialization") version kotlinVersion
        kotlin("plugin.compose") version kotlinVersion
        id("org.jetbrains.compose") version composeVersion
        id("com.android.application") version agpVersion
        id("com.android.library") version agpVersion

        // Ensure test plugins use same version
        kotlin("test") version kotlinVersion
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        maven("https://maven.pkg.jetbrains.space/public/p/compose/dev")
        mavenLocal()
    }
}