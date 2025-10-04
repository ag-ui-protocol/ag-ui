# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.

# Keep Kotlin serialization classes
-keep class kotlinx.serialization.** { *; }
-keep class com.agui.core.types.** { *; }

# Keep RxJava
-keep class io.reactivex.rxjava3.** { *; }

# Keep Kotlin coroutines
-keep class kotlinx.coroutines.** { *; }

# Keep Gson classes
-keep class com.google.gson.** { *; }
-keepattributes Signature
-keepattributes *Annotation*

# Keep data classes
-keep class * implements java.io.Serializable { *; }