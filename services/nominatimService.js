const https = require('https');
const { URL } = require('url');

const DEFAULT_TIMEOUT_MS = 7000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const NEGATIVE_TTL_MS = 60 * 60 * 1000; // 1 hour

// In-memory cache: key -> { expiresAt:number, value:any }
const _cache = new Map();

// Nominatim usage policy requires an identifying User-Agent.
function getUserAgent() {
  const fromEnv = String(process.env.NOMINATIM_USER_AGENT || '').trim();
  if (fromEnv) return fromEnv;
  return 'MobileTrade/1.0 (contact: admin@reprice.local)';
}

function _getCache(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() >= hit.expiresAt) {
    _cache.delete(key);
    return null;
  }
  return hit.value;
}

function _setCache(key, value, ttlMs = CACHE_TTL_MS) {
  _cache.set(key, { expiresAt: Date.now() + ttlMs, value });
}

// Simple throttle to be gentle with Nominatim.
let _lastRequestAt = 0;
async function throttle(minGapMs = 1100) {
  const now = Date.now();
  const waitMs = Math.max(0, _lastRequestAt + minGapMs - now);
  if (waitMs > 0) {
    await new Promise((r) => setTimeout(r, waitMs));
  }
  _lastRequestAt = Date.now();
}

async function fetchJson(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  await throttle();

  return await new Promise((resolve, reject) => {
    let done = false;
    const u = new URL(url);

    const req = https.request(
      {
        method: 'GET',
        protocol: u.protocol,
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          Accept: 'application/json',
          'User-Agent': getUserAgent(),
        },
      },
      (res) => {
        const status = Number(res.statusCode ?? 0);
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          if (done) return;
          done = true;

          if (status < 200 || status >= 300) {
            const err = new Error(`Nominatim HTTP ${status}${raw ? `: ${raw}` : ''}`);
            err.code = 'NOMINATIM_HTTP_ERROR';
            reject(err);
            return;
          }

          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            const err = new Error('Nominatim returned invalid JSON');
            err.code = 'NOMINATIM_BAD_JSON';
            err.details = String(e?.message ?? e);
            reject(err);
          }
        });
      }
    );

    req.on('error', (e) => {
      if (done) return;
      done = true;
      reject(e);
    });

    req.setTimeout(timeoutMs, () => {
      if (done) return;
      done = true;
      const err = new Error('Nominatim request timed out');
      err.code = 'NOMINATIM_TIMEOUT';
      req.destroy(err);
      reject(err);
    });

    req.end();
  });
}

function isValidIndianPincode(pin) {
  return /^\d{6}$/.test(String(pin ?? '').trim());
}

async function lookupPincodeLatLon(pincode, { useCache = true } = {}) {
  const pin = String(pincode ?? '').trim();
  if (!isValidIndianPincode(pin)) {
    return { ok: false, pin, errorType: 'INVALID_PIN', message: 'Invalid 6-digit pincode' };
  }

  const cacheKey = `geo:${pin}`;
  if (useCache) {
    const cached = _getCache(cacheKey);
    if (cached) return cached;
  }

  try {
    const url = `https://nominatim.openstreetmap.org/search?postalcode=${encodeURIComponent(
      pin
    )}&country=${encodeURIComponent('India')}&format=json&limit=1`;

    const payload = await fetchJson(url);
    const first = Array.isArray(payload) ? payload[0] : null;

    const lat = first?.lat != null ? Number(first.lat) : NaN;
    const lon = first?.lon != null ? Number(first.lon) : NaN;

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      const result = { ok: false, pin, errorType: 'NOT_FOUND', message: 'No coordinates found for pincode' };
      if (useCache) _setCache(cacheKey, result, NEGATIVE_TTL_MS);
      return result;
    }

    const result = { ok: true, pin, lat, lon };
    if (useCache) _setCache(cacheKey, result);
    return result;
  } catch (err) {
    const result = {
      ok: false,
      pin,
      errorType: err?.code === 'NOMINATIM_TIMEOUT' ? 'TIMEOUT' : 'NETWORK',
      message: 'Pincode geocoding service is unavailable. Please try again.',
      details: String(err?.message ?? err),
    };
    if (useCache) _setCache(cacheKey, result, 5 * 60 * 1000);
    return result;
  }
}

module.exports = {
  lookupPincodeLatLon,
};
