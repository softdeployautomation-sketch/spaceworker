# Spec 1 — WebRTC hardware H.264 encode (giữ WS 9-byte)

**Nhánh:** `fast-encode`  
**Version mục tiêu:** `1.4.0` / versionCode `10400`  
**Phụ thuộc:** `media-projection` @ `fa45b9c` (ImageReader JPEG + FGS `mediaProjection`)  
**Backend:** không đổi protocol, không đổi relay, không đổi MQTT.

## 1. Mục tiêu

Agent encode màn hình bằng **H.264 hardware** (Venus/VPU, surface/texture), gửi Annex-B trên WebSocket hiện tại. Viewer WebCodecs đã hiểu `0x01/0x02/0x03`. JPEG `0x04` chỉ còn fallback khi encoder không khởi tạo được.

Thành công khi dump `agentVer=1.4.0`, `step=` chứa `mp:ok h264`, web thấy video ~15fps WAN (máy VN ↔ VPS UK) thay vì slide JPEG, process không bị SIGSEGV trên SM-S918B.

## 2. Ngoài phạm vi

- Không `PeerConnection`, ICE, STUN, TURN, DataChannel.
- Không đổi `rc-api` / `rc-relay` / MQTT topic.
- Không copy code RustDesk (GPL-3.0).
- Không tự `MediaCodec.createInputSurface()` + VirtualDisplay (đã crash QCOM).
- Không VP8/VP9 trên dây 9-byte (viewer chỉ H.264 + JPEG).

## 3. Hiện trạng

- Capture: Media Projection → `MpJpegPump` ImageReader RGBA → JPEG `0x04`.
- FGS: `startForeground(..., FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)` **trước** `getMediaProjection`.
- Token `createScreenCaptureIntent` / `getMediaProjection` **dùng một lần**.
- Frame: 9 byte `type + pts_us BE` + payload. Relay forward `0x01..0x04`.
- Viewer: `avc1.42E01E` (Baseline), `optimizeForLatency`.
- `Config.wan` theo hostname public → `WAN_ENCODE_W=480`, JPEG q42.

## 4. Thư viện

```kotlin
implementation("io.getstream:stream-webrtc-android:1.3.10")
```

Apache 2.0. `abiFilters` giữ `arm64-v8a`. ProGuard:

```
-keep class org.webrtc.** { *; }
-keep class org.webrtc.audio.** { *; }
```

Không thêm ffmpeg-kit, Media3 Transformer, native RustDesk.

## 5. Kiến trúc

Một VirtualDisplay. Không chồng ImageReader + capturer.

```
session.start (MQTT)
  → requestProjection (Settings hoặc FSI)   // không đổi
  → CaptureService.start(ctx, resultIntent)
       startForeground(MEDIA_PROJECTION)
       EglBase + SurfaceTextureHelper
       HardwareVideoEncoderFactory(egl, enableIntelVp8=false, enableH264HighProfile=false)
       encoder.initEncode(H264 Baseline)
       ScreenCapturerAndroid.startCapture  // gọi getMediaProjection bên trong
       VideoFrame texture → HardwareVideoEncoder.encode
       onEncodedFrame → Framing.pack(0x01|0x02|0x03) → SessionSocket
```

**Token một lần:** `CaptureService` **không** gọi `getMediaProjection` trước capturer. `startForeground` xong rồi `ScreenCapturerAndroid(resultIntent, callback).startCapture(w, h, fps)`. Capturer consume token.

Nếu `ScreenCapturerAndroid` không cho hook FGS-trước-token: viết `MpTextureCapturer` mỏng — `getMediaProjection` sau FGS, `createVirtualDisplay` lên `Surface(surfaceTextureHelper.surfaceTexture)`, đẩy `VideoFrame` vào encoder. Vẫn **cấm** nối VD thẳng vào `MediaCodec` surface của app.

## 6. Encoder

| Tham số | WAN (`Config.wan`) | LAN |
|---|---|---|
| Nguồn | `HardwareVideoEncoder` H.264 Baseline | cùng |
| High profile | tắt | tắt |
| Width max | 720 (align 16) | 720 |
| FPS | 15 | 20 |
| Bitrate | `1_200_000` (clamp `MIN_BITRATE`..`WAN_MAX_BITRATE` nâng lên 1.5M) | `2_500_000` |
| Keyframe | 2s + khi `Congestion.requestKeyframe` | 2s |
| Bitrate mode | CBR (WebRTC default) | CBR |

`enableH264HighProfile=false` — khớp `avc1.42E01E`. High profile = viewer đen.

Output callback:

- codec config → `TYPE_CONFIG` (`0x01`), giữ `codecConfig` để viewer join muộn (như encoder cũ).
- keyframe / IDR (kể cả QCOM thiếu flag) → `TYPE_KEY` (`0x02`); tái dùng `Framing.isAvcIdr`.
- còn lại → `TYPE_DELTA` (`0x03`).
- `pts` microseconds, `Framing.pack`.

`Congestion.tick(ws.queueSize)`: `setRateAllocation` / `setBitrate`; khi `dropDelta` bỏ `0x03`; khi `requestKeyframe` `requestKeyFrame`.

`meta` JSON: `codec` = `Encoder.avcCodec(w,h)` (không còn `"jpeg"` khi H.264 sống). `w`/`h` là kích thước encode.

## 7. Fallback JPEG

`HardwareVideoEncoderFactory.createEncoder` null, `initEncode` fail, hoặc 2s không có encoded frame:

1. `FaultLog.error("H264_INIT"|`H264_SILENT")`
2. Dừng capturer/encoder WebRTC (không `mp.stop()` nếu còn dùng lại — nếu token đã consume, không tạo VD H.264 được nữa).
3. **JPEG:** nếu MP còn sống, ImageReader trên **cùng** MP (`MpJpegPump`). Nếu `createVirtualDisplay` fail vì MP stopped → `SessionCapture` a11y JPEG.
4. `meta.codec=jpeg`, `0x04`. Session không fail nếu JPEG chạy.

QCOM crash native: `FaultLog` breadcrumb `mp:h264 init` trước `initEncode`; lần mở app sau `KILLED after [mp:h264 init]` → lần sau skip HW, JPEG luôn (flag prefs `skip_hw_h264`).

## 8. File đụng

| File | Việc |
|---|---|
| `app/build.gradle.kts` | dependency WebRTC, version 1.4.0 |
| `proguard-rules.pro` | keep `org.webrtc` |
| `capture/WebRtcH264Encoder.kt` **mới** | factory, init, callback → `FrameSink` |
| `capture/MpTextureCapturer.kt` **mới** nếu không dùng `ScreenCapturerAndroid` nguyên |
| `capture/CaptureService.kt` | FGS → WebRTC encode; JPEG fallback |
| `capture/MpJpegPump.kt` | chỉ fallback |
| `core/Config.kt` | WAN bitrate/fps/width cho H.264 |
| `transport/SessionSocket.kt` | giữ 9-byte; `backlogged` cho H.264 delta |
| `settings/SettingsActivity.kt` | dump `enc=h264 name=...` |
| test | pack config/key; `scaled` 720 WAN |

Không sửa Backend trong spec này. Viewer `decode.ts` H.264 đã có; nếu `0x01` không reset `jpegMode` đúng khi chuyển JPEG→H.264 trong một session, sửa **một** nhánh: `0x01`/`0x02` tắt `jpegMode` (file Backend, commit repo Backend riêng khi implement).

## 9. Kiểm tra

- Unit: `Framing` config/key/delta; `isAvcIdr`; scaled 1920×1200 → 720×450.
- Máy SM-S918B kiosk: Connect → Start now toàn màn → dump `mp:ok h264` + `enc=` không chứa `qti` surface DIY.
- Web: không JPEG blocky; stats log `fps>=10` WAN, process còn sống 5 phút.
- Cắt MQTT giữa chừng: không leak capturer; lần Connect sau xin MP lại.
- `skip_hw_h264` sau simulated kill: JPEG, không gọi HW.

## 10. Rủi ro

- AAR WebRTC ~10–30MB native arm64 — chấp nhận, chỉ một ABI.
- `ScreenCapturerAndroid` tự `getMediaProjection` vs FGS Android 14: nếu throw `SecurityException`, chuyển `MpTextureCapturer` (FGS rồi mới `getMediaProjection`).
- Texture frame trên Samsung cần `EglBase` shared; không share EGL → encoder YUV path (CPU) vẫn hơn JPEG, vẫn cấm VD→QCOM surface.
