/**
 * ============================================================================
 * NYC FloodGuard 2.0 — Live NYC Weather Integration (Open-Meteo)
 * File: nycWeather.js
 *
 * Retrieves authentic, real-time New York City weather observations and hourly
 * precipitation forecasts directly from the public Open-Meteo Forecast API.
 * - Coordinates: New York City (40.7128° N, 74.0060° W), America/New_York
 * - No API key required; works in local dev, full-stack server, and GitHub Pages.
 * - Never fabricates weather data if the API request fails.
 * ============================================================================
 */

const NYC_LAT = 40.7128;
const NYC_LON = -74.006;
const OPEN_METEO_ENDPOINT =
  `https://api.open-meteo.com/v1/forecast` +
  `?latitude=${NYC_LAT}&longitude=${NYC_LON}` +
  `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,weather_code,wind_speed_10m` +
  `&hourly=temperature_2m,precipitation_probability,precipitation,rain,weather_code` +
  `&forecast_days=2&timezone=America%2FNew_York`;

export const WEATHER_SOURCE_NAME = 'Open-Meteo Forecast API (NYC 40.71°N, 74.01°W)';

/**
 * Maps WMO Weather Interpretation Codes (0–99) to readable conditions.
 */
export function describeWmoWeatherCode(code) {
  const c = Number(code);
  const map = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Fog',
    48: 'Depositing rime fog',
    51: 'Light drizzle',
    53: 'Moderate drizzle',
    55: 'Dense drizzle',
    56: 'Light freezing drizzle',
    57: 'Dense freezing drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    66: 'Light freezing rain',
    67: 'Heavy freezing rain',
    71: 'Slight snowfall',
    73: 'Moderate snowfall',
    75: 'Heavy snowfall',
    77: 'Snow grains',
    80: 'Slight rain showers',
    81: 'Moderate rain showers',
    82: 'Violent rain showers',
    85: 'Slight snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with slight hail',
    99: 'Thunderstorm with heavy hail'
  };
  return map[c] || `Weather code ${c}`;
}

export function isSevereWeatherCode(code) {
  const c = Number(code);
  return c === 65 || c === 67 || c === 82 || c === 95 || c === 96 || c === 99;
}

export function cToF(celsius) {
  if (!Number.isFinite(celsius)) return null;
  return Number(((celsius * 9) / 5 + 32).toFixed(1));
}

export function mmToInches(mm) {
  if (!Number.isFinite(mm)) return null;
  return Number((mm / 25.4).toFixed(2));
}

/**
 * Classifies rainfall severity transparently using standard meteorological intensity bands:
 *   - Heavy / Severe: >= 7.6 mm/hr (~0.30 in/hr), 6h total >= 15 mm (~0.59 in), or severe thunderstorm/heavy-rain WMO code
 *   - Moderate:       >= 2.5 mm/hr (~0.10 in/hr) or 6h total >= 6 mm
 *   - Light:          > 0.1 mm/hr or rain probability >= 50%
 *   - Dry / Low:      Otherwise
 */
export function evaluateRainfallSeverity({
  currentPrecipMm = 0,
  currentCode = 0,
  next6hPrecipMm = 0,
  peakHourlyRateMm = 0,
  maxRainProb6h = 0,
  hasSevereCodeInNext6h = false
}) {
  if (
    peakHourlyRateMm >= 7.6 ||
    currentPrecipMm >= 7.6 ||
    next6hPrecipMm >= 15.0 ||
    isSevereWeatherCode(currentCode) ||
    hasSevereCodeInNext6h
  ) {
    return {
      level: 'SEVERE',
      label: 'Heavy / Severe Rainfall Forecast',
      detail: `Forecast peak ${peakHourlyRateMm.toFixed(1)} mm/hr (${next6hPrecipMm.toFixed(1)} mm / 6h) — elevated NYC street-ponding potential.`
    };
  }

  if (peakHourlyRateMm >= 2.5 || currentPrecipMm >= 2.5 || next6hPrecipMm >= 6.0) {
    return {
      level: 'MODERATE',
      label: 'Moderate Rainfall Expected',
      detail: `Forecast peak ${peakHourlyRateMm.toFixed(1)} mm/hr (${next6hPrecipMm.toFixed(1)} mm / 6h) — monitor storm drains closely.`
    };
  }

  if (peakHourlyRateMm > 0.1 || currentPrecipMm > 0.1 || maxRainProb6h >= 50) {
    return {
      level: 'LIGHT',
      label: 'Light / Scattered Rain Possible',
      detail: `Up to ${maxRainProb6h}% rain probability over the next 6 hours (${next6hPrecipMm.toFixed(1)} mm projected).`
    };
  }

  return {
    level: 'LOW',
    label: 'No Severe Rainfall Forecast',
    detail: `Dry or minimal precipitation expected over the next 6 hours (${next6hPrecipMm.toFixed(1)} mm, max ${maxRainProb6h}% probability).`
  };
}

/**
 * Fetches live NYC weather and upcoming 12-hour & 24-hour hourly forecast from Open-Meteo.
 */
export async function fetchLiveNycWeather({ signal } = {}) {
  const startedAt = performance.now();
  const response = await fetch(OPEN_METEO_ENDPOINT, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });

  if (!response.ok) {
    throw new Error(`Open-Meteo API responded with HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (!payload || !payload.current || !payload.hourly || !Array.isArray(payload.hourly.time)) {
    throw new Error('Unexpected response format from Open-Meteo API.');
  }

  const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
  const cur = payload.current;
  const currentTimeIso = String(cur.time || '');

  // Align hourly array starting from current NYC local hour
  const hourlyTimes = payload.hourly.time;
  const currentHourPrefix = currentTimeIso.slice(0, 13); // "YYYY-MM-DDTHH"
  let startIdx = hourlyTimes.findIndex((t) => String(t).startsWith(currentHourPrefix));
  if (startIdx < 0) startIdx = 0;

  const upcoming24h = [];
  for (let i = startIdx; i < Math.min(hourlyTimes.length, startIdx + 24); i++) {
    const timeStr = hourlyTimes[i];
    const precipMm = Number(payload.hourly.precipitation?.[i] ?? 0);
    const rainMm = Number(payload.hourly.rain?.[i] ?? 0);
    const probPct = Number(payload.hourly.precipitation_probability?.[i] ?? 0);
    const tempC = Number(payload.hourly.temperature_2m?.[i] ?? NaN);
    const code = Number(payload.hourly.weather_code?.[i] ?? 0);

    upcoming24h.push({
      timeIso: timeStr,
      hourLabel: formatLocalHourLabel(timeStr),
      precipMm: Number.isFinite(precipMm) ? Number(precipMm.toFixed(2)) : 0,
      rainMm: Number.isFinite(rainMm) ? Number(rainMm.toFixed(2)) : 0,
      precipProbPct: Number.isFinite(probPct) ? Math.round(probPct) : 0,
      tempC: Number.isFinite(tempC) ? Number(tempC.toFixed(1)) : null,
      tempF: cToF(tempC),
      weatherCode: code,
      condition: describeWmoWeatherCode(code)
    });
  }

  const next6h = upcoming24h.slice(0, 6);
  const next12h = upcoming24h.slice(0, 12);

  const next6hPrecipMm = Number(
    next6h.reduce((sum, h) => sum + h.precipMm, 0).toFixed(2)
  );
  const next24hPrecipMm = Number(
    upcoming24h.reduce((sum, h) => sum + h.precipMm, 0).toFixed(2)
  );
  const maxRainProb6h = next6h.reduce((m, h) => Math.max(m, h.precipProbPct), 0);
  const maxRainProb24h = upcoming24h.reduce((m, h) => Math.max(m, h.precipProbPct), 0);

  let peakHour = next6h[0] || upcoming24h[0] || null;
  for (const h of next6h) {
    if (!peakHour || h.precipMm > peakHour.precipMm) {
      peakHour = h;
    }
  }
  const peakHourlyRateMm = peakHour ? peakHour.precipMm : 0;
  const hasSevereCodeInNext6h = next6h.some((h) => isSevereWeatherCode(h.weatherCode));

  const currentTempC = Number(cur.temperature_2m);
  const currentFeelsC = Number(cur.apparent_temperature);
  const currentPrecipMm = Number(cur.precipitation ?? 0);
  const currentRainMm = Number(cur.rain ?? 0);
  const currentHumidity = Number(cur.relative_humidity_2m ?? NaN);
  const currentWindKmh = Number(cur.wind_speed_10m ?? NaN);
  const currentCode = Number(cur.weather_code ?? 0);

  const severity = evaluateRainfallSeverity({
    currentPrecipMm,
    currentCode,
    next6hPrecipMm,
    peakHourlyRateMm,
    maxRainProb6h,
    hasSevereCodeInNext6h
  });

  return {
    source: WEATHER_SOURCE_NAME,
    locationLabel: 'New York City (Manhattan / City Hall)',
    timezone: payload.timezone || 'America/New_York',
    observationTimeIso: currentTimeIso,
    fetchedAtMs: Date.now(),
    latencyMs,
    current: {
      tempC: Number.isFinite(currentTempC) ? Number(currentTempC.toFixed(1)) : null,
      tempF: cToF(currentTempC),
      feelsLikeC: Number.isFinite(currentFeelsC) ? Number(currentFeelsC.toFixed(1)) : null,
      feelsLikeF: cToF(currentFeelsC),
      humidityPct: Number.isFinite(currentHumidity) ? Math.round(currentHumidity) : null,
      windKmh: Number.isFinite(currentWindKmh) ? Number(currentWindKmh.toFixed(1)) : null,
      windMph: Number.isFinite(currentWindKmh) ? Number((currentWindKmh * 0.621371).toFixed(1)) : null,
      precipMm: Number.isFinite(currentPrecipMm) ? Number(currentPrecipMm.toFixed(2)) : 0,
      rainMm: Number.isFinite(currentRainMm) ? Number(currentRainMm.toFixed(2)) : 0,
      weatherCode: currentCode,
      condition: describeWmoWeatherCode(currentCode)
    },
    summary: {
      next6hPrecipMm,
      next6hPrecipIn: mmToInches(next6hPrecipMm),
      next24hPrecipMm,
      next24hPrecipIn: mmToInches(next24hPrecipMm),
      peakHourlyRateMm,
      peakHourLabel: peakHour ? peakHour.hourLabel : '—',
      maxRainProb6h,
      maxRainProb24h
    },
    severity,
    hourly12h: next12h,
    hourly24h: upcoming24h
  };
}

function formatLocalHourLabel(isoStr) {
  if (!isoStr || typeof isoStr !== 'string') return '--';
  const match = isoStr.match(/T(\d{2}):(\d{2})/);
  if (!match) return isoStr;
  const hour24 = Number(match[1]);
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12} ${suffix}`;
}
