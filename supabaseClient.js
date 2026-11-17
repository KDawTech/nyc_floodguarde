/**
 * ============================================================================
 * NYC FloodGuard — Supabase Client, Authentication & Read-Only Data Service
 * File: supabaseClient.js
 *
 * Reuses the single Supabase client configured with VITE_SUPABASE_URL and
 * VITE_SUPABASE_PUBLISHABLE_KEY with Row Level Security (RLS) enabled.
 * - Auth: signUp, signInWithPassword, getSession, onAuthStateChange, signOut,
 *         resetPasswordForEmail, updateUser, resend (with session persistence).
 * - Data: Strictly read-only SELECT queries against `sensors` and `water_readings`.
 * ============================================================================
 */
import { createClient } from '@supabase/supabase-js';

const GITHUB_PAGES_REDIRECT_URL = 'https://kdawtech.github.io/nyc_floodguarde/';

function cleanEnvValue(raw) {
  return String(raw || '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .trim();
}

function normalizeSupabaseUrl(raw) {
  let cleaned = cleanEnvValue(raw);
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

/**
 * Computes the email verification / password reset redirect URL so redirects
 * work seamlessly both locally and on GitHub Pages (/nyc_floodguarde/).
 */
export function getAuthRedirectUrl() {
  if (typeof window === 'undefined') {
    return GITHUB_PAGES_REDIRECT_URL;
  }
  try {
    const current = new URL(window.location.href);
    if (current.hostname === 'kdawtech.github.io') {
      return GITHUB_PAGES_REDIRECT_URL;
    }
    current.hash = '';
    current.search = '';
    if (!current.pathname.endsWith('/')) {
      current.pathname = current.pathname.replace(/\/[^/]*$/, '/');
    }
    return current.toString();
  } catch {
    return GITHUB_PAGES_REDIRECT_URL;
  }
}

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

export function getSupabaseClient() {
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
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
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

/* --------------------------------------------------------------------------
 * SUPABASE AUTHENTICATION HELPERS
 * -------------------------------------------------------------------------- */
export async function getAuthSession() {
  const { client, error: initError } = getSupabaseClient();
  if (!client) {
    return { session: null, error: new Error(initError || 'Supabase client not configured.') };
  }
  const { data, error } = await client.auth.getSession();
  return { session: data?.session || null, error };
}

export function subscribeToAuthState(callback) {
  const { client } = getSupabaseClient();
  if (!client) {
    return () => {};
  }
  const { data } = client.auth.onAuthStateChange((event, session) => {
    callback(event, session);
  });
  return () => {
    data?.subscription?.unsubscribe();
  };
}

export async function signUpWithEmail({ fullName, email, password }) {
  const { client, error: initError } = getSupabaseClient();
  if (!client) {
    return { data: null, error: new Error(initError || 'Supabase client not configured.') };
  }
  return client.auth.signUp({
    email,
    password,
    options: {
      data: {
        full_name: fullName
      },
      emailRedirectTo: getAuthRedirectUrl()
    }
  });
}

export async function signInWithEmail({ email, password }) {
  const { client, error: initError } = getSupabaseClient();
  if (!client) {
    return { data: null, error: new Error(initError || 'Supabase client not configured.') };
  }
  return client.auth.signInWithPassword({
    email,
    password
  });
}

export async function resendVerificationEmail(email) {
  const { client, error: initError } = getSupabaseClient();
  if (!client) {
    return { data: null, error: new Error(initError || 'Supabase client not configured.') };
  }
  return client.auth.resend({
    type: 'signup',
    email,
    options: {
      emailRedirectTo: getAuthRedirectUrl()
    }
  });
}

export async function sendPasswordResetEmail(email) {
  const { client, error: initError } = getSupabaseClient();
  if (!client) {
    return { data: null, error: new Error(initError || 'Supabase client not configured.') };
  }
  return client.auth.resetPasswordForEmail(email, {
    redirectTo: getAuthRedirectUrl()
  });
}

export async function updateUserPassword(newPassword) {
  const { client, error: initError } = getSupabaseClient();
  if (!client) {
    return { data: null, error: new Error(initError || 'Supabase client not configured.') };
  }
  return client.auth.updateUser({
    password: newPassword
  });
}

export async function signOutUser() {
  const { client, error: initError } = getSupabaseClient();
  if (!client) {
    return { error: new Error(initError || 'Supabase client not configured.') };
  }
  return client.auth.signOut();
}

/* --------------------------------------------------------------------------
 * READ-ONLY SENSOR & WATER READING QUERIES (RLS ENABLED)
 * -------------------------------------------------------------------------- */
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

/* --------------------------------------------------------------------------
 * SAVED HISTORICAL FLOOD EVENT BOOKMARKS (`saved_flood_events` + RLS)
 * Only selected events bookmarked by the authenticated user are stored here.
 * -------------------------------------------------------------------------- */
export function buildFloodEventKey(sensorId, floodStartTime) {
  return `${String(sensorId || '').trim()}|${String(floodStartTime || '').trim()}`;
}

function isMissingSavedTableError(err) {
  if (!err) return false;
  const code = String(err.code || '').toUpperCase();
  const msg = String(err.message || '').toLowerCase();
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    msg.includes('saved_flood_events') && (msg.includes('does not exist') || msg.includes('could not find'))
  );
}

function normalizeSavedEventRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    eventKey: row.event_key || buildFloodEventKey(row.sensor_id, row.flood_start_time),
    sensorId: row.sensor_id,
    sensorName: row.sensor_name,
    borough: row.borough || '',
    streetName: row.street_name || '',
    zipcode: row.zipcode || '',
    floodStartTime: row.flood_start_time,
    floodEndTime: row.flood_end_time || '',
    maxDepthInches: row.max_depth_inches != null ? Number(row.max_depth_inches) : null,
    durationMins: row.duration_mins != null ? Number(row.duration_mins) : null,
    dataSource: row.data_source || 'nyc_open_data_aq7i_eu5q',
    createdAt: row.created_at || null
  };
}

export async function fetchSavedFloodEvents() {
  const { client, error: initError } = getSupabaseClient();
  if (!client) {
    return {
      status: 'unconfigured',
      events: [],
      errorMessage: initError || 'Supabase client not configured.'
    };
  }

  const { data: sessionData } = await client.auth.getSession();
  const user = sessionData?.session?.user;
  if (!user) {
    return {
      status: 'unauthenticated',
      events: [],
      errorMessage: 'Sign in to view your saved historical flood events.'
    };
  }

  const { data, error } = await client
    .from('saved_flood_events')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    if (isMissingSavedTableError(error)) {
      return {
        status: 'migration_required',
        events: [],
        errorMessage:
          'Table "saved_flood_events" has not been created in Supabase yet. Run the SQL migration in Supabase SQL Editor to enable bookmarks.'
      };
    }
    return {
      status: 'error',
      events: [],
      errorMessage: error.message || 'Failed to load saved flood events.'
    };
  }

  return {
    status: 'ok',
    events: (data || []).map(normalizeSavedEventRow),
    errorMessage: ''
  };
}

export async function saveFloodEventBookmark(eventRecord) {
  const { client, error: initError } = getSupabaseClient();
  if (!client) {
    return { status: 'error', event: null, errorMessage: initError || 'Supabase client not configured.' };
  }

  const { data: sessionData } = await client.auth.getSession();
  const user = sessionData?.session?.user;
  if (!user) {
    return {
      status: 'unauthenticated',
      event: null,
      errorMessage: 'Please sign in before bookmarking a historical flood event.'
    };
  }

  const eventKey = buildFloodEventKey(eventRecord.sensorId, eventRecord.floodStartTime);
  const payload = {
    user_id: user.id,
    event_key: eventKey,
    sensor_id: eventRecord.sensorId,
    sensor_name: eventRecord.sensorName,
    borough: eventRecord.borough || null,
    street_name: eventRecord.streetName || null,
    zipcode: eventRecord.zipcode || null,
    flood_start_time: eventRecord.floodStartTime,
    flood_end_time: eventRecord.floodEndTime || null,
    max_depth_inches: eventRecord.maxDepthInches,
    duration_mins: eventRecord.durationMins,
    data_source: 'nyc_open_data_aq7i_eu5q'
  };

  const { data, error } = await client
    .from('saved_flood_events')
    .insert(payload)
    .select('*')
    .single();

  if (error) {
    if (isMissingSavedTableError(error)) {
      return {
        status: 'migration_required',
        event: null,
        errorMessage:
          'Table "saved_flood_events" does not exist yet. Run the SQL migration in your Supabase SQL Editor first.'
      };
    }
    if (String(error.code) === '23505' || String(error.message || '').toLowerCase().includes('duplicate')) {
      return {
        status: 'duplicate',
        event: null,
        errorMessage: 'This flood event is already saved in your bookmarks.'
      };
    }
    return {
      status: 'error',
      event: null,
      errorMessage: error.message || 'Unable to save flood event bookmark.'
    };
  }

  return {
    status: 'ok',
    event: data ? normalizeSavedEventRow(data) : null,
    errorMessage: ''
  };
}

export async function deleteSavedFloodEvent(savedId) {
  const { client, error: initError } = getSupabaseClient();
  if (!client) {
    return { status: 'error', errorMessage: initError || 'Supabase client not configured.' };
  }

  const { data: sessionData } = await client.auth.getSession();
  const user = sessionData?.session?.user;
  if (!user) {
    return { status: 'unauthenticated', errorMessage: 'Sign in required to delete bookmarks.' };
  }

  const { error } = await client
    .from('saved_flood_events')
    .delete()
    .eq('id', savedId)
    .eq('user_id', user.id);

  if (error) {
    if (isMissingSavedTableError(error)) {
      return {
        status: 'migration_required',
        errorMessage: 'Table "saved_flood_events" does not exist yet. Run the SQL migration first.'
      };
    }
    return {
      status: 'error',
      errorMessage: error.message || 'Unable to delete saved flood event.'
    };
  }

  return { status: 'ok', errorMessage: '' };
}

