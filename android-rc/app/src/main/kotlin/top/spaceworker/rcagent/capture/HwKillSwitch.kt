package top.spaceworker.rcagent.capture

import android.content.Context
import top.spaceworker.rcagent.core.FaultLog

object HwKillSwitch {
    const val PREFS = "rc"
    const val KEY = "skip_hw_h264"

    fun shouldSkip(fault: String, step: String): Boolean {
        if (!fault.contains("KILLED")) return false
        return step.contains("mp:h264 init") || step.contains("mp:ok h264")
    }

    fun skip(ctx: Context): Boolean {
        if (ctx.getSharedPreferences(PREFS, 0).getBoolean(KEY, false)) return true
        if (shouldSkip(FaultLog.faultText(), FaultLog.stepLine())) {
            persistSkip(ctx)
            return true
        }
        return false
    }

    fun persistSkip(ctx: Context) {
        ctx.getSharedPreferences(PREFS, 0).edit().putBoolean(KEY, true).apply()
    }

    fun clear(ctx: Context) {
        ctx.getSharedPreferences(PREFS, 0).edit().remove(KEY).apply()
    }
}
