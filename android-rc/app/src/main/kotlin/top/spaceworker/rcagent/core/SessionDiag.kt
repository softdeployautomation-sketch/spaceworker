package top.spaceworker.rcagent.core

import top.spaceworker.rcagent.RcApplication
import top.spaceworker.rcagent.capture.CaptureService
import org.json.JSONObject

/** JSON `{t:log}` on the session WS so the viewer/relay can see why a connect is black. */
object SessionDiag {
    private const val MAX = 24
    private val lock = Any()
    private val recent = ArrayDeque<String>(MAX)

    @Volatile var sink: ((String) -> Unit)? = null
    @Volatile var lastFail: String = ""
        private set

    fun emit(msg: String, extra: JSONObject = JSONObject(), keep: Boolean = true) {
        extra.put("t", "log")
        extra.put("msg", msg)
        extra.put("ts", System.currentTimeMillis())
        extra.put("phase", AgentState.phase.name)
        extra.put("enc", CaptureService.encLabel)
        val step = FaultLog.stepLine()
        if (step.isNotEmpty() && !extra.has("step")) extra.put("step", step.take(180))
        SessionBus.lastError?.takeIf { it.isNotBlank() }?.let { extra.put("err", it.take(160)) }
        if (lastFail.isNotBlank() && !extra.has("lastFail")) extra.put("lastFail", lastFail.take(240))
        val line = extra.toString()
        if (keep) {
            synchronized(lock) {
                while (recent.size >= MAX) recent.removeFirst()
                recent.addLast(line)
            }
        }
        sink?.invoke(line)
    }

    fun fail(code: String, why: String, t: Throwable? = null) {
        lastFail = buildString {
            append(code)
            if (why.isNotBlank()) append(' ').append(why)
            if (t != null) append(' ').append(t.javaClass.simpleName).append(':').append(t.message ?: "")
        }.take(240)
        val extra = JSONObject()
            .put("code", code)
            .put("why", why)
        if (t != null) extra.put("ex", "${t.javaClass.simpleName}: ${t.message}")
        val fault = FaultLog.faultText()
        if (fault.isNotBlank()) extra.put("fault", fault.take(500))
        val crash = RcApplication.crashText()
        if (crash.isNotBlank()) extra.put("crash", crash.take(400))
        emit("fail", extra)
    }

    fun stats(fps: Int, kbps: Int, targetBr: Int, queueBytes: Long, driftMs: Int = 0) {
        emit(
            "stats",
            JSONObject()
                .put("fps", fps)
                .put("kbps", kbps)
                .put("br", targetBr / 1000)
                .put("q", queueBytes)
                .put("drift", driftMs)
                .put("wan", Config.wan),
            keep = false,
        )
    }

    fun stampMeta(o: JSONObject) {
        o.put("ver", Config.agentVer)
        o.put("enc", CaptureService.encLabel)
        o.put("phase", AgentState.phase.name)
        val step = FaultLog.stepLine().take(180)
        if (step.isNotEmpty()) o.put("step", step)
        if (!o.has("why")) {
            val why = buildString {
                append(Config.agentVer)
                if (lastFail.isNotBlank()) append(" · ").append(lastFail)
                else if (step.isNotEmpty()) append(" · ").append(step)
            }
            o.put("why", why)
        }
    }

    fun clearFail() {
        lastFail = ""
    }

    fun flush() {
        val copy = synchronized(lock) { recent.toList() }
        copy.forEach { sink?.invoke(it) }
    }
}
