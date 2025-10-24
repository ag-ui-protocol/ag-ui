plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.agui.example.chatwear"
    compileSdk = 36

    val defaultAgentUrl = (project.findProperty("chatapp.wear.defaultAgentUrl") as? String).orEmpty()
    val defaultAgentName = (project.findProperty("chatapp.wear.defaultAgentName") as? String).orEmpty()
    val defaultAgentDescription = (project.findProperty("chatapp.wear.defaultAgentDescription") as? String).orEmpty()
    val defaultAgentApiKey = (project.findProperty("chatapp.wear.defaultAgentApiKey") as? String).orEmpty()
    val defaultAgentApiKeyHeader = (project.findProperty("chatapp.wear.defaultAgentApiKeyHeader") as? String).orEmpty()
    val defaultQuickPrompts = (project.findProperty("chatapp.wear.quickPrompts") as? String)
        ?: "Hello there|Summarize the latest updates|Show a fun fact"

    fun String.escapeForBuildConfig(): String =
        this.replace("\\", "\\\\")
            .replace("\"", "\\\"")

    defaultConfig {
        applicationId = "com.agui.example.chatwear"
        minSdk = 30
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"

        buildConfigField("String", "DEFAULT_AGENT_URL", "\"${defaultAgentUrl.escapeForBuildConfig()}\"")
        buildConfigField("String", "DEFAULT_AGENT_NAME", "\"${defaultAgentName.escapeForBuildConfig()}\"")
        buildConfigField("String", "DEFAULT_AGENT_DESCRIPTION", "\"${defaultAgentDescription.escapeForBuildConfig()}\"")
        buildConfigField("String", "DEFAULT_AGENT_API_KEY", "\"${defaultAgentApiKey.escapeForBuildConfig()}\"")
        buildConfigField("String", "DEFAULT_AGENT_API_KEY_HEADER", "\"${defaultAgentApiKeyHeader.escapeForBuildConfig()}\"")
        buildConfigField("String", "DEFAULT_QUICK_PROMPTS", "\"${defaultQuickPrompts.escapeForBuildConfig()}\"")
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.15"
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

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
}

kotlin {
    jvmToolchain(21)
}

dependencies {
    implementation(project(":chatapp-shared"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.runtime)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.text)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.ui.util)
    implementation(libs.androidx.core.ktx)

    implementation(libs.wear.compose.foundation)
    implementation(libs.wear.compose.material)
    implementation(libs.wear.compose.material3)
    implementation(libs.wear.compose.navigation)
    implementation(libs.markdown.renderer.m3)

    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.tooling.preview)
}
