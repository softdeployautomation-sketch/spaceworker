package top.spaceworker.rcagent.capture

import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import top.spaceworker.rcagent.core.Config
import top.spaceworker.rcagent.core.FaultLog
import java.io.ByteArrayOutputStream
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/** RustDesk path: VirtualDisplay → ImageReader RGBA, not MediaCodec surface (QCOM SIGSEGV). */
class MpJpegPump(
    private val encoder: Encoder,
    private val mp: MediaProjection,
    private val w: Int,
    private val h: Int,
    private val dpi: Int,
) {
    private val running = AtomicBoolean(false)
    private val jpeg = ByteArrayOutputStream(64 * 1024)
    private val ok = AtomicInteger(0)
    private var lastEmit = 0L
    private var reusable: Bitmap? = null
    private var thread: HandlerThread? = null
    private var reader: ImageReader? = null
    private var vd: VirtualDisplay? = null

    fun start() {
        if (!running.compareAndSet(false, true)) return
        val ht = HandlerThread("rc-mp").also { it.start(); thread = it }
        val handler = Handler(ht.looper)
        val ir = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2)
        reader = ir
        ir.setOnImageAvailableListener({ r ->
            runCatching { onImage(r) }.onFailure { FaultLog.error("MP_FRAME", it, "${w}x$h") }
        }, handler)
        FaultLog.step("mp:virtualDisplay ${w}x$h dpi=$dpi")
        vd = mp.createVirtualDisplay(
            "rc",
            w,
            h,
            dpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            ir.surface,
            null,
            null,
        )
        Log.i(Config.TAG, "mp ImageReader ${w}x$h dpi=$dpi")
    }

    fun stop() {
        running.set(false)
        runCatching { vd?.release() }
        vd = null
        runCatching { reader?.close() }
        reader = null
        reusable?.recycle()
        reusable = null
        thread?.quitSafely()
        thread = null
    }

    private fun onImage(r: ImageReader) {
        val image = r.acquireLatestImage() ?: return
        image.use {
            if (!running.get()) return
            if (encoder.backlogged) return
            val now = SystemClock.uptimeMillis()
            val gap = if (Config.wan) Config.WAN_JPEG_GAP_MS else Config.LAN_JPEG_GAP_MS
            if (now - lastEmit < gap) return
            lastEmit = now
            val bmp = copyRgba(it, reusable)
            reusable = bmp
            jpeg.reset()
            val q = if (Config.wan) Config.WAN_JPEG_Q else Config.LAN_JPEG_Q
            bmp.compress(Bitmap.CompressFormat.JPEG, q, jpeg)
            encoder.emitJpeg(jpeg.toByteArray())
            val n = ok.incrementAndGet()
            if (n == 1) FaultLog.step("mp:frame ${w}x$h jpeg=${jpeg.size()}")
            if (n == 1 || n % 50 == 0) {
                Log.i(Config.TAG, "mp jpeg n=$n ${w}x$h bytes=${jpeg.size()}")
            }
        }
    }

    companion object {
        fun scaled(realW: Int, realH: Int, dpi: Int, maxW: Int, align: Int = 2): Triple<Int, Int, Int> {
            val a = align.coerceAtLeast(2)
            val scale = (realW.toFloat() / maxW.coerceAtLeast(a)).coerceAtLeast(1f)
            val w = ((realW / scale).toInt() / a * a).coerceAtLeast(a)
            val h = ((realH / scale).toInt() / a * a).coerceAtLeast(a)
            val d = (dpi / scale).toInt().coerceAtLeast(120)
            return Triple(w, h, d)
        }

        fun copyRgba(image: Image, reuse: Bitmap?): Bitmap {
            val w = image.width
            val h = image.height
            val plane = image.planes[0]
            val buf = plane.buffer
            val pixelStride = plane.pixelStride
            val rowStride = plane.rowStride
            val padding = rowStride - pixelStride * w
            val fullW = w + padding / pixelStride.coerceAtLeast(1)
            val bmp = if (reuse != null && reuse.width == fullW && reuse.height == h) reuse
            else {
                reuse?.recycle()
                Bitmap.createBitmap(fullW, h, Bitmap.Config.ARGB_8888)
            }
            buf.rewind()
            bmp.copyPixelsFromBuffer(buf)
            if (padding == 0) return bmp
            return Bitmap.createBitmap(bmp, 0, 0, w, h).also { if (it !== bmp) bmp.recycle() }
        }
    }
}
