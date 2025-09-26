rootProject.name = "tools"

// Enable version catalog
enableFeaturePreview("TYPESAFE_PROJECT_ACCESSORS")

pluginManagement {
    repositories {
        google()
        gradlePluginPortal()
        mavenCentral()
    }

    plugins {
        val kotlinVersion = "2.1.21"
        val agpVersion = "8.10.1"

        kotlin("multiplatform") version kotlinVersion
        kotlin("android") version kotlinVersion
        kotlin("plugin.serialization") version kotlinVersion
        id("com.android.library") version agpVersion

        // Ensure test plugins use same version
        kotlin("test") version kotlinVersion
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        mavenLocal()
    }
}