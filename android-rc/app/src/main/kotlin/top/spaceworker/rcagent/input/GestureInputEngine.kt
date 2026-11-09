package top.spaceworker.rcagent.input

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.accessibilityservice.GestureDescription.StrokeDescription
import android.content.Context
import android.graphics.Path
import android.graphics.PointF
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import top.spaceworker.rcagent.core.Config
import top.spaceworker.rcagent.core.screenSize
import kotlin.math.hypot

internal object GestureMath {
    fun durationMs(distancePx: Float, holdMs: Long): Long {
        val tap = distancePx < 24f
        return when {
            tap && holdMs >= 450L -> holdMs.coerceIn(500L, 1200L)
            tap -> 80L
            else -> (distancePx / 2.5f).toLong().coerceIn(120L, 500L)
        }
    }
}

class GestureInputEngine(private val ctx: Context) : InputEngine {
    override val name = "gesture"
    private val pending = mutableListOf<PointF>()
    private val handler = Handler(Looper.getMainLooper())
    private var downAt = 0L

    private val realW get() = screenSize(ctx).x.toFloat().coerceAtLeast(1f)
    private val realH get() = screenSize(ctx).y.toFloat().coerceAtLeast(1f)

    override fun isAvailable(): Boolean = RcAccessibilityService.instance != null

    override fun touch(action: String, nx: Float, ny: Float, pointerId: Int) {
        val p = PointF(
            (nx * realW).coerceIn(0f, realW - 1f),
            (ny * realH).coerceIn(0f, realH - 1f),
        )
        handler.post {
            when (action) {
                "down" -> {
                    pending.clear()
                    pending += p
                    downAt = SystemClock.uptimeMillis()
                    Log.i(Config.TAG, "touch down ${"%.3f".format(nx)},${"%.3f".format(ny)} -> ${p.x.toInt()},${p.y.toInt()}")
                }
                "move" -> if (pending.isNotEmpty()) pending += p
                else -> {
                    Log.i(Config.TAG, "touch $action")
                    pending += p
                    commit()
                }
            }
        }
    }

    override fun key(k: String) {
        handler.post {
            val svc = RcAccessibilityService.instance ?: return@post
            val action = when (k) {
                "back" -> AccessibilityService.GLOBAL_ACTION_BACK
                "home" -> AccessibilityService.GLOBAL_ACTION_HOME
                "recents" -> AccessibilityService.GLOBAL_ACTION_RECENTS
                else -> return@post
            }
            Log.i(Config.TAG, "key $k")
            svc.performGlobalAction(action)
        }
    }

    override fun text(v: String) {
        handler.post {
            val svc = RcAccessibilityService.instance ?: return@post
            val root = svc.rootInActiveWindow ?: return@post
            val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return@post
            val args = android.os.Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, v)
            }
            focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        }
    }

    override fun scroll(nx: Float, ny: Float, dy: Float) {
        handler.post {
            val x = (nx * realW).coerceIn(0f, realW - 1f)
            val y = (ny * realH).coerceIn(0f, realH - 1f)
            val y2 = (y - dy * realH).coerceIn(0f, realH - 1f)
            val path = Path().apply {
                moveTo(x, y)
                lineTo(x, y2)
            }
            Log.i(Config.TAG, "scroll $x,$y -> $x,$y2")
            dispatch(StrokeDescription(path, 0, 180L, false), x, y)
        }
    }

    private fun commit() {
        if (pending.isEmpty()) return
        val a = pending.first()
        val b = pending.last()
        val dist = hypot((b.x - a.x).toDouble(), (b.y - a.y).toDouble()).toFloat()
        val dur = GestureMath.durationMs(dist, SystemClock.uptimeMillis() - downAt)
        val path = Path()
        path.moveTo(a.x, a.y)
        if (pending.size == 1 || dist < 2f) path.lineTo((a.x + 1f).coerceAtMost(realW - 1f), a.y)
        else pending.drop(1).forEach { path.lineTo(it.x, it.y) }
        Log.i(Config.TAG, "gesture n=${pending.size} dist=${dist.toInt()} dur=$dur")
        // ponytail: never ACTION_CLICK first — kiosk root isClickable and swallows the real tap
        dispatch(StrokeDescription(path, 0, dur, false), a.x, a.y)
        pending.clear()
    }

    private fun dispatch(stroke: StrokeDescription, x: Float, y: Float) {
        val svc = RcAccessibilityService.instance
        if (svc == null) {
            Log.w(Config.TAG, "touch dropped — a11y off")
            return
        }
        val ok = svc.dispatchGesture(
            GestureDescription.Builder().addStroke(stroke).build(),
            object : AccessibilityService.GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription?) {
                    Log.i(Config.TAG, "gesture ok")
                }
                override fun onCancelled(gestureDescription: GestureDescription?) {
                    Log.w(Config.TAG, "gesture cancelled")
                    clickAt(x, y)
                }
            },
            handler,
        )
        if (!ok) {
            Log.w(Config.TAG, "dispatchGesture rejected")
            clickAt(x, y)
        }
    }

    private fun clickAt(x: Float, y: Float): Boolean {
        val svc = RcAccessibilityService.instance ?: return false
        val root = svc.rootInActiveWindow ?: return false
        val hit = hitNode(root, x.toInt(), y.toInt()) ?: return false
        var n: AccessibilityNodeInfo? = hit
        while (n != null) {
            if (n.isClickable || n.isCheckable) {
                val ok = n.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                if (ok) {
                    Log.i(Config.TAG, "a11y click ${n.className}")
                    return true
                }
            }
            n = n.parent
        }
        return false
    }

    private fun hitNode(node: AccessibilityNodeInfo, x: Int, y: Int): AccessibilityNodeInfo? {
        val r = android.graphics.Rect()
        node.getBoundsInScreen(r)
        if (!r.contains(x, y)) return null
        var best: AccessibilityNodeInfo? = node
        var bestArea = r.width() * r.height()
        for (i in 0 until node.childCount) {
            val c = node.getChild(i) ?: continue
            val h = hitNode(c, x, y) ?: continue
            val cr = android.graphics.Rect()
            h.getBoundsInScreen(cr)
            val area = cr.width() * cr.height()
            if (area in 1 until bestArea) {
                best = h
                bestArea = area
            }
        }
        return best
    }
}
