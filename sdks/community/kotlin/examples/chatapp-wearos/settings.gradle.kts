rootProject.name = "chatapp-wearos"

include(":wearApp")
include(":chatapp-shared")
project(":chatapp-shared").projectDir = file("../chatapp-shared")

// Include local library for development (using local modules with new Activity types)
includeBuild("../../library") {
    dependencySubstitution {
        substitute(module("com.agui:kotlin-core")).using(project(":kotlin-core"))
        substitute(module("com.agui:kotlin-client")).using(project(":kotlin-client"))
        substitute(module("com.agui:kotlin-tools")).using(project(":kotlin-tools"))
        substitute(module("com.ag-ui.community:kotlin-a2ui")).using(project(":kotlin-a2ui"))
    }
}

pluginManagement {
    repositories {
        google()
        gradlePluginPortal()
        mavenCentral()
        maven("https://maven.pkg.jetbrains.space/public/p/compose/dev")
        mavenLocal()
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
