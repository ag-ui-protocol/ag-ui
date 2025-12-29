plugins {
    kotlin("multiplatform")
    kotlin("plugin.serialization")
    kotlin("plugin.compose")
    id("com.android.library")
    id("org.jetbrains.compose")
}

kotlin {
    applyDefaultHierarchyTemplate()
    jvmToolchain(21)
    androidTarget {
        compilations.all {
            compileTaskProvider.configure {
                compilerOptions {
                    jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21)
                }
            }
        }
    }

    jvm("desktop") {
        compilations.all {
            compileTaskProvider.configure {
                compilerOptions {
                    jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21)
                }
            }
        }
    }
    listOf(
        iosX64(),
        iosArm64(),
        iosSimulatorArm64()
    ).forEach { iosTarget ->
        iosTarget.binaries.framework {
            baseName = "shared"
            isStatic = true
        }
    }

    sourceSets {
        val commonMain by getting {
            dependencies {
                implementation(compose.runtime)
                implementation(compose.foundation)
                implementation(compose.material3)
                implementation(compose.ui)
                implementation(compose.components.resources)
                implementation(compose.components.uiToolingPreview)
                implementation(compose.materialIconsExtended)

                implementation(project(":chatapp-shared"))

                // A2UI rendering
                implementation(libs.a2ui4k)

                // Coroutines
                implementation(libs.kotlinx.coroutines.core)

                // DateTime
                implementation(libs.kotlinx.datetime)

                // Markdown rendering
                implementation(libs.markdown.renderer.m3)
            }
        }

        val commonTest by getting {
            dependencies {
                implementation(kotlin("test"))
                implementation(libs.kotlinx.coroutines.test)
                implementation(libs.ktor.client.mock)  // Add this line
                implementation(project(":chatapp-shared"))
                implementation(libs.agui.tools)
                implementation(libs.agui.client)
                implementation(libs.agui.core)
            }
        }

        val androidMain by getting {
            dependencies {
                api(libs.activity.compose)
                api(libs.appcompat)
                api(libs.core.ktx)
                implementation(libs.androidx.compose.runtime)
                implementation(libs.androidx.compose.runtime.saveable)
                implementation(libs.androidx.compose.foundation)
                implementation(libs.androidx.compose.material)
                implementation(libs.androidx.compose.material3)
                implementation(libs.androidx.compose.ui)
                implementation(libs.androidx.compose.ui.tooling.preview)
                implementation(libs.ktor.client.android)
            }
        }

        val androidUnitTest by getting {
            dependencies {
                implementation(kotlin("test"))
                implementation(libs.junit)
            }
        }

        val androidInstrumentedTest by getting {
            dependencies {
                implementation(kotlin("test"))
                implementation(libs.runner)
                implementation(libs.ext.junit)
                implementation(libs.core)
                implementation(libs.ktor.client.android)

                // Fixed Compose testing dependencies with explicit versions
                implementation(libs.ui.test.junit4)
                implementation(libs.androidx.compose.ui.test.manifest)
                implementation(libs.activity.compose)
                implementation(libs.androidx.ui.tooling)
            }
        }

        val desktopMain by getting {
            dependencies {
                implementation(compose.desktop.currentOs)
                implementation("org.jetbrains.kotlinx:kotlinx-coroutines-swing:1.10.2")
                implementation(libs.ktor.client.java)
            }
        }

        val desktopTest by getting {
            dependencies {
                implementation(kotlin("test"))
            }
        }

        // Get the existing specific iOS targets
        val iosMain by getting
        val iosTest by getting
    }
}

android {
    namespace = "com.agui.example.client"
    compileSdk = 36

    sourceSets["main"].manifest.srcFile("src/androidMain/AndroidManifest.xml")
    sourceSets["main"].res.srcDirs("src/androidMain/res")
    sourceSets["main"].resources.srcDirs("src/commonMain/resources")

    defaultConfig {
        minSdk = 26
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    
    testOptions {
        targetSdk = 36
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
        }
    }

    testOptions {
        unitTests {
            isReturnDefaultValues = true
        }
        
        managedDevices {
            allDevices {
                // Create a pixel 8 API 34 device for testing
                create<com.android.build.api.dsl.ManagedVirtualDevice>("pixel8Api34") {
                    device = "Pixel 8"
                    apiLevel = 34
                    systemImageSource = "aosp"
                }
                
                // Create a pixel 6 API 33 device for broader compatibility testing
                create<com.android.build.api.dsl.ManagedVirtualDevice>("pixel6Api33") {
                    device = "Pixel 6"
                    apiLevel = 33
                    systemImageSource = "aosp"
                }
                
                // Create a tablet device for testing different form factors
                create<com.android.build.api.dsl.ManagedVirtualDevice>("pixel7TabletApi34") {
                    device = "Pixel Tablet"
                    apiLevel = 34
                    systemImageSource = "aosp"
                }
            }
            
            groups {
                create("phone") {
                    targetDevices.add(allDevices["pixel8Api34"])
                    targetDevices.add(allDevices["pixel6Api33"])
                }
                
                create("all") {
                    targetDevices.add(allDevices["pixel8Api34"])
                    targetDevices.add(allDevices["pixel6Api33"])
                    targetDevices.add(allDevices["pixel7TabletApi34"])
                }
            }
        }
    }
}

compose.resources {
    publicResClass = true
    packageOfResClass = "agui4kclient.shared.generated.resources"
    generateResClass = auto
}

// Force Android configurations to use Android-specific Ktor dependencies
//configurations.matching { it.name.contains("Android") }.all {
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
