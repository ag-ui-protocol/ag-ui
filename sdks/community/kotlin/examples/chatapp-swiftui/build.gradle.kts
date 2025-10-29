buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.12.0")
    }
}

plugins {
    id("org.jetbrains.kotlinx.kover") version "0.7.6"

    kotlin("multiplatform") apply false
    kotlin("plugin.serialization") apply false
}

allprojects {
    repositories {
        google()
        mavenCentral()
        // Compose Multiplatform artifacts used by the shared module are hosted on JetBrains Space.
        // We still depend on the shared chat module for protocol logic, so keep the Compose repo.
        maven("https://maven.pkg.jetbrains.space/public/p/compose/dev")
        mavenLocal()
    }
}

koverReport {
    defaults {
        verify {
            onCheck = false
        }
    }
}

tasks.register("clean", Delete::class) {
    delete(rootProject.buildDir)
}
