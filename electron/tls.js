// Pinned-TLS helpers for the Electron main process.
//
// Backends serve a self-signed cert; there is no CA and no user-provided
// domain. Pairing (tlsHandshake) fetches the daemon's unauthenticated
// /api/hello over plain HTTP — cert fingerprint + HMAC(device password,
// fp + our nonce) — then opens a raw TLS socket to see the cert actually
// presented and pins it only when the fingerprint matches and the MAC
// verifies. A MITM can't forge the MAC without the device password; a pure
// relay only ever forwards the real cert, so first connect has no trust
// gap. The pins map (host:port -> sha256 hex) is owned by main.js, which
// also enforces it in the certificate-error hook for every https/wss
// connection the renderer opens.
const crypto = require('crypto');
const tls = require('tls');

// certificate.data is PEM — strip the armor and hash the DER, same as the
// daemon's ssl.PEM_cert_to_DER_cert fingerprint.
function certFp(certificate) {
  try {
    const data = certificate && certificate.data;
    const der = Buffer.isBuffer(data)
      ? data
      : Buffer.from(String(data || '')
          .replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64');
    if (!der.length) return null;
    return crypto.createHash('sha256').update(der).digest('hex');
  } catch (_) {
    return null;
  }
}

// Fingerprint of the cert a host actually presents on a port — unverified,
// because the /api/hello MAC is what authenticates it.
function peerFp(host, port) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, rejectUnauthorized: false,
                               timeout: 5000 });
    const done = (fn, v) => { try { sock.destroy(); } catch (_) {} fn(v); };
    sock.once('secureConnect', () => {
      const c = sock.getPeerCertificate();
      if (!c || !c.raw || !c.raw.length) {
        return done(reject, new Error('no peer certificate'));
      }
      done(resolve, crypto.createHash('sha256').update(c.raw).digest('hex'));
    });
    sock.once('timeout', () => done(reject, new Error('timeout')));
    sock.once('error', (e) => done(reject, e));
  });
}

// Returns {ok:true, port, vncPort} on a verified pair, {unsupported:true}
// for pre-TLS backends, else {ok:false, error}. Side effect: pins the cert
// for both TLS ports in `pins`.
async function tlsHandshake(host, password, pins, httpPort = 8000) {
  const nonce = crypto.randomBytes(16).toString('hex');
  let hello;
  try {
    const r = await fetch(
      `http://${host}:${httpPort}/api/hello?n=${nonce}`,
      { signal: AbortSignal.timeout(5000) });
    if (r.status === 404) {
      // Newer daemons explain why TLS is down in the detail; genuinely old
      // backends just return FastAPI's "Not Found".
      let detail = '';
      try { detail = String((await r.json()).detail || ''); } catch (_) {}
      return { ok: false, unsupported: true,
               error: detail && detail !== 'Not Found'
                 ? `backend TLS unavailable: ${detail}` : '' };
    }
    if (!r.ok) return { ok: false, error: `hello returned ${r.status}` };
    hello = await r.json();
  } catch (e) {
    return { ok: false, error: `unreachable (${e.message || e})` };
  }
  const fp = String(hello.cert_sha256 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(fp)) return { ok: false, unsupported: true };
  const port = +hello.port || 8443;
  const vncPort = +hello.vnc_port || 6443;
  let seen;
  try {
    seen = await peerFp(host, port);
  } catch (e) {
    return { ok: false, error: `TLS endpoint failed (${e.message || e})` };
  }
  if (seen !== fp) {
    return { ok: false,
             error: 'TLS endpoint presented a different certificate' };
  }
  if (hello.mac) {
    const want = crypto.createHmac('sha256', String(password || ''))
      .update(`gut-tls-pin:${fp}:${nonce}`).digest('hex');
    const got = Buffer.from(String(hello.mac || '').toLowerCase(), 'utf8');
    const exp = Buffer.from(want, 'utf8');
    if (got.length !== exp.length || !crypto.timingSafeEqual(got, exp)) {
      return { ok: false,
               error: 'authentication failed — wrong device password?' };
    }
  }
  pins[`${host}:${port}`] = fp;
  pins[`${host}:${vncPort}`] = fp;
  return { ok: true, port, vncPort };
}

module.exports = { certFp, peerFp, tlsHandshake };
