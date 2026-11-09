package top.spaceworker.rcagent.capture

import android.content.Context
import android.os.Handler
import android.os.SystemClock
import android.util.Log
import top.spaceworker.rcagent.core.Config
import top.spaceworker.rcagent.core.FaultLog
import top.spaceworker.rcagent.transport.Framing
import org.webrtc.EglBase
import org.webrtc.EncodedImage
import org.webrtc.HardwareVideoEncoderFactory
import org.webrtc.PeerConnectionFactory
import org.webrtc.VideoCodecStatus
import org.webrtc.VideoEncoder
import org.webrtc.VideoFrame
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

class WebRtcH264Encoder(
    private val app: Context,
    private val sink: FrameSink,
    val width: Int,
    val height: Int,
    initialBitrate: Int,
    private val fps: Int,
) {
    @Volatile var backlogged = false
    @Volatile var codecConfig: ByteArray? = null
        private set
    @Volatile var frames = 0
        private set
    @Volatile var gotFrame = false
        private set
    @Volatile var codecName: String? = null
        private set
    @Volatile var bitrate: Int = initialBitrate.coerceIn(Config.MIN_BITRATE, Config.maxBitrate)
        private set
    @Volatile var lastError: String? = null
        private set

    private var egl: EglBase? = null
    private var encoder: VideoEncoder? = null
    private var encodeHandler: Handler? = null
    private val needKey = AtomicBoolean(true)
    private var bytes = 0
    private var statsAt = SystemClock.elapsedRealtime()
    private var loggedOut = 0

    val eglContext: EglBase.Context? get() = egl?.eglBaseContext

    fun prepareEgl(): Boolean {
        FaultLog.step("mp:h264 init")
        val err = runCatching {
            ensureNative(app)
            egl = EglBase.create()
        }.exceptionOrNull()
        if (err != null) {
            lastError = "${err.javaClass.simpleName}: ${err.message}"
            FaultLog.error("H264_INIT", err, "egl")
            release()
            return false
        }
        return true
    }

    /** initEncode must run on the SurfaceTextureHelper thread that later calls [onFrame]. */
    fun start(handler: Handler): Boolean {
        encodeHandler = handler
        val err = AtomicReference<Throwable?>()
        val done = CountDownLatch(1)
        handler.post {
            try {
                val base = egl ?: error("egl missing")
                val factory = HardwareVideoEncoderFactory(
                    base.eglBaseContext,
                    /* enableIntelVp8Encoder = */ false,
                    /* enableH264HighProfile = */ false,
                )
                val info = factory.supportedCodecs.firstOrNull { it.name.equals("H264", true) }
                    ?: error("no H264 in HardwareVideoEncoderFactory")
                codecName = info.name
                val enc = factory.createEncoder(info) ?: error("createEncoder null")
                @Suppress("DEPRECATION")
                val settings = VideoEncoder.Settings(
                    1,
                    width,
                    height,
                    bitrate / 1000,
                    fps,
                    1,
                    false,
                )
                val st = enc.initEncode(settings, object : VideoEncoder.Callback {
                    override fun onEncodedFrame(image: EncodedImage, codecInfo: VideoEncoder.CodecSpecificInfo) {
                        emit(image)
                    }
                })
                if (st != VideoCodecStatus.OK) error("initEncode $st")
                codecName = runCatching { enc.implementationName }.getOrDefault(info.name)
                encoder = enc
            } catch (t: Throwable) {
                err.set(t)
            } finally {
                done.countDown()
            }
        }
        if (!done.await(8, TimeUnit.SECONDS)) {
            lastError = "encoder thread timeout"
            FaultLog.error("H264_INIT", extra = "encoder thread timeout")
            CapCrash.markAbandon()
            runCatching { handler.looper.quitSafely() }
            encoder = null
            encodeHandler = null
            egl = null
            return false
        }
        val t = err.get()
        if (t != null) {
            lastError = "${t.javaClass.simpleName}: ${t.message}"
            FaultLog.error("H264_INIT", t, codecName ?: "")
            release()
            return false
        }
        return true
    }

    fun onFrame(frame: VideoFrame) {
        val enc = encoder ?: return
        val types = if (needKey.getAndSet(false)) {
            arrayOf(EncodedImage.FrameType.VideoFrameKey)
        } else {
            arrayOf(EncodedImage.FrameType.VideoFrameDelta)
        }
        val st = runCatching { enc.encode(frame, VideoEncoder.EncodeInfo(types)) }.getOrNull()
        if (st != null && st != VideoCodecStatus.OK) lastError = "encode $st"
    }

    fun setBitrate(br: Int) {
        val next = br.coerceIn(Config.MIN_BITRATE, Config.maxBitrate)
        bitrate = next
        val enc = encoder ?: return
        val h = encodeHandler
        val run = Runnable {
            enc.setRateAllocation(
                VideoEncoder.BitrateAllocation(arrayOf(intArrayOf(next))),
                fps,
            )
        }
        if (h != null) h.post(run) else run.run()
    }

    fun requestKeyframe() {
        needKey.set(true)
    }

    fun stats(): Triple<Int, Int, Int> {
        val now = SystemClock.elapsedRealtime()
        val dt = (now - statsAt).coerceAtLeast(1)
        val fpsNow = (frames * 1000 / dt).toInt()
        val kbps = ((bytes * 8) / dt).toInt()
        frames = 0
        bytes = 0
        statsAt = now
        return Triple(fpsNow, kbps, bitrate)
    }

    fun release() {
        val h = encodeHandler
        val done = CountDownLatch(1)
        val stop = Runnable {
            runCatching { encoder?.release() }
            encoder = null
            runCatching { egl?.release() }
            egl = null
            done.countDown()
        }
        if (h != null && CapCrash.canWaitOnHelper(h.looper.thread.isAlive)) {
            h.post(stop)
            runCatching { done.await(2, TimeUnit.SECONDS) }
        } else {
            encoder = null
            egl = null
        }
        encodeHandler = null
    }

    private fun emit(image: EncodedImage) {
        val buf = image.buffer ?: return
        val payload = ByteArray(buf.remaining())
        buf.duplicate().get(payload)
        val declaredKey = image.frameType == EncodedImage.FrameType.VideoFrameKey
        val type = Framing.typeOfH264(declaredKey, payload)
        val ptsUs = if (image.captureTimeNs > 0) image.captureTimeNs / 1000
        else SystemClock.elapsedRealtimeNanos() / 1000
        if (type == Framing.TYPE_CONFIG) codecConfig = Framing.pack(type, 0, payload)
        if (type == Framing.TYPE_DELTA && backlogged) return
        if (type != Framing.TYPE_CONFIG) {
            frames++
            gotFrame = true
        }
        bytes += payload.size
        if (loggedOut < 4) {
            loggedOut++
            Log.i(Config.TAG, "h264 out type=$type n=${payload.size} key=$declaredKey")
        }
        sink.onEncoded(type, ptsUs, payload)
    }

    companion object {
        private val nativeReady = AtomicBoolean(false)

        fun ensureNative(app: Context) {
            if (!nativeReady.compareAndSet(false, true)) return
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(app)
                    .setEnableInternalTracer(false)
                    .createInitializationOptions(),
            )
        }
    }
}
