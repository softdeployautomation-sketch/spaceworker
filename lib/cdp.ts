// TASK_119: CDP client extracted from scripts/clone-cdp.mjs
// Zero dependencies (node built-ins only). Proven traps:
// (a) HTTP upgrade socket stays CORKED — must uncork or writes never reach wire
// (b) /devtools/page endpoint completes handshake but silently ignores all commands
//     Use /devtools/browser + Storage.setCookies + Target.createTarget instead

import * as http from "node:http";
import * as crypto from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  expirationDate?: number;
}

export interface CdpInjectOpts {
  port: number;
  cookies: CdpCookie[];
  url?: string;
  timeoutMs?: number;
}

export interface CdpExportOpts {
  port: number;
  domain?: string;
  timeoutMs?: number;
}

class WsConn {
  socket: any;
  closed = false;
  raw = Buffer.alloc(0);
  fragOp = 0;
  frags: Buffer[] = [];
  onMessage: (text: string) => void = () => {};
  onClose: () => void = () => {};
  onError: (e: Error) => void = () => {};

  constructor(socket: any) {
    this.socket = socket;
    if (typeof socket.uncork === "function") socket.uncork();
    if (typeof socket.setNoDelay === "function") socket.setNoDelay(true);
    socket.on("data", (d: Buffer) => this._onData(d));
    socket.on("close", () => {
      if (this.closed) return;
      this.closed = true;
      this.onClose();
    });
    socket.on("error", (e: Error) => {
      if (this.closed) return;
      this.closed = true;
      this.onError(e);
    });
    socket.resume();
  }

  private _frame(opcode: number, payload: Buffer): Buffer {
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = crypto.randomBytes(4);
    const body = Buffer.alloc(len);
    for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i % 4];
    return Buffer.concat([header, mask, body]);
  }

  sendText(str: string): void {
    if (this.closed) throw new Error("socket closed");
    this.socket.write(this._frame(0x1, Buffer.from(str)));
  }

  private _onData(chunk: Buffer): void {
    this.raw = Buffer.concat([this.raw, chunk]);
    for (;;) {
      if (this.raw.length < 2) return;
      const fin = (this.raw[0] & 0x80) !== 0;
      const opcode = this.raw[0] & 0x0f;
      const masked = (this.raw[1] & 0x80) !== 0;
      let len = this.raw[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.raw.length < 4) return;
        len = this.raw.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.raw.length < 10) return;
        len = Number(this.raw.readBigUInt64BE(2));
        off = 10;
      }
      let maskKey: Buffer | null = null;
      if (masked) {
        if (this.raw.length < off + 4) return;
        maskKey = this.raw.subarray(off, off + 4);
        off += 4;
      }
      if (this.raw.length < off + len) return;
      const payload = Buffer.from(this.raw.subarray(off, off + len));
      this.raw = this.raw.subarray(off + len);
      if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];

      if (opcode === 0x9) continue;
      if (opcode === 0xa) continue;
      if (opcode === 0x8) {
        try {
          this.closed = true;
        } catch {}
        continue;
      }
      if (opcode === 0x0) this.frags.push(payload);
      else {
        this.fragOp = opcode;
        this.frags = [payload];
      }
      if (fin) {
        const full = Buffer.concat(this.frags);
        this.frags = [];
        if (this.fragOp === 0x1) this.onMessage(full.toString("utf8"));
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
  }
}

async function wsConnect(
  port: number,
  path: string,
  timeoutMs: number,
): Promise<WsConn> {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const req = http.request({
      host: "127.0.0.1",
      port,
      path,
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
      },
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`ws connect timeout on :${port}${path}`));
    }, timeoutMs);

    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.on("upgrade", (res, socket) => {
      clearTimeout(timer);
      const expect = crypto
        .createHash("sha1")
        .update(key + GUID)
        .digest("base64");
      if (res.headers["sec-websocket-accept"] !== expect) {
        reject(new Error("bad Sec-WebSocket-Accept"));
        return;
      }
      resolve(new WsConn(socket as any));
    });
    req.end();
  });
}

class Cdp {
  id = 0;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(
    private ws: WsConn,
    private timeoutMs: number,
  ) {
    ws.onMessage = (text: string) => {
      let msg: any;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg);
    };
  }

  async call(method: string, params?: Record<string, any>): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timeout`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.sendText(JSON.stringify({ id, method, params: params || {} }));
    });
  }
}

async function getBrowserEndpoint(port: number, timeoutMs: number): Promise<{ cdp: Cdp; ws: WsConn }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Browser endpoint timeout`)), timeoutMs);
    http
      .get(
        {
          host: "127.0.0.1",
          port,
          path: "/json/version",
        },
        (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => {
            clearTimeout(timer);
            try {
              const v = JSON.parse(body);
              const browserId = (v.webSocketDebuggerUrl || "").split("/devtools/browser/")[1];
              wsConnect(port, `/devtools/browser/${browserId}`, timeoutMs).then((ws) => {
                resolve({ cdp: new Cdp(ws, timeoutMs), ws });
              });
            } catch (e) {
              reject(e);
            }
          });
        },
      )
      .on("error", reject);
  });
}

export async function injectCookies(opts: CdpInjectOpts): Promise<{ ok: boolean; count: number }> {
  const timeoutMs = opts.timeoutMs || 10000;
  const { cdp, ws } = await getBrowserEndpoint(opts.port, timeoutMs);
  try {
    const now = Math.floor(Date.now() / 1000);
    const cookies = opts.cookies.map((c) => ({
      name: String(c.name),
      value: String(c.value),
      domain: String(c.domain),
      path: c.path || "/",
      secure: Boolean(c.secure),
      httpOnly: Boolean(c.httpOnly),
      expires: c.expirationDate || now + 86400 * 30,
    }));
    await cdp.call("Storage.setCookies", { cookies });
    return { ok: true, count: cookies.length };
  } finally {
    ws.close();
  }
}

export async function exportCookies(opts: CdpExportOpts): Promise<CdpCookie[]> {
  const timeoutMs = opts.timeoutMs || 10000;
  const { cdp, ws } = await getBrowserEndpoint(opts.port, timeoutMs);
  try {
    const result = await cdp.call("Storage.getCookies");
    let all = (result.cookies || []) as CdpCookie[];
    if (opts.domain) {
      const want = opts.domain.replace(/^\./, "").toLowerCase();
      all = all.filter((c) => {
        const d = (c.domain || "").replace(/^\./, "").toLowerCase();
        return d === want || d.endsWith(`.${want}`);
      });
    }
    return all;
  } finally {
    ws.close();
  }
}
