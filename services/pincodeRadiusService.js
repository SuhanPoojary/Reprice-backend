const { normalizePincode, isValidIndianPincode } = require('./indiaPostService');
const { lookupPincodeLatLon } = require('./nominatimService');

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (Number(d) * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function isWithinKmByPincodes(pinA, pinB, km) {
  const a = normalizePincode(pinA);
  const b = normalizePincode(pinB);
  const limit = Number(km);

  if (!isValidIndianPincode(a) || !isValidIndianPincode(b) || !Number.isFinite(limit) || limit <= 0) {
    return { ok: false, within: false, reason: 'INVALID_INPUT' };
  }

  if (a === b) return { ok: true, within: true, distanceKm: 0 };

  const [geoA, geoB] = await Promise.all([lookupPincodeLatLon(a), lookupPincodeLatLon(b)]);
  if (!geoA.ok || !geoB.ok) {
    return { ok: false, within: false, reason: 'GEO_LOOKUP_FAILED', details: { geoA, geoB } };
  }

  const distanceKm = haversineKm(geoA.lat, geoA.lon, geoB.lat, geoB.lon);
  return { ok: true, within: distanceKm <= limit, distanceKm };
}

async function isServiceableForPartnerPins(targetPincode, partnerPincodes, km) {
  const target = normalizePincode(targetPincode);
  const limit = Number(km);

  if (!isValidIndianPincode(target) || !Array.isArray(partnerPincodes) || !Number.isFinite(limit) || limit <= 0) {
    return { ok: false, serviceable: false, reason: 'INVALID_INPUT' };
  }

  const partnerPins = Array.from(
    new Set(
      partnerPincodes
        .map((p) => normalizePincode(p))
        .filter((p) => isValidIndianPincode(p))
    )
  );

  if (partnerPins.length === 0) {
    return { ok: true, serviceable: false, reason: 'NO_PARTNER_PINS' };
  }

  if (partnerPins.includes(target)) {
    return { ok: true, serviceable: true, reason: 'EXACT_PIN_MATCH' };
  }

  const targetGeo = await lookupPincodeLatLon(target);
  if (!targetGeo.ok) {
    return { ok: false, serviceable: false, reason: 'TARGET_GEO_FAILED', details: targetGeo };
  }

  for (const pin of partnerPins) {
    const geo = await lookupPincodeLatLon(pin);
    if (!geo.ok) continue;

    const distanceKm = haversineKm(targetGeo.lat, targetGeo.lon, geo.lat, geo.lon);
    if (distanceKm <= limit) {
      return { ok: true, serviceable: true, reason: 'WITHIN_RADIUS', distanceKm, matchedPin: pin };
    }
  }

  return { ok: true, serviceable: false, reason: 'OUTSIDE_RADIUS' };
}

module.exports = {
  haversineKm,
  isWithinKmByPincodes,
  isServiceableForPartnerPins,
};
