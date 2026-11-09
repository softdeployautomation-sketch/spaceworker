package top.spaceworker.rcagent.core

import android.util.Log
import top.spaceworker.rcagent.BuildConfig
import top.spaceworker.rcagent.RcApplication
import java.io.File
import java.io.FileOutputStream

/** Survives native/FGS kills: last step is flushed to disk before the risky call. */
object FaultLog {
    private const val STEP = "rc_step.txt"
    private const val FAULT = "rc_fault.txt"

    fun step(where: String) {
        Log.i(Config.TAG, "step $where")
        syncWrite(STEP, "${BuildConfig.VERSION_NAME} ${System.currentTimeMillis()} $where")
    }

    fun error(code: String, t: Throwable? = null, extra: String = "") {
        val text = format(code, extra, t)
        Log.e(Config.TAG, text)
        syncWrite(FAULT, "${BuildConfig.VERSION_NAME} ${System.currentTimeMillis()}\n$text")
    }

    fun noteProcessStart() {
        val last = read(STEP)
        if (last.isBlank()) return
        if (last.contains(" idle") || last.contains(" jpeg:ok")) return
        if (last.contains(" mp:ok") && !last.contains("mp:ok h264")) return
        if (RcApplication.crashText().isNotBlank()) return
        if (read(FAULT).isNotBlank()) return
        error("KILLED", extra = "process died after [$last] — no Java stack (native crash or system killed FGS)")
    }

    fun clear() {
        runCatching { File(dir(), STEP).delete() }
        runCatching { File(dir(), FAULT).delete() }
    }

    fun stepLine(): String = read(STEP)
    fun faultText(): String = read(FAULT)

    fun format(code: String, extra: String, t: Throwable?): String = buildString {
        append(code)
        if (extra.isNotBlank()) append(' ').append(extra)
        var cur: Throwable? = t
        var n = 0
        while (cur != null && n < 6) {
            append('\n').append(cur.javaClass.simpleName).append(": ").append(cur.message ?: "")
            cur = cur.cause
            n++
        }
        if (t != null) append('\n').append(t.stackTraceToString().take(1200))
    }

    private fun dir(): File = RcApplication.app.filesDir

    private fun read(name: String): String =
        runCatching { File(dir(), name).readText() }.getOrDefault("").trim()

    private fun syncWrite(name: String, text: String) {
        runCatching {
            FileOutputStream(File(dir(), name)).use { out ->
                out.write(text.toByteArray())
                out.flush()
                out.fd.sync()
            }
        }
    }
}
