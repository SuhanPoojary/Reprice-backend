const https = require('https');
const { URL } = require('url');

const DEFAULT_TIMEOUT_MS = 7000;

function getApiKey() {
  const key = String(process.env.GEOCODE_MAPS_CO_API_KEY || '').trim();
  return key || null;
}

function getUserAgent() {
  const fromEnv = String(process.env.GEOCODE_MAPS_CO_USER_AGENT || '').trim();
  if (fromEnv) return fromEnv;
  return 'MobileTrade/1.0 (contact: admin@reprice.local)';
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
            const err = new Error(`Geocode HTTP ${status}${raw ? `: ${raw}` : ''}`);
            err.code = status === 429 ? 'GEOCODE_RATE_LIMIT' : 'GEOCODE_HTTP_ERROR';
            err.status = status;
            reject(err);
            return;
          }

          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            const err = new Error('Geocode returned invalid JSON');
            err.code = 'GEOCODE_BAD_JSON';
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
      const err = new Error('Geocode request timed out');
      err.code = 'GEOCODE_TIMEOUT';
      req.destroy(err);
      reject(err);
    });

    req.end();
  });
}

function buildQuery({ address, city, state, pincode, country }) {
  const parts = [address, city, state, pincode, country].map((x) => String(x || '').trim()).filter(Boolean);
  return parts.join(', ');
}

/**
 * Forward geocode (address -> coordinates) using https://geocode.maps.co/search
 *
 * Returns: { ok:true, lat:number, lon:number, raw:firstResult } | { ok:false, errorType, message, details? }
 */
async function geocodeAddress({ address, city, state, pincode, country = 'India' }) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      ok: false,
      errorType: 'MISSING_API_KEY',
      message: 'Geocoding API key is not configured',
    };
  }

  const q = buildQuery({ address, city, state, pincode, country });
  if (!q) {
    return { ok: false, errorType: 'INVALID_QUERY', message: 'Address query is empty' };
  }

  try {
    const url = `https://geocode.maps.co/search?q=${encodeURIComponent(q)}&api_key=${encodeURIComponent(apiKey)}`;
    const payload = await fetchJson(url);
    const first = Array.isArray(payload) ? payload[0] : null;

    const lat = first?.lat != null ? Number(first.lat) : NaN;
    const lon = first?.lon != null ? Number(first.lon) : NaN;

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return { ok: false, errorType: 'NOT_FOUND', message: 'No coordinates found for address' };
    }

    return { ok: true, lat, lon, raw: first };
  } catch (err) {
    const code = String(err?.code || '');
    return {
      ok: false,
      errorType:
        code === 'GEOCODE_RATE_LIMIT'
          ? 'RATE_LIMIT'
          : code === 'GEOCODE_TIMEOUT'
            ? 'TIMEOUT'
            : 'NETWORK',
      message:
        code === 'GEOCODE_RATE_LIMIT'
          ? 'Geocoding rate limit exceeded. Please try again shortly.'
          : 'Geocoding service is unavailable. Please try again.',
      details: String(err?.message ?? err),
    };
  }
}

function pickFirstString(...values) {
  for (const v of values) {
    const s = String(v || '').trim();
    if (s) return s;
  }
  return '';
}

/**
 * Reverse geocode (coordinates -> address parts) using https://geocode.maps.co/reverse
 *
 * Returns: { ok:true, street, city, state, pincode, displayName, raw } | { ok:false, errorType, message, details? }
 */
async function reverseGeocode({ lat, lon }) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      ok: false,
      errorType: 'MISSING_API_KEY',
      message: 'Geocoding API key is not configured',
    };
  }

  const nLat = Number(lat);
  const nLon = Number(lon);
  if (!Number.isFinite(nLat) || !Number.isFinite(nLon)) {
    return { ok: false, errorType: 'INVALID_COORDS', message: 'Coordinates are invalid' };
  }

  try {
    const url = `https://geocode.maps.co/reverse?lat=${encodeURIComponent(String(nLat))}&lon=${encodeURIComponent(String(nLon))}&api_key=${encodeURIComponent(apiKey)}`;
    const payload = await fetchJson(url);

    const addr = payload?.address || {};
    const displayName = String(payload?.display_name || '').trim();

    const road = pickFirstString(addr.road, addr.pedestrian, addr.footway, addr.path);
    const neighborhood = pickFirstString(addr.neighbourhood, addr.neighborhood, addr.suburb, addr.quarter, addr.hamlet);
    const street = [road, neighborhood].map((x) => String(x || '').trim()).filter(Boolean).join(', ');

    const city = pickFirstString(addr.city, addr.town, addr.village, addr.county, addr.municipality, addr.state_district);
    const state = pickFirstString(addr.state, addr.region);
    const pincode = pickFirstString(addr.postcode);

    if (!street && !city && !state && !pincode && !displayName) {
      return { ok: false, errorType: 'NOT_FOUND', message: 'No address found for coordinates' };
    }

    return {
      ok: true,
      street,
      city,
      state,
      pincode,
      displayName,
      raw: payload,
    };
  } catch (err) {
    const code = String(err?.code || '');
    return {
      ok: false,
      errorType:
        code === 'GEOCODE_RATE_LIMIT'
          ? 'RATE_LIMIT'
          : code === 'GEOCODE_TIMEOUT'
            ? 'TIMEOUT'
            : 'NETWORK',
      message:
        code === 'GEOCODE_RATE_LIMIT'
          ? 'Geocoding rate limit exceeded. Please try again shortly.'
          : 'Geocoding service is unavailable. Please try again.',
      details: String(err?.message ?? err),
    };
  }
}

module.exports = {
  geocodeAddress,
  reverseGeocode,
};
