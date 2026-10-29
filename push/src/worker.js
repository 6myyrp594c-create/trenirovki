var encoder = new TextEncoder();

function concat(parts) {
  var len = 0;
  var i;
  for (i = 0; i < parts.length; i++) len += parts[i].length;
  var out = new Uint8Array(len);
  var offset = 0;
  for (i = 0; i < parts.length; i++) {
    out.set(parts[i], offset);
    offset += parts[i].length;
  }
  return out;
}

function bytesToB64url(bytes) {
  var bin = "";
  var i;
  for (i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlToBytes(value) {
  var padded = String(value).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  var bin = atob(padded);
  var out = new Uint8Array(bin.length);
  var i;
  for (i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function u32be(value) {
  var bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

async function hmac(keyBytes, data) {
  var key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}

async function hkdf(salt, ikm, info, length) {
  var prk = await hmac(salt, ikm);
  var okm = await hmac(prk, concat([info, new Uint8Array([1])]));
  return okm.slice(0, length);
}

function publicFromJwk(jwk) {
  return concat([new Uint8Array([4]), b64urlToBytes(jwk.x), b64urlToBytes(jwk.y)]);
}

async function loadKeys(jwk) {
  var ecdsa = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  var ecdh = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d, ext: true },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );
  return { ecdsa: ecdsa, ecdh: ecdh, pub: publicFromJwk(jwk) };
}

async function encryptPayload(plaintext, uaPublicB64, authB64, asPublic, asPrivate, salt) {
  var uaPublic = b64urlToBytes(uaPublicB64);
  var auth = b64urlToBytes(authB64);
  var userKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  var shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: userKey }, asPrivate, 256));
  var ikm = await hkdf(auth, shared, concat([encoder.encode("WebPush: info\0"), uaPublic, asPublic]), 32);
  var cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  var nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  var aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  var ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat([plaintext, new Uint8Array([2])])));
  return concat([salt, u32be(4096), new Uint8Array([asPublic.length]), asPublic, ciphertext]);
}

async function vapidJwt(endpoint, keys) {
  var header = bytesToB64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  var body = bytesToB64url(encoder.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: "mailto:347421389+6myyrp594c-create@users.noreply.github.com"
  })));
  var sig = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keys.ecdsa,
    encoder.encode(header + "." + body)
  ));
  return header + "." + body + "." + bytesToB64url(sig);
}

async function sendPush(job, env) {
  var jwk = JSON.parse(String(env.VAPID_JWK).trim());
  var keys = await loadKeys(jwk);
  var salt = crypto.getRandomValues(new Uint8Array(16));
  var payload = encoder.encode(JSON.stringify({ title: job.title, body: job.body, tag: "workout-rest" }));
  var body = await encryptPayload(payload, job.subscription.keys.p256dh, job.subscription.keys.auth, keys.pub, keys.ecdh, salt);
  var jwt = await vapidJwt(job.subscription.endpoint, keys);
  var res = await fetch(job.subscription.endpoint, {
    method: "POST",
    headers: {
      TTL: "120",
      Urgency: "high",
      Topic: "workout-rest",
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      Authorization: "vapid t=" + jwt + ", k=" + bytesToB64url(keys.pub)
    },
    body: body
  });
  if (!res.ok) console.log("push failed", res.status);
  return res.status;
}

function cors(response) {
  var headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  return new Response(response.body, { status: response.status, headers: headers });
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "content-type": "application/json" }
  });
}

function cleanText(value, max) {
  return String(value || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
}

function allowedEndpoint(value) {
  var url;
  try { url = new URL(value); } catch (err) { return false; }
  if (url.protocol !== "https:") return false;
  var host = url.hostname;
  if (host === "web.push.apple.com" || host === "fcm.googleapis.com" || host === "android.googleapis.com") return true;
  if (host === "updates.push.services.mozilla.com" || host === "push.services.mozilla.com") return true;
  if (host.endsWith(".notify.windows.com") || host.endsWith(".wns.windows.com")) return true;
  return false;
}

function validateJob(body) {
  if (!body || typeof body !== "object") return { error: "bad job" };
  var id = String(body.id || "");
  if (!/^[A-Za-z0-9-]{8,80}$/.test(id)) return { error: "bad id" };
  var fireAt = Number(body.fireAt);
  var now = Date.now();
  if (!Number.isFinite(fireAt) || fireAt < now - 5000 || fireAt > now + 6 * 60 * 60 * 1000) return { error: "bad time" };
  var sub = body.subscription;
  if (!sub || !allowedEndpoint(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return { error: "bad subscription" };
  return {
    id: id,
    fireAt: Math.max(fireAt, now),
    title: cleanText(body.title, 80) || "Тренировки",
    body: cleanText(body.body, 160) || "Таймер завершён",
    subscription: { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } }
  };
}

export class Scheduler {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    var url = new URL(request.url);
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (request.method !== "POST") return cors(json({ ok: true }));
    var body;
    try { body = await request.json(); } catch (err) { return cors(json({ error: "bad json" }, 400)); }
    if (url.pathname === "/cancel") {
      if (body.id && /^[A-Za-z0-9-]{8,80}$/.test(String(body.id))) {
        await this.state.storage.delete("job:" + body.id);
      }
      return cors(json({ ok: true }));
    }
    if (url.pathname !== "/schedule") return cors(json({ error: "not found" }, 404));
    var job = validateJob(body);
    if (job.error) return cors(json(job, 400));
    var existing = await this.state.storage.list({ prefix: "job:" });
    if (existing.size >= 200 && !existing.has("job:" + job.id)) {
      return cors(json({ error: "busy" }, 429));
    }
    await this.state.storage.put("job:" + job.id, job);
    await this.arm(job.fireAt);
    return cors(json({ ok: true, id: job.id }));
  }

  async arm(fireAt) {
    var current = await this.state.storage.getAlarm();
    var when = Math.max(fireAt, Date.now() + 10);
    if (current == null || when < current) await this.state.storage.setAlarm(when);
  }

  async alarm() {
    var now = Date.now();
    var jobs = await this.state.storage.list({ prefix: "job:" });
    var next = null;
    var entries = [];
    jobs.forEach(function (value, key) { entries.push([key, value]); });
    var i;
    for (i = 0; i < entries.length; i++) {
      var key = entries[i][0];
      var job = entries[i][1];
      if (!job || job.fireAt <= now + 1000) {
        try { await sendPush(job, this.env); } catch (err) { console.log("push error"); }
        await this.state.storage.delete(key);
      } else if (next == null || job.fireAt < next) {
        next = job.fireAt;
      }
    }
    if (next != null) await this.state.storage.setAlarm(next);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    var url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/ready")) {
      if (url.pathname === "/ready") {
        try {
          await loadKeys(JSON.parse(String(env.VAPID_JWK).trim()));
        } catch (err) {
          return cors(json({ ok: false }, 500));
        }
      }
      return cors(json({ ok: true }));
    }
    if (!env.SCHEDULER) return cors(json({ error: "not configured" }, 500));
    var stub = env.SCHEDULER.get(env.SCHEDULER.idFromName("timers"));
    return stub.fetch(request);
  }
};

export { encryptPayload, loadKeys, b64urlToBytes, bytesToB64url };
