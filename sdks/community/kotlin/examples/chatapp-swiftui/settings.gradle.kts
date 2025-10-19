rootProject.name = "chatapp-swiftui"

include(":chatapp-shared")
project(":chatapp-shared").projectDir = File(rootDir, "../chatapp-shared")

include(":shared")
project(":shared").projectDir = File(rootDir, "shared")

pluginManagement {
    repositories {
        google()
        gradlePluginPortal()
        mavenCentral()
        // Compose Multiplatform plugin + artifacts for the shared chat module live here.
        maven("https://maven.pkg.jetbrains.space/public/p/compose/dev")
    }

    plugins {
        val kotlinVersion = "2.2.20"
        val composeVersion = "1.9.0-rc02"
        val agpVersion = "8.12.0"

        kotlin("multiplatform") version kotlinVersion
        kotlin("plugin.serialization") version kotlinVersion
        kotlin("plugin.compose") version kotlinVersion
        kotlin("android") version kotlinVersion
        id("org.jetbrains.compose") version composeVersion
        id("com.android.application") version agpVersion
        id("com.android.library") version agpVersion
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        // Compose runtime/material artifacts required by the shared chat module.
        maven("https://maven.pkg.jetbrains.space/public/p/compose/dev")
        mavenLocal()
    }
}
