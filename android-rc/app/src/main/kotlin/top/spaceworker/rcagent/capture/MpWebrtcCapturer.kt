package top.spaceworker.rcagent.capture

import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
import android.os.Handler
import android.os.Looper
import top.spaceworker.rcagent.core.Config
import top.spaceworker.rcagent.core.FaultLog
import top.spaceworker.rcagent.core.SessionBus
import org.webrtc.CapturerObserver
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoCapturer
import org.webrtc.VideoFrame

class MpWebrtcCapturer(
    private val encoder: WebRtcH264Encoder,
) {
    private val main = Handler(Looper.getMainLooper())
    private var helper: SurfaceTextureHelper? = null
    private var capturer: VideoCapturer? = null
    /** True if ScreenCapturerAndroid.startCapture ran (token may be spent). */
    var usedToken = false
        private set
    @Volatile var lastError: String? = null
        private set

    fun start(ctx: Context, data: Intent): Boolean {
        CapCrash.clear()
        val egl = encoder.eglContext
        if (egl == null) {
            lastError = "egl missing"
            return false
        }
        val helper = SurfaceTextureHelper.create("rc-cap", egl)
        this.helper = helper
        if (!encoder.start(helper.handler)) {
            lastError = encoder.lastError ?: "initEncode"
            return false
        }
        val cap = ScreenCapturerAndroid(data, object : MediaProjection.Callback() {
            override fun onStop() {
                FaultLog.step("mp:callback onStop")
                main.post {
                    if (CaptureService.ignoreProjectionStop) return@post
                    SessionBus.stop("mp_stop")
                }
            }
        })
        capturer = cap
        val err = runCatching {
            cap.initialize(helper, ctx, object : CapturerObserver {
                override fun onCapturerStarted(success: Boolean) {
                    if (!success) {
                        lastError = "capturer started false"
                        FaultLog.error("H264_INIT", extra = "capturer started false")
                    }
                }
                override fun onCapturerStopped() {}
                override fun onFrameCaptured(frame: VideoFrame) {
                    encoder.onFrame(frame)
                }
            })
            usedToken = true
            cap.startCapture(encoder.width, encoder.height, Config.encodeFps)
        }.exceptionOrNull()
        if (err != null) {
            lastError = "${err.javaClass.simpleName}: ${err.message}"
            FaultLog.error("H264_INIT", err, "ScreenCapturerAndroid")
            return false
        }
        return true
    }

    /** Stop producing frames. Never call if [CapCrash.canWaitOnHelper] is false. */
    fun haltFrames() {
        if (!CapCrash.canWaitOnHelper(helperAlive())) return
        runCatching { capturer?.stopCapture() }
    }

    fun stop() {
        if (!CapCrash.canWaitOnHelper(helperAlive())) {
            abandon()
            return
        }
        haltFrames()
        runCatching { capturer?.dispose() }
        capturer = null
        runCatching { helper?.dispose() }
        helper = null
    }

    /**
     * Drop WebRTC without posting to `rc-cap`. Returns the live MediaProjection if any
     * so JPEG can reuse it; caller must [MediaProjection.stop] if unused.
     */
    fun abandon(): MediaProjection? {
        CapCrash.markAbandon()
        val cap = capturer as? ScreenCapturerAndroid
        capturer = null
        val proj = runCatching { cap?.mediaProjection }.getOrNull()
        runCatching { helper?.handler?.looper?.quitSafely() }
        helper = null
        return proj
    }

    private fun helperAlive(): Boolean =
        helper?.handler?.looper?.thread?.isAlive == true
}
