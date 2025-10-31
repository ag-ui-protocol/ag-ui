rootProject.name = "agui-kotlin-sdk-example-chatapp"

include(":shared")
include(":androidApp")
include(":desktopApp")

include(":chatapp-shared")
project(":chatapp-shared").projectDir = file("../chatapp-shared")

// Library modules will be pulled from Maven instead of local build

pluginManagement {
    repositories {
        google()
        gradlePluginPortal()
        mavenCentral()
        maven("https://maven.pkg.jetbrains.space/public/p/compose/dev")
    }

    plugins {
        val kotlinVersion = "2.2.20"
        val composeVersion = "1.9.0-rc02"
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
