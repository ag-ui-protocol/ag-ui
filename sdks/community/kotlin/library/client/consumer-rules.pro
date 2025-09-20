# Keep Ktor Android engine classes
-keep class io.ktor.client.engine.android.** { *; }
-keep class io.ktor.client.plugins.sse.** { *; }

# Keep platform-specific HttpClient factory implementations
-keep class com.agui.client.agent.HttpClientFactoryKt { *; }
-keep class com.agui.client.agent.** { *; }

# Keep all classes that have expect/actual implementations
-keepclassmembers class * {
    ** createPlatformHttpClient(...);
}