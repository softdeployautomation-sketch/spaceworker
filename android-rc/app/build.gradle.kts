import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val fleetKs = rootProject.file("keystore/fleet.jks")
val debugKs = rootProject.file("keystore/debug.keystore")
val knoxJar = file("libs/knoxsdk.jar")
val ksMap = linkedMapOf<String, String>().apply {
    val f = rootProject.file("keystore/keystore.properties")
    if (f.exists()) {
        f.readLines().forEach { raw ->
            val line = raw.trim()
            if (line.isEmpty() || line.startsWith("#")) return@forEach
            val i = line.indexOf('=')
            if (i > 0) put(line.substring(0, i).trim(), line.substring(i + 1).trim())
        }
    }
}
fun ksProp(name: String, fallback: String = ""): String =
    ksMap[name] ?: providers.gradleProperty(name).orElse(fallback).get()

/** Cấu hình fleet: keystore.properties (gitignored) → gradle property → placeholder công khai. */
fun rcProp(name: String, fallback: String): String =
    ksMap[name] ?: providers.gradleProperty(name).orElse(fallback).get()

android {
    namespace = "top.spaceworker.rcagent"
    compileSdk = 35

    defaultConfig {
        applicationId = "top.spaceworker.rcagent"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0-t254a"
        ndk { abiFilters += listOf("arm64-v8a") }
        // Endpoint mặc định đến từ gradle property, không hardcode hạ tầng vào source.
        // Fleet riêng: đặt trong local gradle.properties / -P / CI secret (xem README).
        buildConfigField("String", "MQTT_BROKER", "\"${rcProp("RC_MQTT_BROKER", "ssl://android.spaceworker.top:8883")}\"")
        buildConfigField("String", "WS_BASE", "\"${rcProp("RC_WS_BASE", "wss://android.spaceworker.top")}\"")
        buildConfigField("String", "RC_SERVER", "\"${rcProp("RC_SERVER", "https://android.spaceworker.top")}\"")
        buildConfigField("String", "DEVICE_ID", "\"${rcProp("RC_DEVICE_ID", "")}\"")
        // Rỗng = phải do MDM đẩy xuống. Không bao giờ commit mật khẩu thật.
        buildConfigField("String", "MQTT_PASSWORD", "\"${rcProp("RC_MQTT_PASSWORD", "")}\"")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        // Phase 1: release signed with the debug keystore so `assembleRelease`
        // works without a fleet key (generate via createDebugKeystore task).
        // AGP already registers a `debug` SigningConfig; configure it instead of
        // creating a duplicate (create("debug") throws "already exists").
        getByName("debug") {
            storeFile = debugKs
            storeType = "JKS"
            storePassword = ksProp("DEBUG_STORE_PASSWORD", "android")
            keyAlias = ksProp("DEBUG_KEY_ALIAS", "androiddebugkey")
            keyPassword = ksProp("DEBUG_KEY_PASSWORD", "android")
        }
        // Fleet release key (production). gitignored; never committed.
        if (fleetKs.exists()) {
            create("fleet") {
                storeFile = fleetKs
                storeType = "pkcs12"
                storePassword = ksProp("FLEET_STORE_PASSWORD")
                keyAlias = ksProp("FLEET_KEY_ALIAS", "fleet")
                keyPassword = ksProp("FLEET_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            buildConfigField("boolean", "ALLOW_CLEARTEXT", "true")
            signingConfig = signingConfigs.findByName("debug")
        }
        release {
            buildConfigField("boolean", "ALLOW_CLEARTEXT", "false")
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            signingConfig = signingConfigs.findByName("fleet") ?: signingConfigs.findByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { buildConfig = true; aidl = true }
    packaging { resources { excludes += "/META-INF/{AL2.0,LGPL2.1}" } }
}

// compilerOptions DSL (Kotlin 2.4; kotlinOptions block removed)
kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.eclipse.paho:org.eclipse.paho.mqttv5.client:1.2.5")
    implementation("org.slf4j:slf4j-nop:2.0.19")
    implementation("io.getstream:stream-webrtc-android:1.3.10")
    // Knox: compileOnly — not packaged into the APK; class may be absent at runtime
    if (knoxJar.exists()) compileOnly(files(knoxJar))
    testImplementation("junit:junit:4.13.2")
}

/** Generate a debug keystore (Phase 1) so release can be signed without fleet.jks. Requires keytool (JDK). */
tasks.register("createDebugKeystore") {
    group = "signing"
    description = "Create keystore/debug.keystore for Phase-1 debug-signed release builds"
    doLast {
        if (debugKs.exists()) return@doLast
        debugKs.parentFile.mkdirs()
        val javaHome = System.getProperty("java.home")
        val keytoolFile = File(javaHome, "../bin/keytool")
        val keytool = if (keytoolFile.exists()) keytoolFile.absolutePath
            else File(javaHome, "bin/keytool").absolutePath
        val cmd = listOf(
            keytool, "-genkeypair", "-alias", "androiddebugkey", "-keyalg", "RSA", "-keysize", "2048",
            "-validity", "10000", "-keystore", debugKs.absolutePath,
            "-storepass", "android", "-keypass", "android",
            "-dname", "CN=Android Debug,O=Spaceworker,C=US",
        )
        val proc = ProcessBuilder(cmd).redirectErrorStream(true).start()
        proc.inputStream.bufferedReader().forEachLine { System.out.println(it) }
        proc.waitFor()
        if (proc.exitValue() != 0) {
            throw GradleException("keytool failed to create $debugKs")
        }
    }
}

gradle.taskGraph.whenReady {
    val releasing = gradle.taskGraph.allTasks.any { it.name.contains("Release") }
    if (releasing && !fleetKs.exists() && !debugKs.exists()) {
        tasks.named("createDebugKeystore") { enabled = true }
    }
}
