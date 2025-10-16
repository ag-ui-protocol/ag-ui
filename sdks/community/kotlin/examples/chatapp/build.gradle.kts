plugins {
    id("org.jetbrains.kotlinx.kover") version "0.7.6"
    
    // Centralize plugin declarations with 'apply false'
    kotlin("multiplatform") apply false
    kotlin("android") apply false
    kotlin("plugin.serialization") apply false
    kotlin("plugin.compose") apply false
    id("org.jetbrains.compose") apply false
    id("com.android.application") apply false
    id("com.android.library") apply false
}

allprojects {
    repositories {
        google()
        mavenCentral()
        maven("https://maven.pkg.jetbrains.space/public/p/compose/dev")
        mavenLocal() // For local ag-ui-4k library development
    }
    
//    // Force Android configurations to use Android-specific Ktor dependencies across all projects
//    configurations.matching { it.name.contains("Android") }.all {
//        resolutionStrategy {
//            eachDependency {
//                if (requested.group == "io.ktor" && requested.name.endsWith("-jvm")) {
//                    // For Ktor 3.x, the Android artifacts don't have special names
//                    // We just need to exclude the JVM artifacts
//                    useTarget("${requested.group}:${requested.name.removeSuffix("-jvm")}:${requested.version}")
//                    because("Remove JVM suffix for Android configurations")
//                }
//            }
//        }
//    }
}

koverReport {
    defaults {
        verify {
            onCheck = true
            rule {
                isEnabled = true
                entity = kotlinx.kover.gradle.plugin.dsl.GroupingEntityType.APPLICATION
                bound {
                    minValue = 70
                    metric = kotlinx.kover.gradle.plugin.dsl.MetricType.LINE
                    aggregation = kotlinx.kover.gradle.plugin.dsl.AggregationType.COVERED_PERCENTAGE
                }
            }
        }
    }
}

tasks.register("clean", Delete::class) {
    delete(rootProject.buildDir)
}