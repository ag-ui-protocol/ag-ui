package com.agui.a2ui.catalog

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.*
import androidx.compose.ui.graphics.vector.ImageVector

/**
 * Predefined set of Material Icons available for A2UI components.
 *
 * This enum maps string icon names (used in A2UI JSON) to Compose Material Icons.
 * The set matches common icons from the flutter/genui AvailableIcons enum.
 */
enum class AvailableIcons(val icon: ImageVector) {
    // Navigation
    HOME(Icons.Default.Home),
    MENU(Icons.Default.Menu),
    ARROW_BACK(Icons.AutoMirrored.Filled.ArrowBack),
    ARROW_FORWARD(Icons.AutoMirrored.Filled.ArrowForward),
    CLOSE(Icons.Default.Close),

    // Actions
    ADD(Icons.Default.Add),
    REMOVE(Icons.Default.Clear),
    DELETE(Icons.Default.Delete),
    EDIT(Icons.Default.Edit),
    SAVE(Icons.Default.Done),
    SEARCH(Icons.Default.Search),
    REFRESH(Icons.Default.Refresh),
    SHARE(Icons.Default.Share),
    SETTINGS(Icons.Default.Settings),
    CHECK(Icons.Default.Check),

    // Communication
    EMAIL(Icons.Default.Email),
    PHONE(Icons.Default.Phone),
    CHAT(Icons.Default.Email),  // Using Email as fallback
    SEND(Icons.AutoMirrored.Filled.Send),
    NOTIFICATIONS(Icons.Default.Notifications),

    // Content
    FAVORITE(Icons.Default.Favorite),
    STAR(Icons.Default.Star),
    INFO(Icons.Default.Info),
    WARNING(Icons.Default.Warning),
    ERROR(Icons.Default.Warning),  // Using Warning as fallback
    HELP(Icons.Default.Info),  // Using Info as fallback

    // Media
    PLAY_ARROW(Icons.Default.PlayArrow),
    PAUSE(Icons.Default.Clear),  // Using Clear as fallback
    STOP(Icons.Default.Clear),  // Using Clear as fallback
    SKIP_NEXT(Icons.Default.ArrowDropDown),  // Using ArrowDropDown as fallback
    SKIP_PREVIOUS(Icons.Default.ArrowDropDown),  // Using ArrowDropDown as fallback
    VOLUME_UP(Icons.Default.Notifications),  // Using Notifications as fallback
    VOLUME_OFF(Icons.Default.Clear),  // Using Clear as fallback

    // Files
    FOLDER(Icons.Default.Create),  // Using Create as fallback
    FILE_COPY(Icons.Default.Create),  // Using Create as fallback
    ATTACH_FILE(Icons.Default.Add),  // Using Add as fallback
    DOWNLOAD(Icons.Default.KeyboardArrowDown),
    UPLOAD(Icons.Default.KeyboardArrowUp),

    // People
    PERSON(Icons.Default.Person),
    PEOPLE(Icons.Default.Person),  // Using Person as fallback
    ACCOUNT_CIRCLE(Icons.Default.AccountCircle),

    // Places
    LOCATION_ON(Icons.Default.LocationOn),
    MAP(Icons.Default.Place),

    // Misc
    CALENDAR_TODAY(Icons.Default.DateRange),
    SCHEDULE(Icons.Default.DateRange),  // Using DateRange as fallback
    BROKEN_IMAGE(Icons.Default.Warning);  // Using Warning as fallback

    companion object {
        /**
         * List of all available icon names.
         */
        val allAvailable: List<String> = entries.map { it.name.lowercase() }

        /**
         * Gets an icon by name (case-insensitive).
         * Returns BROKEN_IMAGE if the name is not found.
         */
        fun fromName(name: String): ImageVector {
            val normalized = name.uppercase().replace("-", "_").replace(" ", "_")
            return entries.find { it.name == normalized }?.icon ?: BROKEN_IMAGE.icon
        }

        /**
         * Gets an icon by name, returning null if not found.
         */
        fun fromNameOrNull(name: String): ImageVector? {
            val normalized = name.uppercase().replace("-", "_").replace(" ", "_")
            return entries.find { it.name == normalized }?.icon
        }
    }
}
