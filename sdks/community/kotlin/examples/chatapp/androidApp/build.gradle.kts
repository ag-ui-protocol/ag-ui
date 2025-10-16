plugins {
    id("com.android.application")
    kotlin("android")
    kotlin("plugin.compose")  // Add this line
}

android {
    namespace = "com.agui.example.client.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.agui.example.client.android"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }

    buildFeatures {
        compose = true
    }

    composeOptions {
        kotlinCompilerExtensionVersion = "1.6.21"
    }

    packagingOptions {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
}

kotlin {
    jvmToolchain(21)
}

dependencies {
    implementation(project(":shared"))
}

//// Force Android configurations to use Android-specific Ktor dependencies
//configurations.all {
//    resolutionStrategy {
//        eachDependency {
//            if (requested.group == "io.ktor" && requested.name.endsWith("-jvm")) {
//                // For Ktor 3.x, the Android artifacts don't have special names
//                // We just need to exclude the JVM artifacts
//                useTarget("${requested.group}:${requested.name.removeSuffix("-jvm")}:${requested.version}")
//                because("Remove JVM suffix for Android configurations")
//            }
//        }
//    }
//}