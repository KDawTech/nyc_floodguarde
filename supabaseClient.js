/**
 * ============================================================================
 * NYC FloodGuard — Read-Only Supabase Client & Data Service
 * File: supabaseClient.js
 *
 * Connects to Supabase using @supabase/supabase-js and client-safe publishable
 * credentials with Row Level Security (RLS) enabled.
 * Strictly read-only: queries `sensors` and `water_readings` tables only.
 * ============================================================================
 */
import { createClient } from '@supabase/supabase-js';

function cleanEnvValue(raw) {
  return String(raw || '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .trim();
}

function normalizeSupabaseUrl(raw) {
  let cleaned = cleanEnvValue(raw);
  // Recover gracefully if copy-paste dropped the leading 'h' in https://
  if (/^ttps:\/\//i.test(cleaned)) {
    cleaned = 'h' + cleaned;
  }
  return cleaned.replace(/\/+$/, '');
}

const rawSupabaseUrl = cleanEnvValue(import.meta.env.VITE_SUPABASE_URL);
const supabaseUrl = normalizeSupabaseUrl(rawSupabaseUrl);
const supabaseKey = cleanEnvValue(
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    import.meta.env.VITE_SUPABASE_ANON_KEY
);

let cachedClient = null;
let clientInitError = null;

export function getSupabaseDiagnostics() {
  let hostLabel = 'not set';
  if (supabaseUrl) {
    try {
      hostLabel = new URL(supabaseUrl).host;
    } catch {
      hostLabel = rawSupabaseUrl;
    }
  }
  return {
    hasUrl: Boolean(supabaseUrl),
    hasKey: Boolean(supabaseKey),
    urlCorrectedFromMissingH: /^ttps:\/\//i.test(rawSupabaseUrl),
    hostLabel,
    keyPrefix: supabaseKey ? `${supabaseKey.slice(0, 14)}…` : 'not set'
  };
}

export function isSupabaseConfigured() {
  return Boolean(supabaseUrl && supabaseKey);
}

function getSupabaseClient() {
  if (cachedClient) return { client: cachedClient, error: null };
  if (clientInitError) return { client: null, error: clientInitError };

  if (!supabaseUrl || !supabaseKey) {
    const missing = [];
    if (!supabaseUrl) missing.push('VITE_SUPABASE_URL');
    if (!supabaseKey) missing.push('VITE_SUPABASE_PUBLISHABLE_KEY');
    clientInitError = `Missing environment variable(s): ${missing.join(', ')}.`;
    return { client: null, error: clientInitError };
  }

  try {
    const parsed = new URL(supabaseUrl);
    if (!/^https?:$/i.test(parsed.protocol)) {
      throw new Error(`Unsupported protocol "${parsed.protocol}". Expected https://`);
    }
    cachedClient = createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    });
    return { client: cachedClient, error: null };
  } catch (err) {
    clientInitError =
      err instanceof Error
        ? `Invalid Supabase configuration: ${err.message}`
        : 'Failed to initialize Supabase client.';
    return { client: null, error: clientInitError };
  }
}

function inferBoroughFromLocation(locationText) {
  const loc = String(locationText || '').toLowerCase();
  if (loc.includes('queens')) return 'Queens';
  if (loc.includes('brooklyn')) return 'Brooklyn';
  if (loc.includes('manhattan')) return 'Manhattan';
  if (loc.includes('bronx')) return 'Bronx';
  if (loc.includes('staten')) return 'Staten Island';
  return locationText || 'NYC';
}

function normalizeSensor(row) {
  const location = row.location || row.borough || 'NYC';
  return {
    id: row.id,
    name: row.name || row.sensor_name || `Sensor #${row.id}`,
    location,
    borough: row.borough || inferBoroughFromLocation(location),
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
    dbStatus: row.status || 'unknown',
    alertThresholdIn: Number(row.alert_threshold ?? row.warn_threshold ?? 4)
  };
}

function normalizeReading(row) {
  const rawLevel = row.water_level ?? row.water_depth_in ?? row.depth_in ?? 0;
  return {
    id: row.id,
    sensorId: row.sensor_id,
    waterLevelIn: Number(rawLevel),
    recordedAt: row.recorded_at || row.created_at || null,
    isSimulated: Boolean(row.is_simulated)
  };
}

function withTimeout(promise, timeoutMs, label) {
  let timerId;
  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timerId));
}

/**
 * Fetches read-only rows from `sensors` and `water_readings` and joins
 * the latest saved water-level reading onto each sensor record.
 */
export async function fetchSupabaseFloodData() {
  const diagnostics = getSupabaseDiagnostics();
  const { client, error: initError } = getSupabaseClient();

  if (!client) {
    return {
      status: isSupabaseConfigured() ? 'error' : 'unconfigured',
      errorMessage: initError || 'Supabase client could not be initialized.',
      diagnostics,
      sensors: [],
      readings: [],
      latencyMs: null,
      fetchedAtMs: Date.now()
    };
  }

  const startedAt = performance.now();

  try {
    const [sensorsRes, readingsRes] = await withTimeout(
      Promise.all([
        client.from('sensors').select('*').order('id', { ascending: true }),
        client
          .from('water_readings')
          .select('*')
          .order('recorded_at', { ascending: false })
          .limit(30)
      ]),
      10000,
      'Supabase read-only query'
    );

    const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));

    if (sensorsRes.error) {
      throw new Error(
        `sensors table error (${sensorsRes.status || sensorsRes.error.code || 'RLS/API'}): ${sensorsRes.error.message}`
      );
    }
    if (readingsRes.error) {
      throw new Error(
        `water_readings table error (${readingsRes.status || readingsRes.error.code || 'RLS/API'}): ${readingsRes.error.message}`
      );
    }

    const readings = (readingsRes.data || []).map(normalizeReading);
    const latestBySensorId = new Map();

    readings.forEach((reading) => {
      if (!latestBySensorId.has(reading.sensorId)) {
        latestBySensorId.set(reading.sensorId, reading);
      }
    });

    const sensors = (sensorsRes.data || []).map((rawSensor) => {
      const normalized = normalizeSensor(rawSensor);
      const latestReading = latestBySensorId.get(normalized.id) || null;
      return {
        ...normalized,
        latestReading,
        waterLevelIn: latestReading ? latestReading.waterLevelIn : null,
        recordedAt: latestReading ? latestReading.recordedAt : null,
        isSimulatedReading: latestReading ? latestReading.isSimulated : false
      };
    });

    return {
      status: 'connected',
      errorMessage: '',
      diagnostics,
      sensors,
      readings,
      latencyMs,
      fetchedAtMs: Date.now()
    };
  } catch (err) {
    return {
      status: 'error',
      errorMessage: err instanceof Error ? err.message : 'Unable to reach Supabase.',
      diagnostics,
      sensors: [],
      readings: [],
      latencyMs: null,
      fetchedAtMs: Date.now()
    };
  }
}
