import com.android.build.gradle.LibraryExtension

plugins {
    kotlin("multiplatform")
    kotlin("plugin.serialization")
}

val androidEnabled = providers.gradleProperty("agui.enableAndroid")
    .map(String::toBoolean)
    .orElse(true)
    .get()

if (androidEnabled) {
    pluginManager.apply("com.android.library")
}

kotlin {
    jvmToolchain(21)

    if (androidEnabled) {
        androidTarget {
            compilations.all {
                compileTaskProvider.configure {
                    compilerOptions {
                        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21)
                    }
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

    iosX64()
    iosArm64()
    iosSimulatorArm64()

    sourceSets {
        val commonMain by getting {
            dependencies {
                implementation(libs.agui.client)
                implementation(libs.a2ui4k)
                implementation(libs.kotlinx.coroutines.core)
                implementation("org.jetbrains.kotlinx:atomicfu:0.23.2")
                implementation(libs.kotlinx.serialization.json)
                api(libs.multiplatform.settings)
                api(libs.multiplatform.settings.coroutines)
                implementation("co.touchlab:kermit:2.0.6")
                implementation(libs.kotlinx.datetime)
                implementation(libs.okio)
                // Ktor client for clawg-ui pairing
                implementation(libs.ktor.client.core)
                implementation(libs.ktor.client.content.negotiation)
                implementation(libs.ktor.serialization.kotlinx.json)
            }
        }

        val commonTest by getting {
            dependencies {
                implementation(kotlin("test"))
                implementation(libs.kotlinx.coroutines.test)
                implementation(libs.ktor.client.mock)
            }
        }

        if (androidEnabled) {
            val androidMain by getting {
                dependencies {
                    implementation(libs.ktor.client.android)
                    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
                }
            }

            val androidUnitTest by getting {
                dependencies {
                    implementation(kotlin("test"))
                    implementation(libs.junit)
                }
            }
        }

        val desktopMain by getting {
            dependencies {
                implementation(libs.ktor.client.java)
                implementation("org.jetbrains.kotlinx:kotlinx-coroutines-swing:1.10.2")
            }
        }

        val desktopTest by getting

        val iosMain by creating {
            dependsOn(commonMain)
            dependencies {
                implementation(libs.ktor.client.darwin)
            }
            val iosX64Main by getting
            val iosArm64Main by getting
            val iosSimulatorArm64Main by getting
            iosX64Main.dependsOn(this)
            iosArm64Main.dependsOn(this)
            iosSimulatorArm64Main.dependsOn(this)
        }

        val iosTest by creating {
            dependsOn(commonTest)
            val iosX64Test by getting
            val iosArm64Test by getting
            val iosSimulatorArm64Test by getting
            iosX64Test.dependsOn(this)
            iosArm64Test.dependsOn(this)
            iosSimulatorArm64Test.dependsOn(this)
        }
    }
}

pluginManager.withPlugin("com.android.library") {
    extensions.configure<LibraryExtension>("android") {
        namespace = "com.agui.example.chatapp.shared"
        compileSdk = 36

        defaultConfig {
            minSdk = 26
            testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        }

        compileOptions {
            sourceCompatibility = JavaVersion.VERSION_21
            targetCompatibility = JavaVersion.VERSION_21
        }
    }
}

