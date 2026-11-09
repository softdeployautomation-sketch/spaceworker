package top.spaceworker.rcagent.input

interface InputEngine {
    val name: String
    fun isAvailable(): Boolean
    fun touch(action: String, nx: Float, ny: Float, pointerId: Int)
    fun key(k: String)
    fun text(v: String)
    fun scroll(nx: Float, ny: Float, dy: Float) {}
}
