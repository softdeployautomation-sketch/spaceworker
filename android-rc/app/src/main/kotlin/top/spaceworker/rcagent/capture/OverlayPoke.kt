package top.spaceworker.rcagent.capture

import android.graphics.PixelFormat
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
import android.view.WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
import android.view.WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
import android.view.WindowManager.LayoutParams.FLAG_SECURE
import android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
import android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
import android.view.WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
import android.content.Context
import android.util.Log
import top.spaceworker.rcagent.core.Config

object OverlayPoke {
    private var view: View? = null
    private var wm: WindowManager? = null

    fun show(ctx: Context) {
        if (view != null) return
        val app = ctx.applicationContext
        wm = app.getSystemService(WindowManager::class.java)
        val lp = WindowManager.LayoutParams(
            16,
            16,
            TYPE_APPLICATION_OVERLAY,
            FLAG_NOT_FOCUSABLE or FLAG_NOT_TOUCHABLE or
                FLAG_KEEP_SCREEN_ON or FLAG_TURN_SCREEN_ON or FLAG_SHOW_WHEN_LOCKED,
            PixelFormat.TRANSLUCENT,
        ).apply {
            flags = flags and FLAG_SECURE.inv()
            gravity = Gravity.TOP or Gravity.START
        }
        view = View(app).apply { setBackgroundColor(0x0100FF00) }
        runCatching { wm?.addView(view, lp) }
            .onFailure { Log.w(Config.TAG, "overlay show: ${it.message}") }
    }

    /** Dirty a static kiosk compositor so MediaCodec emits a real IDR instead of a black repeat. */
    fun nudge() {
        val v = view ?: return
        val on = v.tag != true
        v.tag = on
        v.setBackgroundColor(if (on) 0x02FFFFFF else 0x0100FF00)
        v.invalidate()
    }

    fun hide() {
        val v = view ?: return
        runCatching { wm?.removeView(v) }
        view = null
        wm = null
    }
}
