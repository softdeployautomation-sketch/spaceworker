package top.spaceworker.rcagent.capture

import android.graphics.Bitmap
import android.media.Image
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.media.projection.MediaProjection
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Surface
import top.spaceworker.rcagent.core.Config
import top.spaceworker.rcagent.core.EncoderInfo
import top.spaceworker.rcagent.core.FaultLog
import top.spaceworker.rcagent.core.SessionBus
import top.spaceworker.rcagent.transport.Framing
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

fun interface FrameSink {
    fun onEncoded(type: Byte, ptsUs: Long, payload: ByteArray)
}

/** Spec §8.4 / §11: missed keyframe *request* → restart encoder, same config. */
object KeyframeWatchdog {
    fun restartNeeded(nowMs: Long, deadlineMs: Long): Boolean =
        deadlineMs != 0L && nowMs > deadlineMs + Config.KEYFRAME_WATCHDOG_MS
}

data class Rung(val w: Int, val h: Int, val br: Int)

class Encoder {
    data class Started(
        val codec: MediaCodec,
        val vd: VirtualDisplay?,
        val surface: Surface?,
        val w: Int,
        val h: Int,
        var bitrate: Int,
        val name: String,
        val hw: Boolean,
        val bufferIn: Boolean = false,
        val color: Int = 0,
    )

    private val main = Handler(Looper.getMainLooper())
    private var started: Started? = null
    private val sinks = mutableListOf<FrameSink>()
    private val inputIdx = ConcurrentLinkedQueue<Int>()
    private val pendingBmp = AtomicReference<Bitmap?>(null)
    private val needKey = AtomicBoolean(true)
    @Volatile private var keyframeDeadline = 0L
    @Volatile private var originPtsUs = 0L
    @Volatile private var originWallUs = 0L
    @Volatile var driftMs: Int = 0
        private set
    @Volatile var codecConfig: ByteArray? = null
        private set
    @Volatile var lastKeyPayload: ByteArray? = null
        private set
    @Volatile var backlogged = false
    private var frames = 0
    private var bytes = 0
    private var statsAt = SystemClock.elapsedRealtime()

    val width get() = started?.w ?: 0
    val height get() = started?.h ?: 0
    val bitrate get() = started?.bitrate ?: 0
    val codecName get() = started?.name
    val bufferIn get() = started?.bufferIn == true

    fun addSink(s: FrameSink) {
        synchronized(sinks) { sinks += s }
    }

    fun emitJpeg(jpeg: ByteArray) {
        frames++
        bytes += jpeg.size
        val pts = SystemClock.elapsedRealtimeNanos() / 1000
        synchronized(sinks) { sinks.toList() }.forEach { it.onEncoded(Framing.TYPE_JPEG, pts, jpeg) }
    }

    fun startWithFallback(
        mp: MediaProjection?,
        dpi: Int,
        skipAboveW: Int = Int.MAX_VALUE,
        realW: Int,
        realH: Int,
    ): Started? {
        val ladder = ladderFor(realW, realH, Config.maxEncodeW, Config.wan)
        for (info in candidates(MediaFormat.MIMETYPE_VIDEO_AVC)) {
            val vc = info.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC).videoCapabilities
                ?: continue
            for ((w, h, br) in ladder) {
                if (w > skipAboveW) continue
                val aw = (w / vc.widthAlignment) * vc.widthAlignment
                val ah = (h / vc.heightAlignment) * vc.heightAlignment
                if (aw < 16 || ah < 16 || !vc.isSizeSupported(aw, ah)) continue
                val bitrate = br.coerceIn(vc.bitrateRange.lower, vc.bitrateRange.upper)
                var codec: MediaCodec? = null
                var surface: Surface? = null
                val result = runCatching {
                    FaultLog.step("mp:codec ${info.name} ${aw}x$ah")
                    codec = MediaCodec.createByCodecName(info.name)
                    codec!!.configure(buildFormat(aw, ah, bitrate, Config.wan), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                    surface = codec!!.createInputSurface()
                    codec!!.setCallback(cb)
                    codec!!.start()
                    FaultLog.step("mp:virtualDisplay ${aw}x$ah")
                    val vd = mp?.createVirtualDisplay(
                        "rc",
                        aw,
                        ah,
                        dpi,
                        DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                        surface,
                        null,
                        null,
                    )
                    val hw = Build.VERSION.SDK_INT < 29 || info.isHardwareAccelerated
                    cachedInfo = EncoderInfo(info.name, hw)
                    Log.i(Config.TAG, "encoder ${info.name} hw=$hw ${aw}x$ah br=$bitrate wan=${Config.wan} fps=${Config.encodeFps}")
                    Started(codec!!, vd, surface!!, aw, ah, bitrate, info.name, hw)
                }
                val s = result.getOrNull()
                if (s != null) {
                    started = s
                    originPtsUs = 0
                    originWallUs = 0
                    driftMs = 0
                    return s
                }
                runCatching { codec?.stop() }
                runCatching { codec?.release() }
                runCatching { surface?.release() }
                Log.w(Config.TAG, "fail ${info.name} @${aw}x$ah: ${result.exceptionOrNull()?.message}")
                FaultLog.error(
                    "ENCODER_FAIL",
                    result.exceptionOrNull(),
                    "${info.name} ${aw}x$ah br=$bitrate",
                )
            }
        }
        return null
    }

    fun startBuffer(realW: Int, realH: Int, skipAboveW: Int = Int.MAX_VALUE): Started? {
        val ladder = ladderFor(realW, realH, Config.maxEncodeW, Config.wan)
        val mime = MediaFormat.MIMETYPE_VIDEO_AVC
        for (info in candidates(mime)) {
            val caps = info.getCapabilitiesForType(mime)
            val vc = caps.videoCapabilities ?: continue
            val color = pickYuv(caps.colorFormats) ?: continue
            for ((w, h, br) in ladder) {
                if (w > skipAboveW) continue
                val aw = (w / vc.widthAlignment) * vc.widthAlignment
                val ah = (h / vc.heightAlignment) * vc.heightAlignment
                if (aw < 16 || ah < 16 || !vc.isSizeSupported(aw, ah)) continue
                val bitrate = br.coerceIn(vc.bitrateRange.lower, vc.bitrateRange.upper)
                var codec: MediaCodec? = null
                val result = runCatching {
                    codec = MediaCodec.createByCodecName(info.name)
                    codec!!.setCallback(cb)
                    codec!!.configure(buildBufferFormat(aw, ah, bitrate, color), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                    codec!!.start()
                    val hw = Build.VERSION.SDK_INT < 29 || info.isHardwareAccelerated
                    cachedInfo = EncoderInfo(info.name, hw)
                    Log.i(Config.TAG, "buffer encoder ${info.name} hw=$hw ${aw}x$ah color=$color br=$bitrate")
                    Started(codec!!, null, null, aw, ah, bitrate, info.name, hw, bufferIn = true, color = color)
                }
                val s = result.getOrNull()
                if (s != null) {
                    started = s
                    originPtsUs = 0
                    originWallUs = 0
                    driftMs = 0
                    needKey.set(true)
                    inputIdx.clear()
                    return s
                }
                runCatching { codec?.stop() }
                runCatching { codec?.release() }
                Log.w(Config.TAG, "buffer fail ${info.name} @${aw}x$ah: ${result.exceptionOrNull()?.message}")
            }
        }
        return null
    }

    fun restartSameConfig(): Boolean {
        val s = started ?: return false
        if (s.bufferIn) return restartBuffer(s)
        var codec: MediaCodec? = null
        var surface: Surface? = null
        val result = runCatching {
            codec = MediaCodec.createByCodecName(s.name)
            codec!!.configure(buildFormat(s.w, s.h, s.bitrate, Config.wan), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            surface = codec!!.createInputSurface()
            codec!!.setCallback(cb)
            codec!!.start()
            s.vd?.setSurface(surface)
        }
        if (result.isFailure) {
            Log.w(Config.TAG, "restartSameConfig: ${result.exceptionOrNull()?.message}")
            runCatching { codec?.stop() }
            runCatching { codec?.release() }
            runCatching { surface?.release() }
            return false
        }
        runCatching { s.codec.stop() }
        runCatching { s.codec.release() }
        runCatching { s.surface?.release() }
        started = s.copy(codec = codec!!, surface = surface!!)
        originPtsUs = 0
        originWallUs = 0
        driftMs = 0
        keyframeDeadline = 0
        lastKeyPayload = null
        Log.i(Config.TAG, "encoder restarted same ${s.w}x${s.h} vd kept")
        return true
    }

    private fun restartBuffer(s: Started): Boolean {
        var codec: MediaCodec? = null
        val result = runCatching {
            codec = MediaCodec.createByCodecName(s.name)
            codec!!.setCallback(cb)
            codec!!.configure(buildBufferFormat(s.w, s.h, s.bitrate, s.color), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            codec!!.start()
        }
        if (result.isFailure) {
            Log.w(Config.TAG, "restartBuffer: ${result.exceptionOrNull()?.message}")
            runCatching { codec?.stop() }
            runCatching { codec?.release() }
            return false
        }
        inputIdx.clear()
        runCatching { s.codec.stop() }
        runCatching { s.codec.release() }
        started = s.copy(codec = codec!!)
        originPtsUs = 0
        originWallUs = 0
        driftMs = 0
        keyframeDeadline = 0
        lastKeyPayload = null
        needKey.set(true)
        Log.i(Config.TAG, "buffer encoder restarted ${s.w}x${s.h}")
        return true
    }

    fun requestKeyframe() {
        needKey.set(true)
        val c = started?.codec ?: return
        runCatching {
            c.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) })
        }
        keyframeDeadline = SystemClock.uptimeMillis() + Config.KEYFRAME_DEADLINE_MS
    }

    fun setBitrate(br: Int) {
        val s = started ?: return
        val next = br.coerceIn(Config.MIN_BITRATE, Config.maxBitrate)
        if (next == s.bitrate) return
        s.bitrate = next
        runCatching {
            s.codec.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, next) })
        }
        Log.i(Config.TAG, "bitrate $next")
    }

    fun tickWatchdog(): Boolean {
        val now = SystemClock.uptimeMillis()
        if (!KeyframeWatchdog.restartNeeded(now, keyframeDeadline)) return false
        keyframeDeadline = 0
        return true
    }

    private fun notePts(ptsUs: Long) {
        val wall = SystemClock.elapsedRealtimeNanos() / 1000
        if (originPtsUs == 0L) {
            originPtsUs = ptsUs
            originWallUs = wall
            driftMs = 0
            return
        }
        driftMs = (((wall - originWallUs) - (ptsUs - originPtsUs)) / 1000L).toInt()
    }

    fun stats(): Triple<Int, Int, Int> {
        val now = SystemClock.elapsedRealtime()
        val dt = (now - statsAt).coerceAtLeast(1)
        val fps = (frames * 1000 / dt).toInt()
        val kbps = ((bytes * 8) / dt).toInt()
        frames = 0
        bytes = 0
        statsAt = now
        return Triple(fps, kbps, started?.bitrate ?: 0)
    }

    fun offerBitmap(bmp: Bitmap) {
        if (started?.bufferIn != true) {
            bmp.recycle()
            return
        }
        pendingBmp.getAndSet(bmp)?.recycle()
        drainInput()
    }

    fun blit(bmp: Bitmap) {
        val s = started ?: return
        val surface = s.surface ?: return
        val canvas = runCatching { surface.lockHardwareCanvas() }.getOrNull()
            ?: runCatching { surface.lockCanvas(null) }.getOrNull()
            ?: return
        try {
            canvas.drawColor(android.graphics.Color.BLACK)
            val sx = s.w.toFloat() / bmp.width
            val sy = s.h.toFloat() / bmp.height
            val scale = minOf(sx, sy)
            val dx = (s.w - bmp.width * scale) / 2f
            val dy = (s.h - bmp.height * scale) / 2f
            val m = android.graphics.Matrix().apply {
                setScale(scale, scale)
                postTranslate(dx, dy)
            }
            canvas.drawBitmap(bmp, m, null)
        } finally {
            runCatching { surface.unlockCanvasAndPost(canvas) }
        }
    }

    fun release() {
        val s = started ?: return
        started = null
        pendingBmp.getAndSet(null)?.recycle()
        inputIdx.clear()
        runCatching { s.vd?.release() }
        runCatching { s.codec.stop() }
        runCatching { s.codec.release() }
        runCatching { s.surface?.release() }
    }

    @Synchronized
    private fun drainInput() {
        val s = started ?: return
        if (!s.bufferIn) return
        while (true) {
            val idx = inputIdx.peek() ?: return
            val bmp = pendingBmp.getAndSet(null) ?: return
            inputIdx.poll() ?: run {
                pendingBmp.set(bmp)
                return
            }
            val ok = runCatching { queueYuv(s, idx, bmp) }.onFailure {
                Log.w(Config.TAG, "queueYuv: ${it.message}")
                runCatching { s.codec.queueInputBuffer(idx, 0, 0, 0, 0) }
            }
            bmp.recycle()
            if (ok.isFailure) return
        }
    }

    private fun queueYuv(s: Started, idx: Int, bmp: Bitmap) {
        val scaled = if (bmp.width == s.w && bmp.height == s.h) bmp
        else Bitmap.createScaledBitmap(bmp, s.w, s.h, true)
        try {
            val img = runCatching { s.codec.getInputImage(idx) }.getOrNull()
            val n = if (img != null) {
                fillImage(img, scaled)
                s.w * s.h * 3 / 2
            } else {
                val buf = s.codec.getInputBuffer(idx) ?: return
                buf.clear()
                packNv12(scaled, s.w, s.h, buf)
            }
            val pts = SystemClock.elapsedRealtimeNanos() / 1000
            val flags = if (needKey.getAndSet(false)) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0
            s.codec.queueInputBuffer(idx, 0, n, pts, flags)
        } finally {
            if (scaled !== bmp) scaled.recycle()
        }
    }

    private val cb = object : MediaCodec.Callback() {
        override fun onInputBufferAvailable(codec: MediaCodec, index: Int) {
            if (started?.bufferIn != true) return
            inputIdx.add(index)
            drainInput()
        }

        override fun onOutputBufferAvailable(codec: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
            val buf: ByteBuffer = codec.getOutputBuffer(index) ?: run {
                codec.releaseOutputBuffer(index, false)
                return
            }
            val payload = ByteArray(info.size)
            buf.position(info.offset)
            buf.limit(info.offset + info.size)
            buf.get(payload)
            codec.releaseOutputBuffer(index, false)
            var type = Framing.typeOf(info.flags)
            if (type == Framing.TYPE_DELTA && Framing.isAvcIdr(payload)) type = Framing.TYPE_KEY
            if (type == Framing.TYPE_CONFIG) codecConfig = Framing.pack(type, 0, payload)
            if (type == Framing.TYPE_KEY) {
                lastKeyPayload = payload
                keyframeDeadline = 0
            }
            frames++
            bytes += payload.size
            val wallPts = SystemClock.elapsedRealtimeNanos() / 1000
            val codecPts = if (info.presentationTimeUs > 0) info.presentationTimeUs else wallPts
            notePts(codecPts)
            synchronized(sinks) { sinks.toList() }.forEach { it.onEncoded(type, wallPts, payload) }
        }

        override fun onError(codec: MediaCodec, e: MediaCodec.CodecException) {
            Log.e(Config.TAG, "codec ${e.message}")
            FaultLog.error("CODEC", e, "isRecoverable=${e.isRecoverable} isTransient=${e.isTransient}")
            val w = started?.w ?: 0
            main.post { SessionBus.dropLadderAndRestart(top.spaceworker.rcagent.RcApplication.app, w) }
        }

        override fun onOutputFormatChanged(codec: MediaCodec, format: MediaFormat) {
            Log.i(Config.TAG, "format $format")
        }
    }

    companion object {
        @Volatile var cachedInfo: EncoderInfo? = null

        fun bitrateFor(w: Int, h: Int, wan: Boolean = false): Int {
            val refBr = if (wan) 800_000L else 1_500_000L
            val refArea = if (wan) 480L * 864 else 720L * 1152
            val cap = if (wan) Config.WAN_MAX_BITRATE else Config.MAX_BITRATE
            return (refBr * w * h / refArea).toInt().coerceIn(Config.MIN_BITRATE, cap)
        }

        /** Never encode native panel size — cap width at maxW. */
        fun ladderFor(
            realW: Int,
            realH: Int,
            maxW: Int = Config.MAX_ENCODE_W,
            wan: Boolean = false,
        ): List<Rung> {
            val rw = realW.coerceAtLeast(16)
            val caps = if (wan) listOf(maxW) else listOf(maxW, 640, 480)
            return caps.mapNotNull { capW ->
                val s = (capW.toFloat() / rw).coerceAtMost(1f)
                val w = ((rw * s).toInt() / 16) * 16
                val h = ((realH * s).toInt() / 16) * 16
                if (w < 320 || h < 320) null else Rung(w, h, bitrateFor(w, h, wan))
            }.distinctBy { it.w to it.h }
        }

        fun avcCodec(w: Int, h: Int): String {
            val mbs = (w / 16) * (h / 16)
            val level = when {
                mbs <= 1620 -> 0x1E
                mbs <= 5120 -> 0x1F
                mbs <= 8192 -> 0x28
                mbs <= 22080 -> 0x32
                else -> 0x33
            }
            return "avc1.42E0%02X".format(level)
        }

        private fun avcLevel(w: Int, h: Int): Int {
            val mbs = (w / 16) * (h / 16)
            return when {
                mbs <= 1620 -> MediaCodecInfo.CodecProfileLevel.AVCLevel3
                mbs <= 5120 -> MediaCodecInfo.CodecProfileLevel.AVCLevel31
                mbs <= 8192 -> MediaCodecInfo.CodecProfileLevel.AVCLevel4
                mbs <= 22080 -> MediaCodecInfo.CodecProfileLevel.AVCLevel5
                else -> MediaCodecInfo.CodecProfileLevel.AVCLevel51
            }
        }

        private fun candidates(mime: String): List<MediaCodecInfo> =
            MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos
                .filter { it.isEncoder && it.supportedTypes.any { t -> t.equals(mime, true) } }
                .sortedWith(
                    compareByDescending<MediaCodecInfo> {
                        if (Build.VERSION.SDK_INT >= 29) it.isHardwareAccelerated
                        else !(it.name.startsWith("OMX.google.") || it.name.startsWith("c2.android."))
                    }.thenBy { if (Build.VERSION.SDK_INT >= 29 && it.isAlias) 1 else 0 },
                )

        private fun pickYuv(colors: IntArray): Int? {
            val prefer = intArrayOf(
                MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible,
                MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420SemiPlanar,
                MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Planar,
            )
            return prefer.firstOrNull { c -> colors.any { it == c } }
        }

        private fun fillImage(img: Image, bmp: Bitmap) {
            val w = img.width
            val h = img.height
            val px = IntArray(w * h)
            bmp.getPixels(px, 0, w, 0, 0, w, h)
            val yPlane = img.planes[0]
            val yBuf = yPlane.buffer
            val yStride = yPlane.rowStride
            for (row in 0 until h) {
                var o = row * yStride
                var p = row * w
                for (col in 0 until w) {
                    val c = px[p++]
                    val r = (c ushr 16) and 255
                    val g = (c ushr 8) and 255
                    val b = c and 255
                    yBuf.put(o++, (((66 * r + 129 * g + 25 * b + 128) shr 8) + 16).coerceIn(16, 235).toByte())
                }
            }
            if (img.planes.size < 2) return
            val u = img.planes[1]
            val v = if (img.planes.size > 2) img.planes[2] else null
            val ub = u.buffer
            val vb = v?.buffer
            val uStride = u.rowStride
            val vStride = v?.rowStride ?: uStride
            val uPix = u.pixelStride
            val vPix = v?.pixelStride ?: uPix
            for (row in 0 until h step 2) {
                for (col in 0 until w step 2) {
                    val c = px[row * w + col]
                    val r = (c ushr 16) and 255
                    val g = (c ushr 8) and 255
                    val b = c and 255
                    val uu = (((-38 * r - 74 * g + 112 * b + 128) shr 8) + 128).coerceIn(16, 240).toByte()
                    val vv = (((112 * r - 94 * g - 18 * b + 128) shr 8) + 128).coerceIn(16, 240).toByte()
                    ub.put(row / 2 * uStride + (col / 2) * uPix, uu)
                    vb?.put(row / 2 * vStride + (col / 2) * vPix, vv)
                }
            }
        }

        private fun packNv12(bmp: Bitmap, w: Int, h: Int, out: ByteBuffer): Int {
            val px = IntArray(w * h)
            bmp.getPixels(px, 0, w, 0, 0, w, h)
            val ySize = w * h
            for (i in 0 until ySize) {
                val c = px[i]
                val r = (c ushr 16) and 255
                val g = (c ushr 8) and 255
                val b = c and 255
                out.put((((66 * r + 129 * g + 25 * b + 128) shr 8) + 16).coerceIn(16, 235).toByte())
            }
            for (row in 0 until h step 2) {
                for (col in 0 until w step 2) {
                    val c = px[row * w + col]
                    val r = (c ushr 16) and 255
                    val g = (c ushr 8) and 255
                    val b = c and 255
                    out.put((((-38 * r - 74 * g + 112 * b + 128) shr 8) + 128).coerceIn(16, 240).toByte())
                    out.put((((112 * r - 94 * g - 18 * b + 128) shr 8) + 128).coerceIn(16, 240).toByte())
                }
            }
            return ySize * 3 / 2
        }

        fun buildFormat(w: Int, h: Int, bitrate: Int, wan: Boolean = false): MediaFormat =
            MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h).apply {
                setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
                setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
                setInteger(MediaFormat.KEY_FRAME_RATE, if (wan) Config.WAN_FPS else Config.DEFAULT_FPS)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, if (wan) Config.WAN_I_FRAME_SEC else Config.I_FRAME_SEC)
                setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR)
                setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline)
                setInteger(MediaFormat.KEY_LEVEL, avcLevel(w, h))
                setInteger(MediaFormat.KEY_PRIORITY, 0)
                setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, if (wan) 400_000L else 200_000L)
                if (Build.VERSION.SDK_INT >= 30) {
                    runCatching { setInteger(MediaFormat.KEY_LATENCY, 1) }
                    runCatching { setInteger(MediaFormat.KEY_LOW_LATENCY, 1) }
                }
                runCatching { setInteger("vendor.qti-ext-enc-low-latency.enable", 1) }
                runCatching { setInteger("vendor.rtc-ext-enc-low-latency.enable", 1) }
            }

        private fun buildBufferFormat(w: Int, h: Int, bitrate: Int, color: Int): MediaFormat =
            MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h).apply {
                setInteger(MediaFormat.KEY_COLOR_FORMAT, color)
                setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
                setInteger(MediaFormat.KEY_FRAME_RATE, 5)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
                setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR)
                setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline)
                setInteger(MediaFormat.KEY_LEVEL, avcLevel(w, h))
            }
    }
}
