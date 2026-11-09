package top.spaceworker.rcagent

import top.spaceworker.rcagent.transport.Congestion
import top.spaceworker.rcagent.transport.Framing
import top.spaceworker.rcagent.transport.Reconnect
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FramingTest {
    @Test
    fun jpegTypeIsFourthByte() {
        val packed = Framing.pack(Framing.TYPE_JPEG, 1L, byteArrayOf(0xFF.toByte(), 0xD8.toByte()))
        assertEquals(Framing.TYPE_JPEG, packed[0])
        assertEquals(11, packed.size)
    }

    @Test
    fun packHeaderIs9BytesPlusPayload() {
        val payload = byteArrayOf(0, 0, 0, 1, 0x67)
        val packed = Framing.pack(Framing.TYPE_KEY, 0x0102030405060708L, payload)
        assertEquals(9 + payload.size, packed.size)
        assertEquals(Framing.TYPE_KEY, packed[0])
        assertEquals(0x0102030405060708L, Framing.readPts(packed))
        assertEquals(payload.toList(), packed.copyOfRange(9, packed.size).toList())
    }

    @Test
    fun congestionDropsDeltaWhenQueueHuge() {
        val d = Congestion.tick(800 * 1024, 1_500_000)
        assertTrue(d.dropDelta)
        assertTrue(d.requestKeyframe)
        assertTrue(d.bitrate < 1_500_000)
        assertTrue(d.bitrate >= 300_000)
    }

    @Test
    fun congestionRaisesWhenQueueEmpty() {
        val d = Congestion.tick(1_000, 1_000_000)
        assertEquals(1_100_000, d.bitrate)
        assertTrue(!d.dropDelta)
    }

    @Test
    fun congestionDoesNotClimbUnderBackpressure() {
        var br = 1_500_000
        val samples = mutableListOf<Int>()
        repeat(30) {
            br = Congestion.tick(400 * 1024, br).bitrate
            samples += br
        }
        assertTrue(samples.last() <= samples.first())
        assertEquals(300_000, samples.last())
        assertTrue(samples.zipWithNext().all { (a, b) -> b <= a })
    }

    @Test
    fun congestionWanDropsEarlier() {
        val d = Congestion.tick(200 * 1024, 800_000, wan = true)
        assertTrue(d.dropDelta)
        assertTrue(d.bitrate < 800_000)
    }

    @Test
    fun congestionLanCapIs2_5Mbps() {
        val d = Congestion.tick(1_000, 2_400_000)
        assertTrue(d.bitrate <= 2_500_000)
        assertTrue(d.bitrate >= 2_400_000)
    }

    @Test
    fun reconnectHasJitterAndBackoff() {
        val a = Reconnect.delayMs(0)
        val b = Reconnect.delayMs(4)
        assertTrue(a in 1_000L..1_400L)
        assertTrue(b in 15_000L..15_400L)
    }

    @Test
    fun detectsIdrNal() {
        val idr = byteArrayOf(0, 0, 0, 1, 0x65, 0x88.toByte())
        assertTrue(Framing.isAvcIdr(idr))
        assertTrue(!Framing.isAvcIdr(byteArrayOf(0, 0, 0, 1, 0x61)))
        assertTrue(Framing.startsWithSps(byteArrayOf(0, 0, 0, 1, 0x67, 0x42)))
    }

    @Test
    fun h264SpsOnlyIsConfig() {
        val sps = byteArrayOf(0, 0, 0, 1, 0x67, 0x42)
        assertEquals(Framing.TYPE_CONFIG, Framing.typeOfH264(isDeclaredKey = false, sps))
    }

    @Test
    fun h264IdrIsKeyEvenWithoutFlag() {
        val idr = byteArrayOf(0, 0, 0, 1, 0x65, 0x10)
        assertEquals(Framing.TYPE_KEY, Framing.typeOfH264(isDeclaredKey = false, idr))
    }

    @Test
    fun h264DeltaIsDelta() {
        val p = byteArrayOf(0, 0, 0, 1, 0x41, 0x00)
        assertEquals(Framing.TYPE_DELTA, Framing.typeOfH264(isDeclaredKey = false, p))
    }

    @Test
    fun h264DeclaredKeyIsKey() {
        val p = byteArrayOf(0, 0, 0, 1, 0x41, 0x00)
        assertEquals(Framing.TYPE_KEY, Framing.typeOfH264(isDeclaredKey = true, p))
    }

    @Test
    fun h264SpsThenIdrIsKey() {
        val payload = byteArrayOf(
            0, 0, 0, 1, 0x67, 0x42,
            0, 0, 0, 1, 0x68, 0xCE.toByte(),
            0, 0, 0, 1, 0x65, 0x88.toByte(),
        )
        assertEquals(Framing.TYPE_KEY, Framing.typeOfH264(isDeclaredKey = true, payload))
        assertEquals(Framing.TYPE_KEY, Framing.typeOfH264(isDeclaredKey = false, payload))
    }

    @Test
    fun h264TinySpsIsConfigEvenIfDeclaredKey() {
        val sps = byteArrayOf(0, 0, 0, 1, 0x67, 0x42)
        assertEquals(Framing.TYPE_CONFIG, Framing.typeOfH264(isDeclaredKey = true, sps))
    }

    @Test
    fun h264LargeSpsPrefixWithoutSliceIsKey() {
        val payload = ByteArray(120) { 0 }
        payload[0] = 0; payload[1] = 0; payload[2] = 0; payload[3] = 1; payload[4] = 0x67
        assertEquals(Framing.TYPE_KEY, Framing.typeOfH264(isDeclaredKey = true, payload))
    }
}
