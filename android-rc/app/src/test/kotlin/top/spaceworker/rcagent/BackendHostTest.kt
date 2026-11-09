package top.spaceworker.rcagent

import top.spaceworker.rcagent.core.BackendPrefs
import top.spaceworker.rcagent.core.Config
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BackendHostTest {
    @Test
    fun parseHostFromConsoleUrl() {
        assertEquals("192.168.100.176", BackendPrefs.parseHost("http://192.168.100.176:5175"))
        assertEquals("192.168.100.176", BackendPrefs.parseHost("192.168.100.176"))
        assertEquals("192.168.100.176", BackendPrefs.parseHost("tcp://192.168.100.176:1883"))
        assertEquals("10.0.0.2", BackendPrefs.parseHost("  ws://10.0.0.2:3001/agent "))
        assertNull(BackendPrefs.parseHost(""))
        assertNull(BackendPrefs.parseHost("   "))
    }

    @Test
    fun parseMqttKeepsCustomPort() {
        assertEquals("tcp://192.168.100.176:1884", BackendPrefs.parseMqtt("tcp://192.168.100.176:1884"))
        assertEquals("tcp://10.0.0.2:1883", BackendPrefs.parseMqtt("10.0.0.2"))
        assertEquals("tcp://10.0.0.2:8883", BackendPrefs.parseMqtt("10.0.0.2:8883"))
        assertEquals("ssl://broker.local:8883", BackendPrefs.parseMqtt("ssl://broker.local:8883"))
        assertEquals("ssl://broker.local:8883", BackendPrefs.parseMqtt("ssl://broker.local"))
        assertEquals("ssl://broker.local:8883", BackendPrefs.parseMqtt("mqtts://broker.local"))
        assertEquals("ssl://relay.example.com:8883", BackendPrefs.parseMqtt("mqtts://relay.example.com:8883"))
        assertNull(BackendPrefs.parseMqtt(""))
        assertNull(BackendPrefs.parseMqtt("host:abc"))
        assertNull(BackendPrefs.parseMqtt("host:99999"))
    }

    @Test
    fun httpsBackendIsTls() {
        assertEquals(true, BackendPrefs.isTlsUrl("https://api.example.com:5175"))
        assertEquals(true, BackendPrefs.isTlsUrl("wss://relay.example.com/agent"))
        assertEquals(false, BackendPrefs.isTlsUrl("http://192.168.100.176:5175"))
        assertEquals(false, BackendPrefs.isTlsUrl("192.168.100.176"))
    }

    @Test
    fun cleartextUriDetection() {
        assertEquals(true, Config.isCleartextUri("tcp://192.168.100.176:1883"))
        assertEquals(true, Config.isCleartextUri("ws://host:3001/agent"))
        assertEquals(false, Config.isCleartextUri("ssl://host:8883"))
        assertEquals(false, Config.isCleartextUri("wss://host:3001/agent"))
    }

    @Test
    fun parseRelayPortRejectsJunk() {
        assertEquals(3001, BackendPrefs.parseRelayPort("3001"))
        assertEquals(443, BackendPrefs.parseRelayPort("443"))
        assertNull(BackendPrefs.parseRelayPort("0"))
        assertNull(BackendPrefs.parseRelayPort("abc"))
        assertNull(BackendPrefs.parseRelayPort("99999"))
    }
}
