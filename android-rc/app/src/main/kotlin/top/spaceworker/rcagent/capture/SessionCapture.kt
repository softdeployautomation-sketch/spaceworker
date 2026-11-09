package top.spaceworker.rcagent.capture

import android.os.Handler
import android.os.Looper
import android.util.Log
import top.spaceworker.rcagent.RcApplication
import top.spaceworker.rcagent.core.Config
import top.spaceworker.rcagent.core.FaultLog
import top.spaceworker.rcagent.core.SessionBus
import top.spaceworker.rcagent.core.SessionDiag
import top.spaceworker.rcagent.core.SessionRequest
import top.spaceworker.rcagent.core.rotationOf
import top.spaceworker.rcagent.transport.SessionSocket
import org.json.JSONObject

/** JPEG stream via a11y — no CaptureService FGS (Samsung/Headwind kills mediaProjection FGS). */
object SessionCapture {
    private val main = Handler(Looper.getMainLooper())
    private var socket: SessionSocket? = null
    private var pump: ScreenshotPump? = null
    private var encoder: Encoder? = null
    private val statsTick = object : Runnable {
        override fun run() {
            val enc = encoder ?: return
            val (fps, kbps, br) = enc.stats()
            SessionDiag.stats(fps, kbps, br, socket?.queueBytes() ?: 0)
            if (fps < Config.encodeFps / 2) enc.requestKeyframe()
            main.postDelayed(this, 2_000)
        }
    }

    fun start(req: SessionRequest) {
        runCatching { startInner(req) }.onFailure {
            Log.e(Config.TAG, "session capture ${it.message}")
            FaultLog.error("CAPTURE", it, "jpeg start")
            SessionBus.fail("CAPTURE", it.message ?: "start")
        }
    }

    private fun startInner(req: SessionRequest) {
        stop()
        if (req.wsUrl.isNullOrBlank() || req.token.isNullOrBlank()) {
            SessionBus.fail("NO_RELAY", "wsUrl/token required")
            return
        }
        val enc = Encoder()
        encoder = enc
        val sock = SessionSocket(req.wsUrl, req.token) { SessionBus.handleViewerJson(it) }
        socket = sock
        SessionDiag.sink = sock::sendText
        sock.connect()
        enc.addSink(sock)
        val dm = RcApplication.app.resources.displayMetrics
        val w = ((dm.widthPixels.coerceAtMost(Config.maxEncodeW) / 2) * 2).coerceAtLeast(2)
        val h = ((dm.heightPixels * w / dm.widthPixels.coerceAtLeast(1) / 2) * 2).coerceAtLeast(2)
        pump = ScreenshotPump(enc).also { it.start() }
        sendMeta(w, h, dm.widthPixels, dm.heightPixels, dm.densityDpi)
        SessionBus.onStreaming()
        FaultLog.step("jpeg:ok ${w}x$h")
        SessionDiag.emit(
            "jpeg.ok",
            JSONObject()
                .put("w", w)
                .put("h", h)
                .put("why", SessionDiag.lastFail.ifBlank { "a11y" }),
        )
        Log.i(Config.TAG, "session capture jpeg ${w}x$h")
        main.removeCallbacks(statsTick)
        main.postDelayed(statsTick, 2_000)
    }

    fun reattach(req: SessionRequest) {
        if (req.wsUrl.isNullOrBlank() || req.token.isNullOrBlank()) return
        socket?.close()
        val enc = encoder ?: return
        val sock = SessionSocket(req.wsUrl, req.token) { SessionBus.handleViewerJson(it) }
        socket = sock
        SessionDiag.sink = sock::sendText
        sock.connect()
        enc.addSink(sock)
        Log.i(Config.TAG, "session capture reattach ${req.wsUrl}")
    }

    fun stop() {
        pump?.stop()
        pump = null
        main.removeCallbacks(statsTick)
        SessionDiag.sink = null
        socket?.close()
        socket = null
        encoder?.release()
        encoder = null
    }

    private fun sendMeta(w: Int, h: Int, realW: Int, realH: Int, dpi: Int) {
        val rot = rotationOf(RcApplication.app)
        val body = JSONObject()
            .put("t", "meta")
            .put("w", w)
            .put("h", h)
            .put("realW", realW)
            .put("realH", realH)
            .put("rot", rot)
            .put("codec", "jpeg")
            .put("dpi", dpi)
        SessionDiag.stampMeta(body)
        socket?.sendText(body.toString())
    }
}
