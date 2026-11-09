package top.spaceworker.rcagent

import top.spaceworker.rcagent.capture.Encoder
import top.spaceworker.rcagent.capture.KeyframeWatchdog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EncoderLadderTest {
    @Test
    fun phoneDoesNotEncodeNative() {
        val rungs = Encoder.ladderFor(1440, 3088)
        assertTrue(rungs.isNotEmpty())
        assertTrue(rungs.all { it.w <= 720 })
        assertTrue(rungs.first().br <= 2_500_000)
    }

    @Test
    fun tabletMatchesSpec720() {
        val top = Encoder.ladderFor(1200, 1920).first()
        assertEquals(720, top.w)
        assertEquals(1152, top.h)
        assertEquals(1_500_000, top.br)
    }

    @Test
    fun wanPhoneCapsAt480() {
        val top = Encoder.ladderFor(1440, 3088, maxW = 480, wan = true).first()
        assertTrue(top.w <= 480)
        assertTrue(top.br <= 1_500_000)
    }

    @Test
    fun h264WanWidthIs720() {
        assertEquals(720, top.spaceworker.rcagent.core.Config.WAN_ENCODE_W)
        assertEquals(1_500_000, top.spaceworker.rcagent.core.Config.WAN_MAX_BITRATE)
        assertEquals(15, top.spaceworker.rcagent.core.Config.WAN_FPS)
        assertEquals(480, top.spaceworker.rcagent.core.Config.WAN_JPEG_W)
    }

    @Test
    fun publicHostIsWan() {
        assertTrue(top.spaceworker.rcagent.core.Wan.isPublicHost("relay.example.com"))
        assertTrue(!top.spaceworker.rcagent.core.Wan.isPublicHost("192.168.100.176"))
        assertTrue(!top.spaceworker.rcagent.core.Wan.isPublicHost("10.0.0.2"))
    }

    @Test
    fun watchdogRestartsAfterMissedRequest() {
        val now = 10_000L
        assertFalse(KeyframeWatchdog.restartNeeded(now, deadlineMs = 0))
        assertFalse(KeyframeWatchdog.restartNeeded(now, deadlineMs = now - 400))
        assertFalse(KeyframeWatchdog.restartNeeded(now, deadlineMs = now - 1_600))
        assertTrue(KeyframeWatchdog.restartNeeded(now, deadlineMs = now - 2_600))
    }

    @Test
    fun mpJpegScaleMatchesRustDeskHalf() {
        val (w, h, dpi) = top.spaceworker.rcagent.capture.MpJpegPump.scaled(1440, 3088, 450, 720)
        assertEquals(720, w)
        assertEquals(1544, h)
        assertEquals(225, dpi)
        assertEquals(0, w % 2)
        assertEquals(0, h % 2)
    }

    @Test
    fun mpJpegWanCapsWidth480() {
        val (w, h, dpi) = top.spaceworker.rcagent.capture.MpJpegPump.scaled(1920, 1200, 320, top.spaceworker.rcagent.core.Config.WAN_JPEG_W)
        assertEquals(480, w)
        assertEquals(300, h)
        assertEquals(120, dpi)
    }

    @Test
    fun h264TabletIsMacroblockAligned() {
        val (w, h, _) = top.spaceworker.rcagent.capture.MpJpegPump.scaled(1920, 1200, 240, 720, align = 16)
        assertEquals(720, w)
        assertEquals(448, h)
        assertEquals(0, w % 16)
        assertEquals(0, h % 16)
    }
}
