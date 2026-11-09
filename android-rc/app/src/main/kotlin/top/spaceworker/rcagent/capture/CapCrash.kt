package top.spaceworker.rcagent.capture

/** SurfaceTextureHelper thread `rc-cap`. Waiting on it after Looper death deadlocks main/MQTT. */
object CapCrash {
    @Volatile private var abandon = false

    fun isCaptureThread(threadName: String): Boolean = threadName == "rc-cap"

    fun isTextureDeath(threadName: String, error: Throwable): Boolean {
        if (!isCaptureThread(threadName)) return false
        if (error !is IllegalStateException) return false
        return error.message.orEmpty().contains("texture", ignoreCase = true)
    }

    fun markAbandon() {
        abandon = true
    }

    fun clear() {
        abandon = false
    }

    fun canWaitOnHelper(threadAlive: Boolean): Boolean = threadAlive && !abandon
}
