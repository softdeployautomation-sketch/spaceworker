# Spec 2 — WebRTC PeerConnection (sau khi Spec 1 ổn)

**Nhánh (sau này):** tách từ `fast-encode` khi Spec 1 đã ship trên thiết bị.  
**Phụ thuộc:** Spec 1 (`2026-09-20-webrtc-hw-encode-design.md`) — H.264 HW trên WS đã chạy, không SIGSEGV.  
**Không bắt đầu Spec 2 nếu Spec 1 chưa có `mp:ok h264` trên SM-S918B.**

## 1. Mục tiêu

Video (và tùy chọn input) đi **RTP/UDP + DTLS-SRTP** để hết hàng đợi TCP của JPEG/H.264-over-WS. Signaling vẫn JWT + MQTT/WS hiện tại. Viewer mượt hơn Spec 1 trên đường VN ↔ UK; P2P khi NAT cho phép, **TURN trên VPS UK** khi không.

Thành công: `hello.webrtc=true` hai phía → không còn binary `0x01..0x04` trên relay trong session đó; canvas vẫn vẽ; tap/pointer còn hoạt động; mất UDP thì TURN; một phía không WebRTC thì **tự rơi về Spec 1** (H.264 9-byte).

## 2. Ngoài phạm vi

- Không bỏ MQTT `session.start` / `rc/state`.
- Không copy signaling RustDesk.
- Không bắt buộc DataChannel cho input ở v1 (pointer giữ JSON trên WS).
- Không SFU đa viewer (relay 1 agent–1 viewer như hiện tại).
- Không đổi Knox/gesture.

## 3. Vì sao Spec 1 chưa đủ

Spec 1 encode H.264 nhưng vẫn **TCP WebSocket** qua `rc-relay`. Mất gói = head-of-line blocking, bitrate bị `queueSize` kẹp. PeerConnection thêm NACK/PLI/GCC và UDP. Encode (Spec 1) tái sử dụng: cùng `ScreenCapturer` / `VideoSource`, chỉ đổi sink từ `Framing.pack` sang `VideoTrack` → `PeerConnection`.

## 4. Kiến trúc

```
MQTT session.start
  + wsUrl, token          // như cũ
  + iceServers[]          // Spec 2: STUN + TURN time-limited

Agent ──WS /agent──► rc-relay ◄──WS /viewer── Viewer
         JSON: offer / answer / ice
         JSON: pointer/key (v1)
         KHÔNG gửi 0x01..0x04 khi webrtc active

Agent VideoTrack ──DTLS-SRTP── (P2P hoặc TURN :3478/443) ── Viewer RTCPeerConnection
```

`PeerConnectionFactory` dùng lại EGL + capturer Spec 1. `addTrack(video)`. Transceiver sendonly từ agent, recvonly viewer.

## 5. Signaling (backend có đổi)

Tất cả JSON, `t` discriminant, trên **cùng WS session** (đã auth JWT). MQTT chỉ đánh thức / `session.start`.

| `t` | Hướng | Payload |
|---|---|---|
| `hello` | viewer→agent | thêm `webrtc: true` (giữ `codecs`, `jpeg`) |
| `webrtc.offer` | agent→viewer | `{ sdp }` |
| `webrtc.answer` | viewer→agent | `{ sdp }` |
| `webrtc.ice` | hai chiều | `{ candidate, sdpMid, sdpMLineIndex }` |
| `webrtc.fail` | hai chiều | `{ reason }` → fallback Spec 1 |

Thứ tự:

1. WS open, viewer gửi `hello`.
2. Agent đã có MP + capturer (Spec 1 init, **chưa** bật 9-byte nếu `hello.webrtc`).
3. Agent `createOffer`, `setLocal`, gửi `webrtc.offer`.
4. Viewer `setRemote`, `createAnswer`, `webrtc.answer`.
5. ICE trickle `webrtc.ice` đến `connected`/`completed`.
6. Agent **không** `SessionSocket.send` binary video. Relay vẫn forward JSON.

Timeout 8s không `connected` → `webrtc.fail`, bật lại H.264 9-byte Spec 1 (encoder đã có).

## 6. ICE / TURN (backend)

`session.start` (agent và viewer) thêm:

```json
"iceServers": [
  { "urls": ["stun:stun.l.google.com:19302"] },
  { "urls": ["turn:relay.example.com:3478?transport=udp",
             "turns:relay.example.com:5349?transport=tcp"],
    "username": "<ephemeral>",
    "credential": "<ephemeral>" }
]
```

- Cài **coturn** trên VPS UK, TLS 5349 (firewall MDM hay chặn UDP 3478).
- `rc-api` cấp user/password TURN **ngắn hạn** (TTL ≤ session, HMAC rest như coturn `--use-auth-secret`). Không hardcode password vào APK.
- Env: `TURN_HOST`, `TURN_SECRET`, `TURN_TTL_S`.
- Relay WS **không** chịu RTP. Bandwidth TURN đi cổng coturn, không `BACKPRESSURE_BYTES` của WS.

## 7. Viewer (`rc-web`)

- `RTCPeerConnection({ iceServers })` từ payload session (cùng chỗ lấy `wsUrl`).
- Remote track → `HTMLVideoElement` hoặc `canvas.capture`/`drawImage` video frame; giữ scale tablet hiện tại.
- Pointer: v1 **vẫn** `ws.send` JSON `{ t:'pointer', ... }` — không đợi DataChannel.
- `hello.webrtc: true` chỉ khi `RTCPeerConnection` tồn tại.
- Không WebRTC (HTTP cũ, in-app WebView thiếu): không set flag → agent Spec 1.

## 8. Agent

- Dependency: cùng `stream-webrtc-android` Spec 1; thêm `PeerConnectionFactory`, `VideoSource`/`VideoTrack`.
- Factory init một lần trong `CaptureService` (không leak EGL).
- SDP: Unified Plan, H.264 Baseline only (`profile-level-id=42e01e`), không bundle audio v1 (`voiceActivityDetection=false`, không audio track).
- `iceCandidatePoolSize=0` (MDM, ít ICE trickling trước offer).
- Khi fallback Spec 1: `pc.close()`, gắn lại encoder callback → `SessionSocket`.

Dump: `pc=new|checking|connected|failed` + `ice=`.

## 9. File / dịch vụ đụng

| Nơi | Việc |
|---|---|
| Android `WebRtcPeer.kt` **mới** | PC, offer, ICE, fail→Spec 1 |
| `CaptureService.kt` | nhánh `hello.webrtc` |
| `SessionBus.handleViewerJson` | `webrtc.answer` / `webrtc.ice` / `webrtc.fail` |
| `rc-api` session DTO | `iceServers` |
| `rc-web` Remote + `decode.ts` | PC + video element; giữ decode 9-byte fallback |
| VPS | coturn unit, firewall 3478/udp + 5349/tcp |
| `rc-relay` | không parse RTP; JSON signaling như text hiện tại |

Relay `isBinary` không cần mở rộng. Không thêm type `0x05`.

## 10. Bảo mật

- Signaling: JWT WS như cũ, không SDP trên MQTT public retained.
- Media: DTLS-SRTP.
- TURN: credential theo session, không reuse giữa device.
- ICE gather không log IP nội bộ lên MQTT `rc/state` (PII).

## 11. Kiểm tra

- Cùng Wi-Fi LAN: `ice=host` hoặc `srflx`, fps ≥ 20, tap còn.
- Máy VN + viewer + VPS UK: `ice=relay` nếu P2P fail; video sống; so RTT cảm giác với Spec 1 cùng máy.
- Tắt UDP (chỉ TCP): `turns` 5349.
- Viewer cũ không `webrtc`: agent chỉ Spec 1, regression.
- `webrtc.fail` / 8s: tự H.264 WS, không session chết.
- Hai Connect liên tiếp: PC cũ `close`, không hai capturer.

## 12. Thứ tự ship

1. Spec 1 APK 1.4.0 — encode HW trên WS.  
2. coturn staging + `iceServers` trên `session.start` (chưa bật PC).  
3. Spec 2 flag tắt mặc định, bật theo deviceId.  
4. Bật mặc định khi SM-S918B `pc=connected` ổn định.

Input DataChannel (unordered, maxRetransmits=0) là spec riêng sau, không gộp.
