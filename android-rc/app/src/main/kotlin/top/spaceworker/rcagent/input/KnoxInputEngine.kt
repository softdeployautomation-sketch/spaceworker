package top.spaceworker.rcagent.input

import android.content.Context
import android.util.Log
import top.spaceworker.rcagent.core.Config
import top.spaceworker.rcagent.core.screenSize

object LicenseStore {
    fun isActivated(ctx: Context): Boolean =
        ctx.getSharedPreferences("rc", 0).getBoolean("knox_licensed", false)

    fun setActivated(ctx: Context, v: Boolean) {
        ctx.getSharedPreferences("rc", 0).edit().putBoolean("knox_licensed", v).apply()
    }
}

class KnoxInputEngine(private val ctx: Context) : InputEngine {
    override val name = "knox"
    private var ri: Any? = null
    private var downTime = 0L
    private val realW get() = screenSize(ctx).x.toFloat().coerceAtLeast(1f)
    private val realH get() = screenSize(ctx).y.toFloat().coerceAtLeast(1f)

    override fun isAvailable(): Boolean {
        if (!LicenseStore.isActivated(ctx)) return false
        return try {
            val edmClass = Class.forName("com.samsung.android.knox.EnterpriseDeviceManager")
            val edm = edmClass.getMethod("getInstance", Context::class.java).invoke(null, ctx)
            ri = edmClass.getMethod("getRemoteInjection").invoke(edm)
            ri != null
        } catch (t: Throwable) {
            false
        }
    }

    override fun touch(action: String, nx: Float, ny: Float, pointerId: Int) {
        val a = when (action) {
            "down" -> android.view.MotionEvent.ACTION_DOWN
            "move" -> android.view.MotionEvent.ACTION_MOVE
            else -> android.view.MotionEvent.ACTION_UP
        }
        val t = android.os.SystemClock.uptimeMillis()
        if (action == "down") downTime = t
        val ev = android.view.MotionEvent.obtain(downTime, t, a, nx * realW, ny * realH, 0)
        val target = ri ?: return
        runCatching {
            target.javaClass.getMethod(
                "injectPointerEvent",
                android.view.MotionEvent::class.java,
                Boolean::class.javaPrimitiveType,
            ).invoke(target, ev, true)
        }.onFailure { Log.w(Config.TAG, "knox pointer: ${it.message}") }
        ev.recycle()
    }

    override fun key(k: String) {
        val code = keyCode(k) ?: return
        injectKey(android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, code))
        injectKey(android.view.KeyEvent(android.view.KeyEvent.ACTION_UP, code))
    }

    override fun text(v: String) {
        val km = android.view.KeyCharacterMap.load(android.view.KeyCharacterMap.VIRTUAL_KEYBOARD)
        km.getEvents(v.toCharArray())?.forEach { injectKey(it) }
    }

    private fun injectKey(event: android.view.KeyEvent) {
        val target = ri ?: return
        runCatching {
            target.javaClass.getMethod(
                "injectKeyEvent",
                android.view.KeyEvent::class.java,
                Boolean::class.javaPrimitiveType,
            ).invoke(target, event, true)
        }.onFailure { Log.w(Config.TAG, "knox key: ${it.message}") }
    }

    companion object {
        fun status(ctx: Context): String = try {
            val edmClass = Class.forName("com.samsung.android.knox.EnterpriseDeviceManager")
            val edm = edmClass.getMethod("getInstance", Context::class.java).invoke(null, ctx)
            edmClass.getMethod("getRemoteInjection").invoke(edm)
            if (LicenseStore.isActivated(ctx)) "licensed" else "unlicensed"
        } catch (t: Throwable) {
            "unsupported"
        }

        fun ensureLicensed(ctx: Context) {
            if (status(ctx) != "unlicensed") return
            // ponytail: no Knox license key in repo; MDM pre-activates on fleet
            Log.i(Config.TAG, "knox license skipped (no key)")
        }

        internal fun keyCode(k: String): Int? = when (k) {
            "back" -> android.view.KeyEvent.KEYCODE_BACK
            "home" -> android.view.KeyEvent.KEYCODE_HOME
            "recents" -> android.view.KeyEvent.KEYCODE_APP_SWITCH
            "up" -> android.view.KeyEvent.KEYCODE_DPAD_UP
            "down" -> android.view.KeyEvent.KEYCODE_DPAD_DOWN
            "left" -> android.view.KeyEvent.KEYCODE_DPAD_LEFT
            "right" -> android.view.KeyEvent.KEYCODE_DPAD_RIGHT
            "enter" -> android.view.KeyEvent.KEYCODE_ENTER
            else -> null
        }
    }
}
