rootProject.name = "agui-kotlin-sdk-example-chatapp"

include(":shared")
include(":androidApp")
include(":desktopApp")

include(":chatapp-shared")
project(":chatapp-shared").projectDir = file("../chatapp-shared")

// Include local library for development (using local modules with new Activity types)
includeBuild("../../library") {
    dependencySubstitution {
        substitute(module("com.agui:kotlin-core")).using(project(":kotlin-core"))
        substitute(module("com.agui:kotlin-client")).using(project(":kotlin-client"))
        substitute(module("com.agui:kotlin-tools")).using(project(":kotlin-tools"))
    }
}

pluginManagement {
    repositories {
        google()
        gradlePluginPortal()
        mavenCentral()
        maven("https://maven.pkg.jetbrains.space/public/p/compose/dev")
    }

    plugins {
        val kotlinVersion = "2.2.20"
        val composeVersion = "1.9.3"
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
