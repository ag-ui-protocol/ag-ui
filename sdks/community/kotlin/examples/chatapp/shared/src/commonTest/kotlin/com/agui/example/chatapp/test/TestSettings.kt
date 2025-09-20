package com.agui.example.chatapp.test

import com.russhwolf.settings.Settings

class TestSettings : Settings {
    private val data = mutableMapOf<String, Any?>()

    override val keys: Set<String>
        get() = data.keys.toSet()

    override val size: Int
        get() = data.size

    override fun clear() {
        data.clear()
    }

    override fun remove(key: String) {
        data.remove(key)
    }

    override fun hasKey(key: String): Boolean {
        return data.containsKey(key)
    }

    override fun putInt(key: String, value: Int) {
        data[key] = value
    }

    override fun getInt(key: String, defaultValue: Int): Int {
        return data[key] as? Int ?: defaultValue
    }

    override fun getIntOrNull(key: String): Int? {
        return data[key] as? Int
    }

    override fun putLong(key: String, value: Long) {
        data[key] = value
    }

    override fun getLong(key: String, defaultValue: Long): Long {
        return data[key] as? Long ?: defaultValue
    }

    override fun getLongOrNull(key: String): Long? {
        return data[key] as? Long
    }

    override fun putString(key: String, value: String) {
        data[key] = value
    }

    override fun getString(key: String, defaultValue: String): String {
        return data[key] as? String ?: defaultValue
    }

    override fun getStringOrNull(key: String): String? {
        return data[key] as? String
    }

    override fun putFloat(key: String, value: Float) {
        data[key] = value
    }

    override fun getFloat(key: String, defaultValue: Float): Float {
        return data[key] as? Float ?: defaultValue
    }

    override fun getFloatOrNull(key: String): Float? {
        return data[key] as? Float
    }

    override fun putDouble(key: String, value: Double) {
        data[key] = value
    }

    override fun getDouble(key: String, defaultValue: Double): Double {
        return data[key] as? Double ?: defaultValue
    }

    override fun getDoubleOrNull(key: String): Double? {
        return data[key] as? Double
    }

    override fun putBoolean(key: String, value: Boolean) {
        data[key] = value
    }

    override fun getBoolean(key: String, defaultValue: Boolean): Boolean {
        return data[key] as? Boolean ?: defaultValue
    }

    override fun getBooleanOrNull(key: String): Boolean? {
        return data[key] as? Boolean
    }
}