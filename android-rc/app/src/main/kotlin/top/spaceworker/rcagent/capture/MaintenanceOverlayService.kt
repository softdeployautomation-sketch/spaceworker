package top.spaceworker.rcagent.capture

import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.IBinder
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
import android.view.WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
import android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
import android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
import android.view.WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
import android.widget.LinearLayout
import android.widget.TextView
import top.spaceworker.rcagent.R
import top.spaceworker.rcagent.core.Config

/**
 * Full-screen branded maintenance overlay.
 *
 * Toggled by MQTT control commands `maintenance.start` / `maintenance.stop`.
 * Optional touch blocking (when `extra.touch_block == true` the overlay swallows
 * all input so the device cannot be used during maintenance).
 *
 * Requires SYSTEM_ALERT_WINDOW (granted via provision.sh / BYOD overlay row).
 */
class MaintenanceOverlayService : Service() {

    private var wm: WindowManager? = null
    private var view: View? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action
        when {
            ACTION_START == action -> {
                val touchBlock = intent.getBooleanExtra(EXTRA_TOUCH_BLOCK, false)
                showOverlay(touchBlock)
            }
            ACTION_STOP == action -> hideOverlay()
        }
        return START_NOT_STICKY
    }

    private fun showOverlay(touchBlock: Boolean) {
        hideOverlay()
        val app = applicationContext
        wm = app.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val flags = when {
            touchBlock -> FLAG_KEEP_SCREEN_ON or FLAG_SHOW_WHEN_LOCKED or FLAG_TURN_SCREEN_ON
            else -> FLAG_NOT_FOCUSABLE or FLAG_KEEP_SCREEN_ON or FLAG_SHOW_WHEN_LOCKED or FLAG_TURN_SCREEN_ON
        }
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            TYPE_APPLICATION_OVERLAY,
            flags,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            packageName = app.packageName
            // WindowManager.LayoutParams.token is null for application overlays — fine.
        }
        val root = LinearLayout(app).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(0xFF0B0E14.toInt()) // deep branded navy
        }
        val label = TextView(app).apply {
            text = app.getString(R.string.maintenance_label)
            textSize = 22f
            setTextColor(Color.WHITE)
            setPadding(0, 0, 0, 24)
            gravity = Gravity.CENTER
        }
        val sub = TextView(app).apply {
            text = app.getString(R.string.maintenance_subtitle)
            textSize = 15f
            setTextColor(0xFF9AA7B8.toInt())
            gravity = Gravity.CENTER
        }
        root.addView(label)
        root.addView(sub)
        view = root
        runCatching { wm?.addView(root, lp) }
            .onFailure { Log.w(Config.TAG, "maintenance overlay show: ${it.message}") }
        Log.i(Config.TAG, "maintenance overlay show touchBlock=$touchBlock")
    }

    private fun hideOverlay() {
        val v = view
        if (v != null) runCatching { wm?.removeView(v) }
        view = null
        wm = null
        Log.i(Config.TAG, "maintenance overlay hide")
    }

    override fun onDestroy() {
        hideOverlay()
        super.onDestroy()
    }

    companion object {
        const val ACTION_START = "top.spaceworker.rcagent.MAINTENANCE_START"
        const val ACTION_STOP = "top.spaceworker.rcagent.MAINTENANCE_STOP"
        const val EXTRA_TOUCH_BLOCK = "touch_block"
    }
}
