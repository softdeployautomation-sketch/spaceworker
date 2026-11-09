package top.spaceworker.rcagent.capture

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.display.DisplayManager
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.DisplayMetrics
import android.util.Log
import android.view.Display
import top.spaceworker.rcagent.R
import top.spaceworker.rcagent.core.Config
import top.spaceworker.rcagent.core.FaultLog
import top.spaceworker.rcagent.core.SessionBus
import top.spaceworker.rcagent.core.SessionDiag
import top.spaceworker.rcagent.core.SessionRequest
import top.spaceworker.rcagent.core.rotationOf
import top.spaceworker.rcagent.transport.MqttClient
import top.spaceworker.rcagent.transport.SessionSocket
import org.json.JSONObject

class CaptureService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private var mp: MediaProjection? = null
    private var encoder: Encoder? = null
    private var webrtc: WebRtcH264Encoder? = null
    private var webrtcCap: MpWebrtcCapturer? = null
    private var socket: SessionSocket? = null
    private var shot: ScreenshotPump? = null
    private var mpPump: MpJpegPump? = null
    private var lastStatsLogAt = 0L
    private var lastIdrAt = 0L
    private var kickLeft = 0
    @Volatile private var recovering = false
    private val encodedSink = FrameSink { type, ptsUs, payload ->
        socket?.onEncoded(type, ptsUs, payload)
    }
    private val silentWatch = Runnable {
        if (webrtc != null && webrtc?.gotFrame != true) {
            FaultLog.error("H264_SILENT", extra = webrtc?.codecName ?: "")
            SessionDiag.fail("H264_SILENT", webrtc?.codecName ?: "no encoded frame")
            jpegFallback("H264_SILENT")
        }
    }
    private val kickFrames = object : Runnable {
        override fun run() {
            OverlayPoke.nudge()
            webrtc?.requestKeyframe() ?: encoder?.requestKeyframe()
            kickLeft--
            if (kickLeft > 0) handler.postDelayed(this, Config.KICK_FRAME_MS)
        }
    }
    private val tick = object : Runnable {
        override fun run() {
            val rtc = webrtc
            if (rtc != null) {
                socket?.tickCongestion(rtc.bitrate, rtc::setBitrate, rtc::requestKeyframe) {
                    rtc.backlogged = it
                }
                logStats(rtc.stats(), driftMs = 0)
                val now = SystemClock.elapsedRealtime()
                if (now - lastIdrAt >= Config.iFrameSec * 1000L) {
                    rtc.requestKeyframe()
                    lastIdrAt = now
                }
            } else {
                val enc = encoder ?: return
                socket?.tickCongestion(enc)
                logStats(enc.stats(), enc.driftMs)
            }
            handler.postDelayed(this, Config.congestionTickMs)
        }
    }

    private fun logStats(s: Triple<Int, Int, Int>, driftMs: Int) {
        val now = SystemClock.uptimeMillis()
        if (now - lastStatsLogAt < 2_000L) return
        lastStatsLogAt = now
        val (fps, kbps, br) = s
        Log.i(Config.TAG, "stats fps=$fps kbps=$kbps br=$br drift=${driftMs}ms wan=${Config.wan}")
        SessionDiag.stats(fps, kbps, br, socket?.queueBytes() ?: 0, driftMs)
        if (fps < Config.encodeFps / 2) {
            OverlayPoke.nudge()
            webrtc?.requestKeyframe() ?: encoder?.requestKeyframe()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return try {
            if (intent?.action == ACTION_STOP) {
                teardown("stop")
                stopSelf()
                START_NOT_STICKY
            } else if (intent?.action == ACTION_HOLD) {
                START_NOT_STICKY
            } else if (intent?.action == ACTION_SHOT) {
                startShot()
            } else if (intent?.hasExtra(EXTRA_DATA) == true) {
                val data = projectionData(intent)
                if (data == null) {
                    jpegFallback("PROJECTION_NULL")
                    START_NOT_STICKY
                } else startProjection(data)
            } else {
                Log.w(Config.TAG, "capture start ignored action=${intent?.action}")
                START_NOT_STICKY
            }
        } catch (t: Throwable) {
            FaultLog.error("START", t, "onStartCommand")
            SessionDiag.fail("START", "onStartCommand", t)
            jpegFallback("START")
            START_NOT_STICKY
        }
    }

    private fun attachSinks(enc: Encoder, req: SessionRequest?, w: Int, h: Int) {
        val sock = openSocket(req) { enc.codecConfig } ?: return
        enc.addSink(sock)
        Log.i(Config.TAG, "sinks ws ${w}x$h")
    }

    private fun openSocket(req: SessionRequest?, config: () -> ByteArray?): SessionSocket? {
        if (req?.wsUrl.isNullOrBlank() || req?.token.isNullOrBlank()) {
            SessionBus.fail("NO_RELAY", "wsUrl/token required")
            return null
        }
        val sock = SessionSocket(req.wsUrl!!, req.token!!) { SessionBus.handleViewerJson(it) }
        sock.codecConfigProvider = config
        sock.onOpen = {
            webrtc?.requestKeyframe()
            encoder?.requestKeyframe()
            lastIdrAt = SystemClock.elapsedRealtime()
        }
        SessionDiag.sink = sock::sendText
        sock.connect()
        socket = sock
        return sock
    }

    private fun sendMeta(w: Int, h: Int, codec: String) {
        val dm = resources.displayMetrics
        val body = JSONObject()
            .put("t", "meta")
            .put("w", w)
            .put("h", h)
            .put("realW", dm.widthPixels)
            .put("realH", dm.heightPixels)
            .put("rot", rotationOf(this))
            .put("codec", codec)
            .put("dpi", dm.densityDpi)
        SessionDiag.stampMeta(body)
        socket?.sendText(body.toString())
    }

    private fun startProjection(data: Intent): Int {
        FaultLog.step("mp:startFg")
        val fgErr = runCatching { startFg(mediaProjection = true) }.exceptionOrNull()
        if (fgErr != null) {
            FaultLog.error("FGS_MP", fgErr, "startForeground mediaProjection")
            SessionDiag.fail("FGS_MP", "startForeground mediaProjection", fgErr)
            jpegFallback("FGS_MP")
            return START_NOT_STICKY
        }
        instance = this
        if (HwKillSwitch.skip(this)) {
            val why = FaultLog.faultText().take(200).ifBlank { "prefs skip_hw_h264" }
            SessionDiag.fail("skip_hw", why)
            return startJpegProjection(data, "skip_hw")
        }
        val dm = realMetrics()
        val (w, h, _) = MpJpegPump.scaled(
            dm.widthPixels,
            dm.heightPixels,
            dm.densityDpi,
            Config.maxEncodeW,
            align = 16,
        )
        val req = SessionBus.current
        if (openSocket(req) { webrtc?.codecConfig } == null) return START_NOT_STICKY
        val rtc = WebRtcH264Encoder(
            applicationContext,
            encodedSink,
            w,
            h,
            Config.maxBitrate,
            Config.encodeFps,
        )
        if (!rtc.prepareEgl()) {
            SessionDiag.fail("H264_INIT", rtc.lastError ?: "egl")
            rtc.release()
            return startJpegProjection(data, "H264_INIT")
        }
        val cap = MpWebrtcCapturer(rtc)
        if (!cap.start(this, data)) {
            SessionDiag.fail(
                if (cap.usedToken) "H264_CAP" else "H264_INIT",
                cap.lastError ?: rtc.lastError ?: "capturer",
            )
            rtc.release()
            webrtcCap = cap
            return if (cap.usedToken) {
                jpegFallback("H264_CAP")
                START_NOT_STICKY
            } else {
                cap.abandon()
                webrtcCap = null
                startJpegProjection(data, "H264_INIT")
            }
        }
        webrtc = rtc
        webrtcCap = cap
        sendMeta(w, h, Encoder.avcCodec(w, h))
        encLabel = "h264 ${rtc.codecName} ${w}x$h"
        SessionBus.onStreaming()
        kickDisplay()
        handler.removeCallbacks(tick)
        handler.removeCallbacks(silentWatch)
        handler.post(tick)
        FaultLog.step("mp:ok h264 ${rtc.codecName} ${w}x$h")
        SessionDiag.emit("mp.ok", JSONObject().put("codec", "h264").put("name", rtc.codecName).put("w", w).put("h", h))
        Log.i(Config.TAG, "media projection h264 ${rtc.codecName} ${w}x$h")
        handler.postDelayed(silentWatch, 2_000)
        return START_NOT_STICKY
    }

    private fun startJpegProjection(data: Intent, reason: String): Int {
        FaultLog.step("mp:getMediaProjection $reason")
        val mpm = getSystemService(MediaProjectionManager::class.java)
        val got = runCatching { mpm.getMediaProjection(Activity.RESULT_OK, data) }
        val proj = got.getOrNull()
        if (proj == null) {
            FaultLog.error("PROJECTION_NULL", got.exceptionOrNull(), "getMediaProjection returned null")
            SessionDiag.fail("PROJECTION_NULL", "getMediaProjection returned null", got.exceptionOrNull())
            jpegFallback("PROJECTION_NULL")
            return START_NOT_STICKY
        }
        proj.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                FaultLog.step("mp:callback onStop")
                handler.post {
                    if (ignoreProjectionStop) return@post
                    SessionBus.stop("mp_stop")
                }
            }
        }, handler)
        if (!attachJpegProjection(proj, reason)) {
            jpegFallback("MP_READER")
        }
        return START_NOT_STICKY
    }

    private fun attachJpegProjection(proj: MediaProjection, reason: String): Boolean {
        mp = proj
        val enc = Encoder()
        encoder = enc
        val dm = realMetrics()
        val maxW = if (Config.wan) Config.WAN_JPEG_W else Config.MAX_ENCODE_W
        val (w, h, dpi) = MpJpegPump.scaled(dm.widthPixels, dm.heightPixels, dm.densityDpi, maxW)
        FaultLog.step("mp:imageReader ${w}x$h dpi=$dpi")
        val pump = MpJpegPump(enc, proj, w, h, dpi)
        val startErr = runCatching { pump.start() }.exceptionOrNull()
        if (startErr != null) {
            FaultLog.error("MP_READER", startErr, "${w}x$h")
            SessionDiag.fail("MP_READER", "${w}x$h", startErr)
            return false
        }
        mpPump = pump
        val req = SessionBus.current
        if (socket == null) attachSinks(enc, req, w, h)
        else enc.addSink(socket!!)
        sendMeta(w, h, "jpeg")
        encLabel = "jpeg ${w}x$h"
        SessionBus.onStreaming()
        kickDisplay()
        handler.removeCallbacks(tick)
        handler.post(tick)
        FaultLog.step("mp:ok ${w}x$h imageReader")
        SessionDiag.emit(
            "mp.ok",
            JSONObject().put("codec", "jpeg").put("w", w).put("h", h).put("why", reason),
        )
        Log.i(Config.TAG, "media projection jpeg ${w}x$h reason=$reason")
        return true
    }

    private fun jpegFallback(reason: String) {
        if (recovering) return
        recovering = true
        ignoreProjectionStop = true
        FaultLog.step("mp:jpegFallback $reason")
        if (SessionDiag.lastFail.isBlank()) SessionDiag.fail(reason, reason)
        else SessionDiag.emit("jpeg.fallback", JSONObject().put("why", reason))
        Log.w(Config.TAG, "mp fail $reason, jpeg fallback")
        val req = SessionBus.current
        handler.removeCallbacks(tick)
        handler.removeCallbacks(kickFrames)
        handler.removeCallbacks(silentWatch)
        shot?.stop()
        shot = null
        mpPump?.stop()
        mpPump = null
        val liveMp = webrtcCap?.abandon()
        webrtc?.release()
        webrtc = null
        webrtcCap = null
        encoder?.release()
        encoder = null
        OverlayPoke.hide()
        if (liveMp != null) {
            liveMp.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() {
                    handler.post {
                        if (ignoreProjectionStop) return@post
                        SessionBus.stop("mp_stop")
                    }
                }
            }, handler)
            if (attachJpegProjection(liveMp, reason)) {
                recovering = false
                ignoreProjectionStop = false
                return
            }
            runCatching { liveMp.stop() }
        }
        SessionDiag.sink = null
        socket?.close()
        socket = null
        runCatching { mp?.stop() }
        mp = null
        encLabel = "none"
        instance = null
        FaultLog.step("idle")
        recovering = false
        ignoreProjectionStop = false
        if (req != null && ScreenshotPump.available()) SessionCapture.start(req)
        else SessionBus.fail(reason)
        stopSelf()
    }

    private fun startShot(): Int {
        startFg()
        if (shot != null) {
            instance = this
            return START_STICKY
        }
        val enc = Encoder()
        encoder = enc
        instance = this
        val dm = resources.displayMetrics
        // ponytail: skip MediaCodec buffer path — QCOM configure-in-YUV SIGSEGV kills the process on connect
        val maxW = if (Config.wan) Config.WAN_JPEG_W else Config.MAX_ENCODE_W
        val w = ((dm.widthPixels.coerceAtMost(maxW) / 2) * 2).coerceAtLeast(2)
        val h = ((dm.heightPixels * w / dm.widthPixels.coerceAtLeast(1)) / 2 * 2).coerceAtLeast(2)
        val req = SessionBus.current
        attachSinks(enc, req, w, h)
        sendMeta(w, h, "jpeg")
        encLabel = "jpeg ${w}x$h"
        shot = ScreenshotPump(enc).also { it.start() }
        SessionBus.onStreaming()
        handler.removeCallbacks(tick)
        handler.post(tick)
        Log.i(Config.TAG, "screenshot pump jpeg ${w}x$h")
        return START_STICKY
    }

    private fun startFg(mediaProjection: Boolean = false) {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(
                NotificationChannel(CH, "RC", NotificationManager.IMPORTANCE_LOW),
            )
        }
        val notif = Notification.Builder(this, CH)
            .setContentTitle(getString(R.string.fgs_title))
            .setContentText(getString(R.string.fgs_text))
            .setSmallIcon(R.drawable.ic_stat)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 29) {
            val type = if (mediaProjection) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            } else {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            }
            startForeground(NOTIF, notif, type)
        } else {
            @Suppress("DEPRECATION")
            startForeground(NOTIF, notif)
        }
    }

    private fun realMetrics(): DisplayMetrics {
        val dm = DisplayMetrics()
        val display = getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY)
        display.getRealMetrics(dm)
        return dm
    }

    private fun swapRemote(req: SessionRequest) {
        socket?.close()
        socket = null
        if (req.wsUrl.isNullOrBlank() || req.token.isNullOrBlank()) return
        val sock = SessionSocket(req.wsUrl, req.token) { SessionBus.handleViewerJson(it) }
        sock.onOpen = {
            webrtc?.requestKeyframe()
            encoder?.requestKeyframe()
            lastIdrAt = SystemClock.elapsedRealtime()
        }
        SessionDiag.sink = sock::sendText
        val rtc = webrtc
        if (rtc != null) {
            sock.codecConfigProvider = { rtc.codecConfig }
        } else {
            val enc = encoder ?: return
            enc.addSink(sock)
            sock.codecConfigProvider = { enc.codecConfig }
        }
        sock.connect()
        socket = sock
        Log.i(Config.TAG, "ws reattach ${req.wsUrl}")
    }

    private fun teardown(reason: String) {
        handler.removeCallbacks(tick)
        handler.removeCallbacks(kickFrames)
        handler.removeCallbacks(silentWatch)
        shot?.stop()
        shot = null
        mpPump?.stop()
        mpPump = null
        webrtcCap?.haltFrames()
        webrtc?.release()
        webrtc = null
        webrtcCap?.stop()
        webrtcCap = null
        Log.i(Config.TAG, "teardown $reason")
        encoder?.release()
        encoder = null
        SessionDiag.sink = null
        socket?.close()
        socket = null
        runCatching { mp?.stop() }
        mp = null
        OverlayPoke.hide()
        encLabel = "none"
        instance = null
        CapCrash.clear()
        ignoreProjectionStop = false
        recovering = false
        FaultLog.step("idle")
    }

    private fun kickDisplay() {
        handler.removeCallbacks(kickFrames)
        OverlayPoke.show(this)
        kickLeft = 3
        handler.post(kickFrames)
    }

    override fun onDestroy() {
        teardown("destroy")
        super.onDestroy()
    }

    companion object {
        private const val EXTRA_DATA = "data"
        private const val ACTION_STOP = "stop"
        private const val ACTION_SHOT = "shot"
        private const val ACTION_HOLD = "hold"
        private const val CH = "rc_capture"
        private const val NOTIF = 42

        @Volatile var instance: CaptureService? = null
            private set

        @Volatile var encLabel: String = "none"
            private set

        fun start(ctx: Context, data: Intent) {
            launch(ctx, Intent(ctx, CaptureService::class.java).putExtra(EXTRA_DATA, data))
        }

        fun startScreenshot(ctx: Context) {
            launch(ctx, Intent(ctx, CaptureService::class.java).setAction(ACTION_SHOT))
        }

        fun hold(ctx: Context) {
            Log.d(Config.TAG, "hold skipped ${ctx.packageName}")
        }

        fun stopSession() {
            val inst = instance ?: return
            inst.teardown("session")
            inst.stopSelf()
        }

        fun stopAll(@Suppress("UNUSED_PARAMETER") reason: String) {
            stopSession()
        }

        private fun projectionData(intent: Intent): Intent? {
            return if (Build.VERSION.SDK_INT >= 33) {
                intent.getParcelableExtra(EXTRA_DATA, Intent::class.java)
            } else {
                @Suppress("DEPRECATION")
                intent.getParcelableExtra(EXTRA_DATA)
            }
        }

        private fun launch(ctx: Context, i: Intent) {
            val err = runCatching {
                if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
            }.exceptionOrNull() ?: return
            Log.w(Config.TAG, "launch ${i.action}: ${err.message}")
            if (i.action != ACTION_HOLD) SessionBus.fail("FGS_START", err.message ?: "startForegroundService")
        }

        fun reattachRemote(req: SessionRequest) {
            instance?.swapRemote(req)
            instance?.kickDisplay()
        }

        @Volatile var ignoreProjectionStop = false
            private set

        fun recoverAfterCapCrash() {
            val svc = instance ?: return
            HwKillSwitch.persistSkip(svc)
            svc.jpegFallback("CAP_TEXTURE")
        }

        fun requestKeyframe() {
            instance?.webrtc?.requestKeyframe() ?: instance?.encoder?.requestKeyframe()
        }

        fun setBitrate(br: Int) {
            instance?.webrtc?.setBitrate(br) ?: instance?.encoder?.setBitrate(br)
        }
    }
}
