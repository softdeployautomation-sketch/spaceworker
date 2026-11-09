package top.spaceworker.rcagent

import top.spaceworker.rcagent.input.GestureMath
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GestureMathTest {
    @Test
    fun tapIsShort() {
        assertEquals(80L, GestureMath.durationMs(0f, 10L))
        assertEquals(80L, GestureMath.durationMs(10f, 80L))
    }

    @Test
    fun longPressHolds() {
        val d = GestureMath.durationMs(3f, 600L)
        assertTrue(d in 500L..1200L)
    }

    @Test
    fun swipeScalesWithDistance() {
        val short = GestureMath.durationMs(80f, 0L)
        val long = GestureMath.durationMs(800f, 0L)
        assertTrue(short in 120L..500L)
        assertTrue(long in short..500L)
        assertTrue(long >= short)
    }
}
