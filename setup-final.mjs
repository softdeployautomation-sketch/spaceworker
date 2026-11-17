import { SignJWT } from "jose";
import { TextEncoder } from "node:util";

const SESSION_SECRET = "ef6151afae0c2187c4ab64579b216a7a96ec924e513f1e15a81e4897f26585a6";
const encoder = new TextEncoder();

const token = await new SignJWT({
  email: "myrate619@gmail.com",
  emailVerified: true,
})
  .setProtectedHeader({ alg: "HS256" })
  .setSubject("cmtl47mcc0000kpr1ds5s2xic")
  .setIssuedAt()
  .setExpirationTime("7d")
  .setIssuer("spaceworker")
  .setAudience("spaceworker")
  .sign(encoder.encode(SESSION_SECRET));

console.log("SESSION TOKEN created");

const controller = new AbortController();
setTimeout(() => controller.abort(), 240000); // 4 minute timeout

try {
  const res = await fetch("https://spaceworker.top/api/devices/cmw38s30r01e4kimr6k1z7g10/clone-setup", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cookie": `spaceworker_session=${token}`,
    },
    body: JSON.stringify({ role: "source" }),
    signal: controller.signal,
  });

  const body = await res.text();
  console.log("STATUS:", res.status);
  console.log("RESPONSE:", body);
} catch (e) {
  console.log("ERROR:", e instanceof Error ? e.message : String(e));
}
