package top.spaceworker.rcagent.boot

import android.content.Context
import android.os.BatteryManager
import android.provider.Settings
import android.provider.Settings.Secure.ACCESSIBILITY_ENABLED
import android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
import android.util.Log
import top.spaceworker.rcagent.core.Capabilities
import top.spaceworker.rcagent.core.Config
import top.spaceworker.rcagent.input.KnoxInputEngine

object SelfHeal {
    fun run(ctx: Context) {
        val cr = ctx.contentResolver

        // One UI hay tắt accessibility sau OTA hoặc sau app update
        runCatching {
            val cur = Settings.Secure.getString(cr, ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
            if (!Capabilities.listedIn(cur)) {
                val next = listOf(cur, Config.SVC, Config.SVC_SHORT)
                    .filter { it.isNotBlank() }
                    .distinct()
                    .joinToString(":")
                Settings.Secure.putString(cr, ENABLED_ACCESSIBILITY_SERVICES, next)
            }
            Settings.Secure.putInt(cr, ACCESSIBILITY_ENABLED, 1)
        }.onFailure { Log.w(Config.TAG, "a11y self-heal failed: ${it.message}") }

        // Kiosk: projection bị dừng khi khoá màn hình (Android 15 QPR1+)
        runCatching {
            Settings.Global.putInt(
                cr,
                Settings.Global.STAY_ON_WHILE_PLUGGED_IN,
                BatteryManager.BATTERY_PLUGGED_AC or BatteryManager.BATTERY_PLUGGED_USB,
            )
        }

        KnoxInputEngine.ensureLicensed(ctx)
    }
}
