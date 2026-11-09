package top.spaceworker.rcagent.core

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import top.spaceworker.rcagent.RcApplication
import top.spaceworker.rcagent.capture.CaptureService
import top.spaceworker.rcagent.capture.SessionCapture
import top.spaceworker.rcagent.capture.OverlayPoke
import top.spaceworker.rcagent.capture.ProjectionRequestActivity
import top.spaceworker.rcagent.capture.ScreenWake
import top.spaceworker.rcagent.capture.ScreenshotPump
import top.spaceworker.rcagent.input.GestureInputEngine
import top.spaceworker.rcagent.input.InputEngine
import top.spaceworker.rcagent.input.KnoxInputEngine
import top.spaceworker.rcagent.transport.MqttClient
import org.json.JSONObject

data class SessionRequest(
    val sessionId: String?,
    val wsUrl: String?,
    val token: String?,
)

object SessionBus {
    @Volatile var current: SessionRequest? = null
        private set

    @Volatile var input: InputEngine? = null
        private set

    @Volatile var lastError: String? = null
        private set

    @Volatile var skipAboveW: Int = Int.MAX_VALUE
    @Volatile var awaitingProjection: Boolean = false
        private set
    @Volatile private var stopping = false
    private val main = Handler(Looper.getMainLooper())
    private val projectionTimeout = Runnable {
        if (AgentState.phase != AgentState.Phase.ACQUIRING || !awaitingProjection) return@Runnable
        awaitingProjection = false
        val req = current ?: return@Runnable
        if (ScreenshotPump.available()) {
            Log.w(Config.TAG, "projection timeout, jpeg fallback")
            FaultLog.step("mp:timeout jpeg")
            // Tự phục hồi được, nhưng phải kêu: AutoConsent mù thì cả fleet tụt
            // xuống JPEG mà không ai biết, chỉ thấy "dạo này xem máy nào cũng mờ".
            SessionDiag.fail("PROJECTION_FALLBACK", "consent timeout, jpeg path")
            MqttClient.publishEvent("PROJECTION_FALLBACK", "consent timeout, jpeg path")
            SessionCapture.start(req)
        } else {
            fail("PROJECTION_TIMEOUT")
        }
    }

    fun start(ctx: Context, req: SessionRequest) {
        lastError = null
        SessionDiag.clearFail()
        if (AgentState.phase == AgentState.Phase.STREAMING ||
            AgentState.phase == AgentState.Phase.ACQUIRING
        ) {
            current = req
            if (AgentState.phase == AgentState.Phase.STREAMING) {
                if (CaptureService.instance != null) CaptureService.reattachRemote(req)
                else SessionCapture.reattach(req)
            }
            Log.i(Config.TAG, "session.start reuse phase=${AgentState.phase} ws=${req.wsUrl}")
            return
        }
        current = req
        pickInput(ctx)
        AgentState.set(AgentState.Phase.ACQUIRING)
        ScreenWake.acquire(ctx)
        FaultLog.step("session.start")
        SessionDiag.emit("session.start")
        // Default capture = Accessibility takeScreenshot (JPEG, NO MediaProjection prompt).
        // MediaProjection/H.264 only behind the settings toggle (Config.mediaProjectionEnabled).
        if (Config.mediaProjectionEnabled(ctx)) {
            Log.i(Config.TAG, "session.start media projection")
            FaultLog.step("mp:request")
            requestProjection(ctx)
        } else {
            Log.i(Config.TAG, "session.start jpeg (a11y) — media projection disabled")
            FaultLog.step("jpeg:default")
            SessionCapture.start(req)
        }
    }

    fun onProjection(ctx: Context, data: Intent) {
        awaitingProjection = false
        main.removeCallbacks(projectionTimeout)
        ProjectionRequestActivity.dismiss(ctx)
        SessionCapture.stop()
        top.spaceworker.rcagent.settings.SettingsActivity.hideForRemote()
        Log.i(Config.TAG, "projection granted, start CaptureService")
        FaultLog.step("mp:granted")
        SessionDiag.emit("mp.granted")
        CaptureService.start(ctx, data)
    }

    fun onProjectionDenied() {
        awaitingProjection = false
        main.removeCallbacks(projectionTimeout)
        runCatching { ProjectionRequestActivity.dismiss(RcApplication.app) }
        val req = current
        val jpeg = req != null && ScreenshotPump.available()
        if (jpeg) {
            Log.w(Config.TAG, "projection denied, jpeg fallback")
            FaultLog.step("mp:denied jpeg")
            SessionDiag.emit("mp.denied", JSONObject().put("jpeg", true))
            SessionCapture.start(req)
        } else {
            Log.w(Config.TAG, "projection denied, no jpeg req=${req != null} a11y=${ScreenshotPump.available()}")
            fail("PROJECTION_DENIED")
        }
    }

    fun requestProjection(ctx: Context) {
        if (awaitingProjection || current == null) return
        awaitingProjection = true
        main.removeCallbacks(projectionTimeout)
        main.postDelayed(projectionTimeout, 20_000)
        if (top.spaceworker.rcagent.settings.SettingsActivity.requestCapture()) {
            FaultLog.step("mp:ask settings")
            top.spaceworker.rcagent.input.RcAccessibilityService.watchConsent()
            return
        }
        FaultLog.step("mp:ask fsi")
        ProjectionRequestActivity.launch(ctx)
        top.spaceworker.rcagent.input.RcAccessibilityService.watchConsent()
    }

    fun armProjection() {
        awaitingProjection = true
        top.spaceworker.rcagent.input.RcAccessibilityService.watchConsent()
    }

    fun fail(code: String, msg: String = "") {
        lastError = if (msg.isBlank()) code else "$code $msg"
        FaultLog.error(code, extra = msg)
        Log.e(Config.TAG, "fail $code $msg")
        SessionDiag.emit("fail", JSONObject().put("code", code).put("why", msg))
        MqttClient.publishEvent(code, msg)
        teardown("fail:$code", idle = true)
    }

    fun stop(reason: String) {
        Log.i(Config.TAG, "session.stop $reason")
        SessionDiag.emit("session.stop", JSONObject().put("why", reason))
        MqttClient.publishEvent("session.stopped", reason)
        teardown(reason, idle = true)
        skipAboveW = Int.MAX_VALUE
    }

    private fun teardown(reason: String, idle: Boolean) {
        if (stopping) return
        stopping = true
        try {
            main.removeCallbacks(projectionTimeout)
            CaptureService.stopSession()
            SessionCapture.stop()
            OverlayPoke.hide()
            ScreenWake.release()
            awaitingProjection = false
            runCatching { ProjectionRequestActivity.dismiss(RcApplication.app) }
            current = null
            if (idle &&
                AgentState.phase != AgentState.Phase.HEALING &&
                AgentState.phase != AgentState.Phase.RECONNECTING
            ) {
                AgentState.set(AgentState.Phase.IDLE)
            }
            MqttClient.publishState(retained = true)
        } finally {
            stopping = false
        }
    }

    fun onStreaming() {
        AgentState.set(AgentState.Phase.STREAMING)
    }

    fun dropLadderAndRestart(ctx: Context, failedW: Int) {
        skipAboveW = minOf(skipAboveW, failedW - 1)
        Log.w(Config.TAG, "ladder drop, skipAboveW=$skipAboveW")
        MqttClient.publishEvent("encoder.restart", "w<=$skipAboveW")
        val req = current ?: return
        CaptureService.stopSession()
        SessionCapture.stop()
        OverlayPoke.hide()
        AgentState.set(AgentState.Phase.IDLE)
        start(ctx, req)
    }

    fun pickInput(ctx: Context) {
        val knox = KnoxInputEngine(ctx)
        input = knox.takeIf { it.isAvailable() } ?: GestureInputEngine(ctx)
        Log.i(Config.TAG, "input ${input?.name}")
    }

    fun onA11yReady(ctx: Context) {
        pickInput(ctx)
        MqttClient.publishState(retained = true)
    }

    fun onA11yLost(ctx: Context) {
        MqttClient.publishState(retained = true)
        if (AgentState.phase != AgentState.Phase.STREAMING) return
        val knox = KnoxInputEngine(ctx)
        if (knox.isAvailable()) {
            input = knox
            Log.w(Config.TAG, "a11y lost, switched to knox")
        } else {
            input = null
            lastError = "NO_INPUT_PATH accessibility off"
            Log.w(Config.TAG, "a11y lost, stream continues without input")
            MqttClient.publishEvent("NO_INPUT_PATH", "accessibility off")
        }
    }

    fun handleViewerJson(raw: String) {
        val o = runCatching { JSONObject(raw) }.getOrNull() ?: return
        val t = o.optString("t")
        when (t) {
            "hello" -> {
                Log.i(Config.TAG, "hello $raw")
                SessionDiag.flush()
                SessionDiag.emit("hello")
            }
            "viewer.join" -> {
                SessionDiag.flush()
                SessionDiag.emit("viewer.join")
            }
            "quality" -> {}
            "touch", "pointer" -> {
                val action = o.optString("action").ifEmpty { o.optString("a") }
                val nx = o.optDouble("nx", o.optDouble("x")).toFloat()
                val ny = o.optDouble("ny", o.optDouble("y")).toFloat()
                val pid = o.optInt("pointerId", 0)
                val engine = input
                if (engine == null) Log.w(Config.TAG, "touch ignored — no input engine")
                else {
                    Log.i(Config.TAG, "touch ${engine.name} $action $nx,$ny")
                    engine.touch(action, nx, ny, pid)
                }
            }
            "key" -> input?.key(o.optString("k").ifEmpty { o.optString("key") })
            "text" -> input?.text(o.optString("v").ifEmpty { o.optString("text") })
            "scroll" -> {
                val nx = o.optDouble("nx", o.optDouble("x")).toFloat()
                val ny = o.optDouble("ny", o.optDouble("y")).toFloat()
                val dy = o.optDouble("dy", 0.15).toFloat()
                input?.scroll(nx, ny, dy)
            }
        }
    }
}

@SuppressLint("HardwareIds")
fun deviceId(ctx: Context): String {
    val override = top.spaceworker.rcagent.BuildConfig.DEVICE_ID
    if (override.isNotBlank()) return override
    val prefs = ctx.getSharedPreferences("rc", 0).getString("device_id", null)
    if (!prefs.isNullOrBlank()) return prefs
    return Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID) ?: "unknown"
}

fun androidId(ctx: Context): String =
    Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID) ?: ""

fun volatileOf(ctx: Context): Map<String, Any> {
    val bm = ctx.getSystemService(BatteryManager::class.java)
    val pm = ctx.getSystemService(PowerManager::class.java)
    val cm = ctx.getSystemService(ConnectivityManager::class.java)
    val nw = cm.activeNetwork
    val caps = nw?.let { cm.getNetworkCapabilities(it) }
    val net = when {
        caps == null -> "unknown"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
        else -> "unknown"
    }
    val charging = if (Build.VERSION.SDK_INT >= 26) {
        bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_STATUS).let {
            it == BatteryManager.BATTERY_STATUS_CHARGING || it == BatteryManager.BATTERY_STATUS_FULL
        } || bm.isCharging
    } else {
        bm.isCharging
    }
    return mapOf(
        "screenOn" to pm.isInteractive,
        "charging" to charging,
        "batteryPct" to bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY),
        "net" to net,
        "rssi" to rssi(ctx, net),
    )
}

private fun rssi(ctx: Context, net: String): Int {
    if (net != "wifi") return 0
    @Suppress("DEPRECATION")
    val info = ctx.applicationContext
        .getSystemService(android.net.wifi.WifiManager::class.java)
        ?.connectionInfo
    return info?.rssi ?: 0
}
