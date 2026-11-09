package top.spaceworker.rcagent.mdm

import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.util.Log
import top.spaceworker.rcagent.core.BackendPrefs
import top.spaceworker.rcagent.core.Config
import top.spaceworker.rcagent.transport.MqttClient

/** Device-Owner admin receiver (QR unattended provisioning).
 *
 * On first enable the system delivers PROVISIONING_ADMIN_EXTRAS_BUNDLE containing
 * rc_server, rc_enroll, rc_ws, rc_mqtt. We persist them to BackendPrefs and connect MQTT
 * so the device is fully provisioned with zero user interaction.
 */
class AdminReceiver : DeviceAdminReceiver() {

    override fun onEnabled(context: Context, intent: Intent) {
        super.onEnabled(context, intent)
        Log.i(Config.TAG, "AdminReceiver onEnabled")
        val extras = intent.getParcelableExtra<Bundle>(
            DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE,
        )
        val applied = extras?.let { b ->
            val raw = mutableMapOf<String, String>()
            for (k in b.keySet()) {
                val v = when (val x = b.get(k)) {
                    is String -> x
                    is Number -> x.toString()
                    is Boolean -> x.toString()
                    else -> null
                }
                if (v != null && v.isNotBlank()) raw[k] = v
            }
            raw.toMap()
        } ?: emptyMap()
        applyExtras(context, applied)
        MqttClient.connectNow()
    }

    override fun onDisabled(context: Context, intent: Intent) {
        super.onDisabled(context, intent)
        Log.w(Config.TAG, "AdminReceiver onDisabled — device no longer managed")
    }

    override fun onDisableRequested(context: Context, intent: Intent): CharSequence? {
        Log.w(Config.TAG, "AdminReceiver onDisableRequested")
        return null // allow disable (policy decision; fleet may return a warning to lock)
    }

    override fun onProfileProvisioningComplete(context: Context, intent: Intent) {
        super.onProfileProvisioningComplete(context, intent)
        Log.i(Config.TAG, "AdminReceiver onProfileProvisioningComplete")
        val extras = intent.getParcelableExtra<Bundle>(
            DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE,
        )
        val applied = extras?.let { b ->
            val raw = mutableMapOf<String, String>()
            for (k in b.keySet()) {
                val v = when (val x = b.get(k)) {
                    is String -> x
                    is Number -> x.toString()
                    is Boolean -> x.toString()
                    else -> null
                }
                if (v != null && v.isNotBlank()) raw[k] = v
            }
            raw.toMap()
        } ?: emptyMap()
        applyExtras(context, applied)
        MqttClient.connectNow()
    }

    private fun applyExtras(ctx: Context, applied: Map<String, String>) {
        if (applied.isEmpty()) return
        // Map provisioning keys onto the same keys ManagedConfig.flatten understands.
        val mapped = mutableMapOf<String, String>()
        applied["rc_server"]?.let { mapped["host"] = it }
        applied["rc_mqtt"]?.let { mapped["mqtt"] = it }
        applied["rc_enroll"]?.let { mapped["mqtt_password"] = it }
        // `ws_port` is an Int; extract it from the rc_ws URL (wss://host:443).
        applied["rc_ws"]?.let { ws ->
            val port = runCatching { java.net.URI(ws.trim()).port }.getOrNull()
            if (port != null && port in 1..65535) mapped["ws_port"] = port.toString()
        }
        if (mapped.isNotEmpty()) {
            ManagedConfig.apply(ctx, mapped)
        }
        Log.i(Config.TAG, "AdminReceiver extras applied: ${mapped.keys.joinToString(",")}")
    }

    companion object {
        private const val KEY_SERVER = "rc_server"
        private const val KEY_ENROLL = "rc_enroll"
        private const val KEY_WS = "rc_ws"
        private const val KEY_MQTT = "rc_mqtt"
    }
}
