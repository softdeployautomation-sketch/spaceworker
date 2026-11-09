package top.spaceworker.rcagent.core

import android.util.Log
import java.util.concurrent.CopyOnWriteArrayList

object AgentState {
    enum class Phase { HEALING, IDLE, RECONNECTING, ACQUIRING, STREAMING }

    @Volatile
    var phase: Phase = Phase.IDLE
        private set

    private val listeners = CopyOnWriteArrayList<(Phase) -> Unit>()

    fun set(next: Phase) {
        val prev = phase
        if (prev == next) return
        phase = next
        Log.i(Config.TAG, "state $prev -> $next")
        listeners.forEach { it(next) }
    }

    fun onChange(l: (Phase) -> Unit) {
        listeners += l
    }
}
