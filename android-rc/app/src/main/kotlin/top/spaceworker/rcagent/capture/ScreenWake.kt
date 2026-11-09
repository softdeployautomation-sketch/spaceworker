package top.spaceworker.rcagent.capture

import android.app.Activity
import android.content.Context
import android.os.Build
import android.os.PowerManager
import android.util.Log
import android.view.WindowManager.LayoutParams.FLAG_SECURE
import top.spaceworker.rcagent.core.Config

object ScreenWake {
    private var lock: PowerManager.WakeLock? = null

    fun acquire(ctx: Context, holdMs: Long = Config.SESSION_WAKE_MS) {
        val pm = ctx.applicationContext.getSystemService(PowerManager::class.java) ?: return
        val existing = lock
        if (existing?.isHeld == true) {
            existing.release()
        }
        @Suppress("DEPRECATION")
        val flags = PowerManager.SCREEN_BRIGHT_WAKE_LOCK or
            PowerManager.ACQUIRE_CAUSES_WAKEUP or
            PowerManager.ON_AFTER_RELEASE
        lock = pm.newWakeLock(flags, "rcagent:session").apply {
            setReferenceCounted(false)
            acquire(holdMs)
        }
        Log.i(Config.TAG, "screen wake hold=${holdMs}ms on=${pm.isInteractive}")
    }

    fun release() {
        runCatching { if (lock?.isHeld == true) lock?.release() }
        lock = null
    }

    fun allowCapture(activity: Activity) {
        activity.window.clearFlags(FLAG_SECURE)
        if (Build.VERSION.SDK_INT >= 33) activity.setRecentsScreenshotEnabled(true)
    }
}
