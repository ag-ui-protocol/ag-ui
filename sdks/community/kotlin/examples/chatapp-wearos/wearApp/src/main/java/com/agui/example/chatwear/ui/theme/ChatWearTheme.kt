package com.agui.example.chatwear.ui.theme

import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Color.Companion.Black
import androidx.compose.ui.graphics.Color.Companion.White
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.wear.compose.material3.MaterialTheme as WearMaterialTheme
import androidx.wear.compose.material3.ColorScheme
import androidx.wear.compose.material3.dynamicColorScheme

@Composable
fun ChatWearTheme(content: @Composable () -> Unit) {
    val context = LocalContext.current
    val dynamicScheme = remember(context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            dynamicColorScheme(context)
        } else {
            null
        }
    }

    val colorScheme = (dynamicScheme ?: vibrantColorScheme()).ensureContrast()

    WearMaterialTheme(
        colorScheme = colorScheme,
        content = content
    )
}

private fun vibrantColorScheme(): ColorScheme = ColorScheme(
    primary = Color(0xFF4D8EFF),
    primaryDim = Color(0xFF396FCB),
    primaryContainer = Color(0xFF123A84),
    onPrimary = Color.White,
    onPrimaryContainer = Color(0xFFD6E2FF),
    secondary = Color(0xFF2ED3C5),
    secondaryDim = Color(0xFF20A699),
    secondaryContainer = Color(0xFF00524C),
    onSecondary = Color.White,
    onSecondaryContainer = Color(0xFFA6F7EC),
    tertiary = Color(0xFFFF7DD1),
    tertiaryDim = Color(0xFFC6609E),
    tertiaryContainer = Color(0xFF601E4A),
    onTertiary = Color.White,
    onTertiaryContainer = Color(0xFFFFD7EE),
    surfaceContainerLow = Color(0xFF111821),
    surfaceContainer = Color(0xFF151C26),
    surfaceContainerHigh = Color(0xFF1E2734),
    onSurface = Color(0xFFE3E7F3),
    onSurfaceVariant = Color(0xFFA3ADC2),
    outline = Color(0xFF4F5A6E),
    outlineVariant = Color(0xFF2F3848),
    background = Color(0xFF080B10),
    onBackground = Color(0xFFE3E7F3),
    error = Color(0xFFFF6B7D),
    errorDim = Color(0xFFC74D5B),
    errorContainer = Color(0xFF640F1C),
    onError = Color.White,
    onErrorContainer = Color(0xFFFFD9DF)
)

private fun ColorScheme.ensureContrast(): ColorScheme {
    /**
     * Adjusts a foreground color to ensure it has a readable 4.5:1 contrast
     * ratio over a given background color.
     */
    fun adjust(foreground: Color, background: Color): Color {
        val contrast = contrastRatio(foreground, background)

        // If contrast is good, keep it.
        if (contrast >= 4.5f) return foreground

        // If contrast is bad, return the standard high-contrast fallback.
        return if (background.luminance() < 0.5f) Color.White else Color.Black
    }

    // --- THIS IS THE FIX ---

    // onSurface is used on surfaceContainer (in AgentStatusCard) AND
    // surfaceContainerHigh (in MessageBubble/Assistant)
    val onSurfaceAdjusted = adjust(onSurface, surfaceContainer)
    val onSurfaceFinal = adjust(onSurfaceAdjusted, surfaceContainerHigh)

    // onSurfaceVariant is used on surfaceContainer (in AgentStatusCard) AND
    // surfaceContainerLow (in MessageBubble/STEP_INFO)
    val onSurfaceVariantAdjusted = adjust(onSurfaceVariant, surfaceContainer)
    val onSurfaceVariantFinal = adjust(onSurfaceVariantAdjusted, surfaceContainerLow)

    // Return the new scheme with all "on" colors guaranteed to be readable
    return ColorScheme(
        primary = primary,
        primaryDim = primaryDim,
        primaryContainer = primaryContainer,
        onPrimary = adjust(onPrimary, primary),
        onPrimaryContainer = adjust(onPrimaryContainer, primaryContainer),
        secondary = secondary,
        secondaryDim = secondaryDim,
        secondaryContainer = secondaryContainer,
        onSecondary = adjust(onSecondary, secondary),
        onSecondaryContainer = adjust(onSecondaryContainer, secondaryContainer),
        tertiary = tertiary,
        tertiaryDim = tertiaryDim,
        tertiaryContainer = tertiaryContainer,
        onTertiary = adjust(onTertiary, tertiary),
        onTertiaryContainer = adjust(onTertiaryContainer, tertiaryContainer),
        surfaceContainerLow = surfaceContainerLow,
        surfaceContainer = surfaceContainer,
        surfaceContainerHigh = surfaceContainerHigh,
        onSurface = onSurfaceFinal, // Checked against both
        onSurfaceVariant = onSurfaceVariantFinal, // Checked against both
        outline = outline,
        outlineVariant = outlineVariant,
        background = background,
        onBackground = adjust(onBackground, background),
        error = error,
        errorDim = errorDim,
        errorContainer = errorContainer,
        onError = adjust(onError, error),
        onErrorContainer = adjust(onErrorContainer, errorContainer)
    )
}

private fun contrastRatio(foreground: Color, background: Color): Float {
    val l1 = foreground.luminance() + 0.05f
    val l2 = background.luminance() + 0.05f
    return if (l1 > l2) l1 / l2 else l2 / l1
}
