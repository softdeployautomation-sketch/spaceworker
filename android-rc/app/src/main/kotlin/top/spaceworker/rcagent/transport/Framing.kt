package top.spaceworker.rcagent.transport

import android.os.SystemClock
import top.spaceworker.rcagent.core.Config
import kotlin.random.Random
import kotlin.math.min

object Framing {
    const val TYPE_CONFIG: Byte = 0x01
    const val TYPE_KEY: Byte = 0x02
    const val TYPE_DELTA: Byte = 0x03
    const val TYPE_JPEG: Byte = 0x04

    fun typeOf(flags: Int): Byte = when {
        flags and android.media.MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0 -> TYPE_CONFIG
        flags and android.media.MediaCodec.BUFFER_FLAG_KEY_FRAME != 0 -> TYPE_KEY
        else -> TYPE_DELTA
    }

    /** QCOM often omits BUFFER_FLAG_KEY_FRAME; IDR is NAL type 5. */
    fun isAvcIdr(payload: ByteArray): Boolean = nalTypes(payload).any { it == 5 }

    fun hasSliceNal(payload: ByteArray): Boolean = nalTypes(payload).any { it in 1..5 }

    fun startsWithSps(payload: ByteArray): Boolean {
        if (payload.size < 5) return false
        val sc = if (payload[0] == 0.toByte() && payload[1] == 0.toByte() &&
            payload[2] == 0.toByte() && payload[3] == 1.toByte()
        ) 4 else if (payload[0] == 0.toByte() && payload[1] == 0.toByte() && payload[2] == 1.toByte()) 3 else 0
        return sc != 0 && (payload[sc].toInt() and 0x1F) == 7
    }

    /**
     * WebRTC HardwareVideoEncoder prepends SPS/PPS to every key. That buffer is a
     * picture (0x02), not a config-only frame (0x01). Tiny SPS/PPS alone stays 0x01.
     */
    fun typeOfH264(isDeclaredKey: Boolean, payload: ByteArray): Byte {
        if (isAvcIdr(payload)) return TYPE_KEY
        if (hasSliceNal(payload)) return if (isDeclaredKey) TYPE_KEY else TYPE_DELTA
        if (startsWithSps(payload) && payload.size <= 96) return TYPE_CONFIG
        if (isDeclaredKey || (startsWithSps(payload) && payload.size > 96)) return TYPE_KEY
        return TYPE_DELTA
    }

    private fun nalTypes(payload: ByteArray): Sequence<Int> = sequence {
        var i = 0
        while (i + 4 < payload.size) {
            val sc = when {
                payload[i] == 0.toByte() && payload[i + 1] == 0.toByte() &&
                    payload[i + 2] == 0.toByte() && payload[i + 3] == 1.toByte() -> 4
                payload[i] == 0.toByte() && payload[i + 1] == 0.toByte() &&
                    payload[i + 2] == 1.toByte() -> 3
                else -> 0
            }
            if (sc == 0) { i++; continue }
            yield(payload[i + sc].toInt() and 0x1F)
            i += sc + 1
        }
    }

    /** 9-byte header: type + pts µs big-endian, then Annex-B payload. */
    fun pack(type: Byte, ptsUs: Long, payload: ByteArray): ByteArray {
        val out = ByteArray(9 + payload.size)
        out[0] = type
        writePts(out, 1, ptsUs)
        System.arraycopy(payload, 0, out, 9, payload.size)
        return out
    }

    fun writePts(out: ByteArray, offset: Int, ptsUs: Long) {
        var v = ptsUs
        for (i in 7 downTo 0) {
            out[offset + i] = (v and 0xFF).toByte()
            v = v ushr 8
        }
    }

    fun readPts(buf: ByteArray, offset: Int = 1): Long {
        var v = 0L
        for (i in 0..7) v = (v shl 8) or (buf[offset + i].toLong() and 0xFF)
        return v
    }
}

data class CongestionDecision(
    val bitrate: Int,
    val dropDelta: Boolean,
    val requestKeyframe: Boolean,
)

object Congestion {
    fun tick(queueBytes: Long, bitrate: Int, wan: Boolean = false): CongestionDecision {
        var br = bitrate
        var drop = false
        var kf = false
        val dropAt = if (wan) 192 * 1024 else 768 * 1024
        val slowAt = if (wan) 96 * 1024 else 256 * 1024
        val cap = if (wan) Config.WAN_MAX_BITRATE else Config.MAX_BITRATE
        when {
            queueBytes > dropAt -> {
                drop = true
                br = (br * 0.6).toInt().coerceAtLeast(Config.MIN_BITRATE)
                kf = true
            }
            queueBytes > slowAt -> {
                br = (br * 0.8).toInt().coerceAtLeast(Config.MIN_BITRATE)
            }
            queueBytes < 32 * 1024 -> {
                br = (br * 1.1).toInt().coerceAtMost(cap)
            }
        }
        return CongestionDecision(br, drop, kf)
    }
}

object Reconnect {
    fun delayMs(attempt: Int): Long {
        val exp = min(attempt.coerceAtLeast(0), 4)
        val base = min(1_000L * (1 shl exp), 15_000L)
        val jitter = Random.nextLong(0, 400)
        return base + jitter
    }
}

fun nowMs(): Long = SystemClock.elapsedRealtime()
