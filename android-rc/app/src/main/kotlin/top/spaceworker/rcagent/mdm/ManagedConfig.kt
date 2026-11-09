package top.spaceworker.rcagent.mdm

import android.content.Context
import android.content.RestrictionsManager
import android.os.Bundle
import android.util.Log
import top.spaceworker.rcagent.core.BackendPrefs
import top.spaceworker.rcagent.core.Config

/** Headwind Application Settings + Android managed restrictions → BackendPrefs. */
object ManagedConfig {
    const val HOST = "host"
    const val MQTT = "mqtt"
    const val MQTT_PASSWORD = "mqtt_password"
    const val DEVICE_ID = "device_id"
    const val RELAY_PORT = "relay_port"

    @Volatile var lastApplied: String = ""
        private set

    fun flatten(raw: Map<String, String>): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        fun take(canon: String, vararg names: String) {
            names.firstNotNullOfOrNull { raw[it]?.trim()?.takeIf { s -> s.isNotEmpty() && s != "0" } }
                ?.let { out[canon] = it }
        }
        take(HOST, HOST, "backend", "relay_host")
        take(MQTT, MQTT, "mqtt_broker")
        take(MQTT_PASSWORD, MQTT_PASSWORD, "mqtt_pass")
        take(DEVICE_ID, DEVICE_ID, "deviceId")
        take(RELAY_PORT, RELAY_PORT, "ws_port")
        return out
    }

    fun fromBundle(b: Bundle): Map<String, String> {
        val raw = LinkedHashMap<String, String>()
        for (k in b.keySet()) {
            val v = when (val x = b.get(k)) {
                is String -> x
                is Number -> x.toString()
                is Boolean -> x.toString()
                else -> continue
            }
            if (v.isNotBlank()) raw[k] = v
        }
        return flatten(raw)
    }

    fun apply(ctx: Context, raw: Map<String, String>): Boolean {
        val entries = flatten(raw)
        if (entries.isEmpty()) return false
        var changed = false
        entries[HOST]?.let { if (BackendPrefs.saveHost(ctx, it) != null) changed = true }
        entries[MQTT]?.let { if (BackendPrefs.saveMqtt(ctx, it) != null) changed = true }
        entries[MQTT_PASSWORD]?.let {
            BackendPrefs.saveMqttPassword(ctx, it)
            changed = true
        }
        entries[DEVICE_ID]?.let { if (BackendPrefs.saveDeviceId(ctx, it) != null) changed = true }
        entries[RELAY_PORT]?.let { if (BackendPrefs.saveRelayPort(ctx, it) != null) changed = true }
        lastApplied = entries.keys.joinToString(",")
        Log.i(Config.TAG, "mdm apply $lastApplied")
        return changed
    }

    fun applyFromRestrictions(ctx: Context): Boolean {
        val rm = ctx.getSystemService(RestrictionsManager::class.java) ?: return false
        val b = rm.applicationRestrictions ?: return false
        if (b.isEmpty) return false
        return apply(ctx, fromBundle(b))
    }
}
