plugins {
    kotlin("multiplatform")
    kotlin("plugin.serialization")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.compose")
    id("com.android.library")
    id("maven-publish")
    id("signing")
}

// Group and version inherited from parent build.gradle.kts

repositories {
    google()
    mavenCentral()
}

kotlin {
    // Configure K2 compiler options
    targets.configureEach {
        compilations.configureEach {
            compileTaskProvider.configure {
                compilerOptions {
                    freeCompilerArgs.add("-Xexpect-actual-classes")
                    freeCompilerArgs.add("-opt-in=kotlin.RequiresOptIn")
                    freeCompilerArgs.add("-opt-in=kotlinx.coroutines.ExperimentalCoroutinesApi")
                    freeCompilerArgs.add("-opt-in=kotlinx.serialization.ExperimentalSerializationApi")
                    languageVersion.set(org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_2_2)
                    apiVersion.set(org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_2_2)
                }
            }
        }
    }

    // Android target
    androidTarget {
        compilations.all {
            compileTaskProvider.configure {
                compilerOptions {
                    jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21)
                }
            }
        }
        publishLibraryVariants("release")
    }

    // JVM target (Desktop)
    jvm {
        compilations.all {
            compileTaskProvider.configure {
                compilerOptions {
                    jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21)
                }
            }
        }
        testRuns["test"].executionTask.configure {
            useJUnitPlatform()
        }
    }

    // iOS targets
    iosX64()
    iosArm64()
    iosSimulatorArm64()

    sourceSets {
        val commonMain by getting {
            dependencies {
                // Compose Multiplatform
                implementation(compose.runtime)
                implementation(compose.foundation)
                implementation(compose.material3)
                implementation(compose.ui)

                // Kotlinx libraries
                implementation(libs.kotlinx.serialization.json)
                implementation(libs.kotlinx.datetime)
                implementation(libs.kotlinx.coroutines.core)

                // Image loading (Coil 3)
                implementation(libs.coil.compose)
                implementation(libs.coil.network.ktor3)

                // Logging
                implementation(libs.kermit)
            }
        }

        val commonTest by getting {
            dependencies {
                implementation(kotlin("test"))
                implementation(libs.kotlinx.coroutines.test)
            }
        }

        val androidMain by getting {
            dependencies {
                implementation(libs.androidx.activity.compose)
            }
        }

        val iosX64Main by getting
        val iosArm64Main by getting
        val iosSimulatorArm64Main by getting
        val iosMain by creating {
            dependsOn(commonMain)
            iosX64Main.dependsOn(this)
            iosArm64Main.dependsOn(this)
            iosSimulatorArm64Main.dependsOn(this)
        }

        val jvmMain by getting {
            dependencies {
                implementation(compose.desktop.currentOs)
            }
        }
    }
}

android {
    namespace = "com.agui.a2ui"
    compileSdk = 36

    defaultConfig {
        minSdk = 26
    }

    testOptions {
        targetSdk = 36
    }

    buildToolsVersion = "36.0.0"

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }

    buildFeatures {
        compose = true
    }
}

// Publishing configuration
publishing {
    publications {
        withType<MavenPublication> {
            version = project.version.toString()
            pom {
                name.set("kotlin-a2ui")
                description.set("A2UI component rendering for Compose Multiplatform - Agent User Interaction Protocol")
                url.set("https://github.com/ag-ui-protocol/ag-ui")

                licenses {
                    license {
                        name.set("MIT License")
                        url.set("https://opensource.org/licenses/MIT")
                    }
                }

                developers {
                    developer {
                        id.set("contextablemark")
                        name.set("Mark Fogle")
                        email.set("mark@contextable.com")
                    }
                }

                scm {
                    url.set("https://github.com/ag-ui-protocol/ag-ui")
                    connection.set("scm:git:git://github.com/ag-ui-protocol/ag-ui.git")
                    developerConnection.set("scm:git:ssh://github.com:ag-ui-protocol/ag-ui.git")
                }
            }
        }
    }
}

// Signing configuration
signing {
    val signingKey: String? by project
    val signingPassword: String? by project

    if (signingKey != null && signingPassword != null) {
        useInMemoryPgpKeys(signingKey, signingPassword)
        sign(publishing.publications)
    }
}

tasks.withType<Test> {
    useJUnitPlatform()
}
