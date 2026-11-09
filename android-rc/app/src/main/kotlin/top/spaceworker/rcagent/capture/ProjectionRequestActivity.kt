package top.spaceworker.rcagent.capture

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
import android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
import android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
import android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
import android.widget.TextView
import top.spaceworker.rcagent.R
import top.spaceworker.rcagent.core.Config
import top.spaceworker.rcagent.core.FaultLog
import top.spaceworker.rcagent.core.SessionBus
import top.spaceworker.rcagent.input.RcAccessibilityService

internal object ProjectionLaunch {
    // CLEAR_TOP brings this activity over MediaProjectionPermissionActivity and cancels it.
    const val FLAGS = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
    const val NOTIF = 17
    const val CH = "rc_prompt"
}

class ProjectionRequestActivity : Activity() {
    private var asked = false

    override fun onCreate(s: Bundle?) {
        super.onCreate(s)
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }
        @Suppress("DEPRECATION")
        window.addFlags(
            FLAG_KEEP_SCREEN_ON or FLAG_TURN_SCREEN_ON or FLAG_SHOW_WHEN_LOCKED or FLAG_DISMISS_KEYGUARD,
        )
        ScreenWake.acquire(this)
        ScreenWake.allowCapture(this)
        dismissNotif()
        val tv = TextView(this).apply {
            text = getString(R.string.proj_waiting)
            textSize = 18f
            setTextColor(Color.WHITE)
            setBackgroundColor(0xFF121212.toInt())
            gravity = Gravity.CENTER
            setPadding(48, 48, 48, 48)
        }
        setContentView(tv)
        asked = s != null
    }

    override fun onResume() {
        super.onResume()
        if (asked) return
        asked = true
        @Suppress("DEPRECATION")
        startActivityForResult(captureIntent(this), REQ)
        Log.i(Config.TAG, "projection prompt shown")
        RcAccessibilityService.watchConsent()
    }

    @Deprecated("spec uses onActivityResult")
    override fun onActivityResult(r: Int, res: Int, data: Intent?) {
        if (r == REQ && res == RESULT_OK && data != null) SessionBus.onProjection(this, data)
        else SessionBus.onProjectionDenied()
        finish()
    }

    private fun dismissNotif() {
        getSystemService(NotificationManager::class.java).cancel(ProjectionLaunch.NOTIF)
    }

    companion object {
        private const val REQ = 7

        fun captureIntent(ctx: Context): Intent {
            val mpm = ctx.getSystemService(MediaProjectionManager::class.java)
            return if (Build.VERSION.SDK_INT >= 34)
                mpm.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
            else mpm.createScreenCaptureIntent()
        }

        fun launch(ctx: Context) {
            val app = ctx.applicationContext
            val i = Intent(app, ProjectionRequestActivity::class.java).addFlags(ProjectionLaunch.FLAGS)
            val from = RcAccessibilityService.instance ?: app
            val err = runCatching { from.startActivity(i) }.exceptionOrNull()
            if (err == null) {
                FaultLog.step("mp:proj activity")
                dismiss(app)
                return
            }
            FaultLog.error("PROJ_START", err, from.javaClass.simpleName)
            Log.w(Config.TAG, "proj startActivity ${err.message}")
            ensureChannel(app)
            // API 36+: ActivityOptions.pendingIntentBackgroundActivityStartMode must not be
            // passed into PendingIntent.getActivity — throws and aborts session.start
            val pi = PendingIntent.getActivity(
                app,
                ProjectionLaunch.NOTIF,
                i,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val n = Notification.Builder(app, ProjectionLaunch.CH)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(app.getString(R.string.proj_title))
                .setContentText(app.getString(R.string.proj_text))
                .setCategory(Notification.CATEGORY_ALARM)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setFullScreenIntent(pi, true)
                .setContentIntent(pi)
                .setAutoCancel(true)
                .build()
            runCatching { app.getSystemService(NotificationManager::class.java).notify(ProjectionLaunch.NOTIF, n) }
                .onFailure { FaultLog.error("FSI", it) }
        }

        fun dismiss(ctx: Context) {
            ctx.applicationContext.getSystemService(NotificationManager::class.java)
                .cancel(ProjectionLaunch.NOTIF)
        }

        private fun ensureChannel(ctx: Context) {
            val nm = ctx.getSystemService(NotificationManager::class.java)
            val ch = NotificationChannel(
                ProjectionLaunch.CH,
                ctx.getString(R.string.proj_title),
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                setBypassDnd(true)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
            nm.createNotificationChannel(ch)
        }
    }
}
