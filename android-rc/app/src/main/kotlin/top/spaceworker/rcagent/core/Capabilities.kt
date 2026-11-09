package top.spaceworker.rcagent.core

import android.Manifest
import android.app.AppOpsManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Process
import android.provider.Settings
import android.graphics.Point
import android.hardware.display.DisplayManager
import android.view.Display
import android.view.WindowManager
import android.view.accessibility.AccessibilityManager
import top.spaceworker.rcagent.capture.Encoder
import top.spaceworker.rcagent.input.KnoxInputEngine
import top.spaceworker.rcagent.input.RcAccessibilityService

data class EncoderInfo(val name: String, val hw: Boolean)

data class Capabilities(
    val projectMedia: String,
    val a11y: Boolean,
    val knox: String,
    val overlay: Boolean,
    val secureSettings: Boolean,
    val encoder: EncoderInfo?,
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "projectMedia" to projectMedia,
        "a11y" to a11y,
        "knox" to knox,
        "overlay" to overlay,
        "secureSettings" to secureSettings,
        "encoder" to encoder?.let { mapOf("name" to it.name, "hw" to it.hw) },
    )

    companion object {
        fun probe(ctx: Context): Capabilities {
            val ops = ctx.getSystemService(AppOpsManager::class.java)
            @Suppress("DEPRECATION")
            val mode = if (Build.VERSION.SDK_INT >= 29) {
                ops.unsafeCheckOpNoThrow("android:project_media", Process.myUid(), ctx.packageName)
            } else {
                ops.checkOpNoThrow("android:project_media", Process.myUid(), ctx.packageName)
            }
            val pm = when (mode) {
                AppOpsManager.MODE_ALLOWED -> "allow"
                AppOpsManager.MODE_ERRORED -> "blocked"
                else -> "default"
            }
            return Capabilities(
                projectMedia = pm,
                a11y = isA11yEnabled(ctx),
                knox = KnoxInputEngine.status(ctx),
                overlay = Settings.canDrawOverlays(ctx),
                secureSettings = ctx.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) ==
                    PackageManager.PERMISSION_GRANTED,
                encoder = Encoder.cachedInfo,
            )
        }

        fun isA11yEnabled(ctx: Context): Boolean =
            a11yListed(ctx) && a11yBound()

        fun a11yBound(): Boolean = RcAccessibilityService.instance != null

        fun a11yListed(ctx: Context): Boolean {
            val raw = Settings.Secure.getString(
                ctx.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
            ).orEmpty()
            if (listedIn(raw)) return true
            val am = ctx.getSystemService(AccessibilityManager::class.java) ?: return false
            return am.getEnabledAccessibilityServiceList(android.accessibilityservice.AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
                .any { it.id.contains("RcAccessibilityService") && it.id.contains(Config.PKG) }
        }

        fun listedIn(raw: String): Boolean =
            raw.split(':', ';').map { it.trim() }.any {
                it == Config.SVC || it == Config.SVC_SHORT
            }
    }
}

fun dpiOf(ctx: Context): Int = ctx.resources.displayMetrics.densityDpi

fun rotationOf(ctx: Context): Int {
    val dm = ctx.getSystemService(DisplayManager::class.java) ?: return 0
    return dm.getDisplay(Display.DEFAULT_DISPLAY)?.rotation ?: 0
}

fun screenSize(ctx: Context): Point {
    val fallback = Point(ctx.resources.displayMetrics.widthPixels, ctx.resources.displayMetrics.heightPixels)
    return runCatching {
        if (Build.VERSION.SDK_INT >= 30) {
            val b = ctx.getSystemService(WindowManager::class.java)?.maximumWindowMetrics?.bounds
            if (b != null && b.width() > 8 && b.height() > 8) return@runCatching Point(b.width(), b.height())
        }
        val p = Point()
        @Suppress("DEPRECATION")
        ctx.getSystemService(DisplayManager::class.java)
            ?.getDisplay(Display.DEFAULT_DISPLAY)
            ?.getRealSize(p)
        if (p.x > 8 && p.y > 8) p else fallback
    }.getOrDefault(fallback)
}

fun capsJson(caps: Capabilities): org.json.JSONObject = org.json.JSONObject().apply {
    put("projectMedia", caps.projectMedia)
    put("a11y", caps.a11y)
    put("knox", caps.knox)
    put("overlay", caps.overlay)
    put("secureSettings", caps.secureSettings)
    caps.encoder?.let { put("encoder", org.json.JSONObject().put("name", it.name).put("hw", it.hw)) }
}
