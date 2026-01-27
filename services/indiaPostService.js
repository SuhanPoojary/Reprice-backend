const https = require('https');
const { URL } = require('url');

const DEFAULT_TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// In-memory cache: key -> { expiresAt:number, value:any }
const _cache = new Map();

function normalizePincode(raw) {
  const digits = String(raw ?? '')
    .trim()
    .replace(/\D/g, '');
  return digits;
}

function isValidIndianPincode(pin) {
  return /^\d{6}$/.test(String(pin ?? '').trim());
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

async function fetchJson(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return await new Promise((resolve, reject) => {
    let done = false;
    const u = new URL(url);

    const req = https.request(
      {
        method: 'GET',
        protocol: u.protocol,
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { Accept: 'application/json' },
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
            const err = new Error(`IndiaPost HTTP ${status}${raw ? `: ${raw}` : ''}`);
            err.code = 'INDIAPOST_HTTP_ERROR';
            reject(err);
            return;
          }

          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            const err = new Error('IndiaPost returned invalid JSON');
            err.code = 'INDIAPOST_BAD_JSON';
            err.details = String(e?.message ?? e);
            reject(err);
          }
        });
      },
    );

    req.on('error', (e) => {
      if (done) return;
      done = true;
      reject(e);
    });

    req.setTimeout(timeoutMs, () => {
      if (done) return;
      done = true;
      const err = new Error('IndiaPost request timed out');
      err.code = 'INDIAPOST_TIMEOUT';
      req.destroy(err);
      reject(err);
    });

    req.end();
  });
}

function shapeLookupResponse(payload) {
  // API usually returns an array like: [{ Status, Message, PostOffice }]
  const root = Array.isArray(payload) ? payload[0] : payload;
  const status = String(root?.Status ?? '').trim();
  const message = String(root?.Message ?? '').trim();
  const postOffice = Array.isArray(root?.PostOffice) ? root.PostOffice : null;

  return { status, message, postOffice };
}

async function lookupByPincode(pincode, { useCache = true } = {}) {
  const pin = normalizePincode(pincode);
  if (!isValidIndianPincode(pin)) {
    return { ok: false, pin, errorType: 'INVALID_PIN', message: 'Invalid 6-digit pincode' };
  }

  const cacheKey = `pin:${pin}`;
  if (useCache) {
    const cached = _getCache(cacheKey);
    if (cached) return cached;
  }

  try {
    const payload = await fetchJson(`https://api.postalpincode.in/pincode/${pin}`);
    const { status, message, postOffice } = shapeLookupResponse(payload);

    if (String(status).toLowerCase() !== 'success' || !postOffice || postOffice.length === 0) {
      const result = { ok: false, pin, errorType: 'NOT_FOUND', message: message || 'No records found' };
      if (useCache) _setCache(cacheKey, result, 10 * 60 * 1000); // cache negative for 10 mins
      return result;
    }

    // Pick first PO for district/state metadata.
    const first = postOffice[0] ?? {};
    const result = {
      ok: true,
      pin,
      message,
      postOfficeCount: postOffice.length,
      district: first.District ?? null,
      state: first.State ?? null,
      region: first.Region ?? null,
      circle: first.Circle ?? null,
      samplePostOfficeName: first.Name ?? null,
    };

    if (useCache) _setCache(cacheKey, result);
    return result;
  } catch (err) {
    const details = String(err?.message ?? err);
    const result = {
      ok: false,
      pin,
      errorType: err?.code === 'INDIAPOST_TIMEOUT' ? 'TIMEOUT' : 'NETWORK',
      message: 'PIN Code validation service is unavailable. Please try again.',
      details,
    };
    if (useCache) _setCache(cacheKey, result, 60 * 1000); // cache failures briefly
    return result;
  }
}

module.exports = {
  normalizePincode,
  isValidIndianPincode,
  lookupByPincode,
};
