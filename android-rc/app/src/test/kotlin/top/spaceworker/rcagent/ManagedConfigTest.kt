package top.spaceworker.rcagent

import top.spaceworker.rcagent.mdm.ManagedConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ManagedConfigTest {
    @Test
    fun flattenMapsHeadwindAliases() {
        val got = ManagedConfig.flatten(
            mapOf(
                "backend" to "https://relay.example.com",
                "mqtt_broker" to "mqtts://relay.example.com:8883",
                "mqtt_pass" to "s3cret",
                "deviceId" to "%SERIAL%",
                "ws_port" to "8443",
            ),
        )
        assertEquals("https://relay.example.com", got[ManagedConfig.HOST])
        assertEquals("mqtts://relay.example.com:8883", got[ManagedConfig.MQTT])
        assertEquals("s3cret", got[ManagedConfig.MQTT_PASSWORD])
        assertEquals("%SERIAL%", got[ManagedConfig.DEVICE_ID])
        assertEquals("8443", got[ManagedConfig.RELAY_PORT])
    }

    @Test
    fun flattenSkipsBlankAndZeroPort() {
        val got = ManagedConfig.flatten(
            mapOf(
                "host" to "  ",
                "relay_port" to "0",
                "mqtt" to "ssl://x:8883",
            ),
        )
        assertEquals(setOf(ManagedConfig.MQTT), got.keys)
        assertTrue(!got.containsKey(ManagedConfig.HOST))
        assertTrue(!got.containsKey(ManagedConfig.RELAY_PORT))
    }

    @Test
    fun flattenPrefersCanonicalKeys() {
        val got = ManagedConfig.flatten(
            mapOf(
                "host" to "https://a.example",
                "backend" to "https://b.example",
            ),
        )
        assertEquals("https://a.example", got[ManagedConfig.HOST])
    }
}
