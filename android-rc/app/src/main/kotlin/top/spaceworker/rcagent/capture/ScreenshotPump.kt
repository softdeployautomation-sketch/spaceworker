package top.spaceworker.rcagent.capture

import android.accessibilityservice.AccessibilityService
import android.graphics.Bitmap
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Display
import top.spaceworker.rcagent.core.Config
import top.spaceworker.rcagent.input.RcAccessibilityService
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class ScreenshotPump(private val encoder: Encoder) {
    private val handler = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor { Thread(it, "rc-shot") }
    private val running = AtomicBoolean(false)
    private val inflight = AtomicBoolean(false)
    private val fails = AtomicInteger(0)
    private val jpeg = ByteArrayOutputStream(64 * 1024)
    private var ok = 0

    fun start() {
        if (!running.compareAndSet(false, true)) return
        handler.post(tick)
    }

    fun stop() {
        running.set(false)
        handler.removeCallbacks(tick)
        worker.shutdownNow()
    }

    private val tick = object : Runnable {
        override fun run() {
            if (!running.get()) return
            grab()
            handler.postDelayed(this, Config.SHOT_MS)
        }
    }

    private fun grab() {
        if (Build.VERSION.SDK_INT < 30) return
        val svc = RcAccessibilityService.instance ?: return
        if (!inflight.compareAndSet(false, true)) return
        svc.takeScreenshot(
            Display.DEFAULT_DISPLAY,
            { it.run() },
            object : AccessibilityService.TakeScreenshotCallback {
                override fun onSuccess(screenshot: AccessibilityService.ScreenshotResult) {
                    worker.execute {
                        try {
                            val hw = screenshot.hardwareBuffer
                            val copy = try {
                                val raw = Bitmap.wrapHardwareBuffer(hw, screenshot.colorSpace)
                                    ?: return@execute
                                raw.copy(Bitmap.Config.ARGB_8888, false).also { raw.recycle() }
                            } finally {
                                hw.close()
                            }
                            emit(copy)
                        } catch (t: Throwable) {
                            Log.w(Config.TAG, "shot blit: ${t.message}")
                        } finally {
                            inflight.set(false)
                        }
                    }
                }

                override fun onFailure(errorCode: Int) {
                    inflight.set(false)
                    if (errorCode == AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT) return
                    val n = fails.incrementAndGet()
                    Log.w(Config.TAG, "shot fail code=$errorCode n=$n")
                    if (n >= 12) {
                        running.set(false)
                        handler.post { top.spaceworker.rcagent.core.SessionBus.fail("SCREENSHOT", "code=$errorCode") }
                    }
                }
            },
        )
    }

    private fun emit(src: Bitmap) {
        try {
            val scaled = scale(src)
            if (scaled !== src) src.recycle()
            jpeg.reset()
            val q = if (Config.wan) 45 else 60
            scaled.compress(Bitmap.CompressFormat.JPEG, q, jpeg)
            encoder.emitJpeg(jpeg.toByteArray())
            if (encoder.bufferIn) encoder.offerBitmap(scaled) else scaled.recycle()
            val n = ok++
            if (n == 0 || n % 25 == 0) {
                Log.i(Config.TAG, "shot ok n=$n ${scaled.width}x${scaled.height} jpeg=${jpeg.size()}")
            }
            fails.set(0)
        } catch (t: Throwable) {
            src.recycle()
            Log.w(Config.TAG, "shot blit: ${t.message}")
        }
    }

    private fun scale(src: Bitmap): Bitmap {
        val maxW = Config.maxEncodeW
        if (src.width <= maxW) return src
        val w = (maxW / 2) * 2
        val h = ((src.height * w / src.width) / 2) * 2
        return Bitmap.createScaledBitmap(src, w.coerceAtLeast(2), h.coerceAtLeast(2), true)
    }

    companion object {
        fun available(): Boolean =
            Build.VERSION.SDK_INT >= 30 && RcAccessibilityService.instance != null
    }
}
