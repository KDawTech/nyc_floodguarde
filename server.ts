import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseCliArg(flagName: string): string | undefined {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === flagName && i + 1 < args.length) {
      return args[i + 1];
    }
    if (arg.startsWith(`${flagName}=`)) {
      return arg.slice(flagName.length + 1);
    }
  }
  return undefined;
}

const cliPort = Number(parseCliArg('--port') ?? parseCliArg('-p'));
const envPort = Number(process.env.PORT);
const PORT =
  Number.isFinite(cliPort) && cliPort > 0
    ? cliPort
    : Number.isFinite(envPort) && envPort > 0
    ? envPort
    : 3000;
const HOST = (parseCliArg('--host') || process.env.HOST || '0.0.0.0').trim() || '0.0.0.0';
const MODEL_NAME = (process.env.GEMINI_MODEL || 'gemini-4-hydrogen').trim() || 'gemini-4-hydrogen';
const FALLBACK_MODEL_NAME =
  (process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.1-flash-lite').trim() || 'gemini-3.1-flash-lite';

const RATE_LIMIT_WINDOW_MS = Math.max(
  1000,
  Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000) || 60_000
);
const RATE_LIMIT_MAX_REQUESTS = Math.max(
  1,
  Number(process.env.RATE_LIMIT_MAX_REQUESTS || 15) || 15
);

function normalizeOrigin(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.protocol}//${parsed.host}`.toLowerCase();
  } catch {
    return null;
  }
}

function buildAllowedOrigins(): Set<string> {
  const defaults = [
    'https://kdawtech.github.io',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5173',
    'http://127.0.0.1:5173'
  ];

  const origins = new Set<string>();
  for (const item of defaults) {
    const norm = normalizeOrigin(item);
    if (norm) origins.add(norm);
  }

  const appUrl = normalizeOrigin(process.env.APP_URL || '');
  if (appUrl) origins.add(appUrl);

  const extra = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const item of extra) {
    const norm = normalizeOrigin(item);
    if (norm) origins.add(norm);
  }

  return origins;
}

const ALLOWED_ORIGINS = buildAllowedOrigins();

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitBucket>();

function createRateLimiter(windowMs: number, maxRequests: number) {
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of rateLimitStore.entries()) {
      if (bucket.resetAt <= now) {
        rateLimitStore.delete(key);
      }
    }
  }, Math.max(windowMs, 30_000));
  if (typeof cleanupTimer.unref === 'function') {
    cleanupTimer.unref();
  }

  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const clientIp = (req.ip || req.socket.remoteAddress || 'unknown').trim();
    const now = Date.now();
    let bucket = rateLimitStore.get(clientIp);

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      rateLimitStore.set(clientIp, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, maxRequests - bucket.count);
    const resetEpochSec = Math.ceil(bucket.resetAt / 1000);

    res.setHeader('X-RateLimit-Limit', String(maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(resetEpochSec));

    if (bucket.count > maxRequests) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        error: `Too many requests to the AI FloodGuard Assistant. Please wait ${retryAfterSec} seconds and try again.`,
        retryAfterSeconds: retryAfterSec
      });
    }

    return next();
  };
}

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build'
      }
    }
  });
}

function buildSystemInstruction(): string {
  return [
    'You are the NYC FloodGuard 2.0 Informational Assistant.',
    'Explain urban flood monitoring, storm-drain blockages, rainfall impacts on NYC drainage systems, sensor-mount reliability, and practical emergency preparedness actions for residents in clear, plain language.',
    'Always stay strictly honest and grounded in the telemetry and weather snapshot provided:',
    '- Clearly distinguish four separate categories when answering: (1) Live Prototype Measurements (tabletop 3D-printed miniature NYC roadway with removable drain blockage, recirculating water pump, Arduino GIGA R1 WiFi, HC-SR04 ultrasonic sensor, ADXL345 accelerometer, active buzzer, and RGB LED), (2) Live NYC Weather Forecasts (Open-Meteo), (3) Trend-Based Model Estimates (short-term linear ETA projections — not validated weather forecasts), and (4) General Resident Safety Guidance.',
    '- Synchronized miniature prototype thresholds: NORMAL < 0.25 cm (green LED, silent buzzer), WARNING 0.25 cm to below 0.60 cm (yellow LED, intermittent buzzer), CRITICAL >= 0.60 cm (red LED, continuous buzzer), and SENSOR_FAULT (flashing blue LED and fault alarm, unless a previously confirmed CRITICAL alarm remains active). Always treat Arduino-reported statuses as the source of truth.',
    '- Cite only the actual values present in the snapshot (sensor validity, sensor reliability/quality, water depth, distance, locked baseline, ADXL345 mount stability and acceleration deviation, commanded local alarm mode, trend, rise rate, ETA/confidence, alert status, and NYC weather).',
    '- If sensor validity indicates a SENSOR FAULT, MOUNT MOVEMENT, RECALIBRATION REQUIRED, CALIBRATING, CALIBRATION FAILED, or OUT OF RANGE, explain that measurements are invalid/stale and predictions are paused. NEVER describe a sensor error as 0.00 cm water depth or NORMAL.',
    '- If a previously confirmed CRITICAL alert is being preserved during a sensor fault, emphasize that the critical warning remains active until confirmed safe by valid telemetry or visual inspection.',
    '- Clearly distinguish the Arduino-commanded local Alarm Mode (RGB LED and active buzzer pattern) from independently verified physical LED illumination or buzzer audio.',
    '- If the dashboard is in DEMO MODE, explicitly state that readings are SIMULATED rather than live hardware.',
    '- If no sensor is connected, mount/alarm telemetry is not reported by older firmware, the stream is stale/disconnected, or prediction shows Insufficient Data, say so honestly instead of inventing numbers, accuracy percentages, physical test outcomes, or predictions.',
    '- Provide practical resident safety actions appropriate to the situation (e.g., avoid flooded streets and basements, move to higher ground when needed, follow official NYC Emergency Management / Notify NYC instructions).',
    '- Never claim NYC FloodGuard is an official NYC emergency warning system or validated citywide forecasting service.',
    '- Keep answers concise (3–6 short sentences or crisp bullet points) for live classroom demonstration.'
  ].join('\n');
}

function clampString(value: unknown, maxLen = 280): string {
  const str = String(value ?? '').trim();
  return str.length > maxLen ? `${str.slice(0, maxLen)}…` : str;
}

function formatNumber(value: unknown, decimals = 2): string | null {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(decimals) : null;
}

function formatContextBlock(context: Record<string, unknown> | undefined): string {
  if (!context || typeof context !== 'object') {
    return 'Dashboard context: Not provided.';
  }

  const lines: string[] = ['Current NYC FloodGuard Dashboard Snapshot:'];
  if (context.sourceMode) lines.push(`- Data Source Mode: ${clampString(context.sourceMode, 80)}`);
  if (context.streamHealth && context.streamHealth !== 'IDLE') {
    lines.push(`- Sensor Stream Health: ${clampString(context.streamHealth, 40)}`);
  }
  if (context.sensorValidity) {
    const validityReason = context.sensorValidityReason
      ? ` — ${clampString(context.sensorValidityReason, 180)}`
      : '';
    lines.push(`- Sensor Measurement Validity: ${clampString(context.sensorValidity, 60)}${validityReason}`);
  }
  if (typeof context.predictionsPaused === 'boolean') {
    lines.push(`- Flood Predictions Status: ${context.predictionsPaused ? 'PAUSED (calibration protection / sensor fault)' : 'Active (subject to data sufficiency)'}`);
  }
  if (context.status) lines.push(`- Confirmed Flood Status: ${clampString(context.status, 50)}`);
  if (context.statusSource) lines.push(`- Status Source: ${clampString(context.statusSource, 60)}`);

  if (context.preservedCriticalActive === true) {
    const pDepth = formatNumber(context.preservedCriticalDepthCm);
    lines.push(
      `- Preserved Critical Alarm During Fault: ACTIVE${pDepth !== null ? ` (previously confirmed at ${pDepth} cm)` : ''}`
    );
  }

  // ADXL345 Mount Stability
  if (context.mountStatus) {
    const devG = formatNumber(context.mountDeviationG, 3);
    lines.push(
      `- ADXL345 Sensor-Mount Stability: ${clampString(context.mountStatus, 40)}${devG !== null ? ` (Deviation: ${devG} g)` : ''}`
    );
  }

  // Commanded Local Alarm Mode (RGB LED + Active Buzzer)
  if (context.alarmMode) {
    const desc = context.alarmModeDescription
      ? ` — ${clampString(context.alarmModeDescription, 140)}`
      : '';
    lines.push(
      `- Local Alarm Mode (Commanded by Arduino, not independently verified by light/audio sensors): ${clampString(context.alarmMode, 40)}${desc}`
    );
  }

  const depth = formatNumber(context.depthCm);
  if (depth !== null) {
    lines.push(`- Available Water Depth: ${depth} cm`);
  } else {
    lines.push('- Available Water Depth: Not available (invalid, paused, or disconnected)');
  }

  const distance = formatNumber(context.distanceCm);
  if (distance !== null) lines.push(`- Sensor-to-Surface Distance: ${distance} cm`);

  const baseline = formatNumber(context.baselineCm);
  if (baseline !== null) {
    const calStatus = context.calibrationStatus ? ` (${clampString(context.calibrationStatus, 50)})` : '';
    lines.push(`- Locked Dry-Road Baseline: ${baseline} cm${calStatus}`);
  }

  const warnCm = formatNumber(context.warningThresholdCm);
  const critCm = formatNumber(context.criticalThresholdCm);
  if (warnCm !== null && critCm !== null) {
    lines.push(`- Active Thresholds: WARNING ≥ ${warnCm} cm, CRITICAL ≥ ${critCm} cm`);
  }

  if (context.trend) lines.push(`- Water Trend: ${clampString(context.trend, 50)}`);
  const rate = formatNumber(context.rateCmPerMin);
  if (rate !== null) {
    lines.push(`- Rate of Change: ${Number(rate) > 0 ? '+' : ''}${rate} cm/min`);
  }
  if (context.etaWarningLabel) {
    lines.push(`- Trend-Based ETA to Warning: ${clampString(context.etaWarningLabel, 60)}`);
  }
  if (context.etaCriticalLabel) {
    lines.push(`- Trend-Based ETA to Critical: ${clampString(context.etaCriticalLabel, 60)}`);
  }
  if (context.predictionConfidence) {
    lines.push(`- Prediction Confidence: ${clampString(context.predictionConfidence, 80)}`);
  }
  if (context.sensorQuality) lines.push(`- Sensor Quality: ${clampString(context.sensorQuality, 50)}`);

  if (context.suspiciousReading === true) {
    const reason = context.suspiciousReason ? ` (${clampString(context.suspiciousReason, 160)})` : '';
    lines.push(`- Suspicious Reading Flagged: Yes${reason}`);
  }

  if (context.riskLevel) lines.push(`- Rule-Based Risk Level: ${clampString(context.riskLevel, 60)}`);
  if (context.trajectoryLabel) lines.push(`- Risk Trajectory: ${clampString(context.trajectoryLabel, 60)}`);
  if (typeof context.rapidRiseDetected === 'boolean') {
    lines.push(`- Rapid Water Rise Flag: ${context.rapidRiseDetected ? 'Active' : 'Not active'}`);
  }
  if (typeof context.blockedDrainSuspected === 'boolean') {
    lines.push(`- Blocked Drain Flag: ${context.blockedDrainSuspected ? 'Suspected' : 'Not flagged'}`);
  }

  if (Array.isArray(context.riskDrivers) && context.riskDrivers.length > 0) {
    const drivers = context.riskDrivers
      .slice(0, 5)
      .map((d) => clampString(d, 200))
      .filter(Boolean);
    if (drivers.length > 0) {
      lines.push(`- Key Risk Drivers: ${drivers.join(' | ')}`);
    }
  }

  if (context.weatherSummary) {
    lines.push(`- Live NYC Weather Forecast (Open-Meteo): ${clampString(context.weatherSummary, 320)}`);
  }
  if (context.weatherUpdatedAt) {
    lines.push(`- Weather Fetched At: ${clampString(context.weatherUpdatedAt, 60)}`);
  }

  return lines.join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const UPSTREAM_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.GEMINI_TIMEOUT_MS || 18_000) || 18_000
);
const MAX_ASSISTANT_TOTAL_MS = Math.max(
  UPSTREAM_TIMEOUT_MS + 4000,
  Number(process.env.GEMINI_TOTAL_BUDGET_MS || 34_000) || 34_000
);

// Per-model temporary cooldown after transient 503/429 or 404 failures so subsequent
// requests route immediately to the healthy fallback model without 12s+ stalls.
const MODEL_COOLDOWN_TRANSIENT_MS = 90_000;
const MODEL_COOLDOWN_NOT_FOUND_MS = 5 * 60_000;
const modelCooldownUntil = new Map<string, { untilMs: number; reason: string }>();

interface ClassifiedUpstreamError {
  code:
    | 'HIGH_DEMAND_503'
    | 'QUOTA_429'
    | 'MODEL_NOT_FOUND_404'
    | 'AUTH_ERROR'
    | 'BAD_REQUEST_400'
    | 'TIMEOUT_504'
    | 'UPSTREAM_5XX'
    | 'NETWORK_ERROR'
    | 'UNKNOWN_ERROR';
  httpStatus: number;
  upstreamStatus: number;
  retryable: boolean;
  failoverRecommended: boolean;
  cooldownMs: number;
  safeDetail: string;
}

function extractUpstreamStatus(err: unknown, rawMessage: string): number {
  if (typeof err === 'object' && err !== null) {
    if ('status' in err && Number.isFinite(Number((err as { status?: number }).status))) {
      return Number((err as { status?: number }).status);
    }
    if ('statusCode' in err && Number.isFinite(Number((err as { statusCode?: number }).statusCode))) {
      return Number((err as { statusCode?: number }).statusCode);
    }
  }
  const codeMatch = rawMessage.match(/"code"\s*:\s*(\d{3})/);
  if (codeMatch) return Number(codeMatch[1]);
  return 0;
}

function classifyUpstreamError(err: unknown): ClassifiedUpstreamError {
  const rawMessage = err instanceof Error ? err.message : String(err || 'Unexpected Gemini API error');
  const upstreamStatus = extractUpstreamStatus(err, rawMessage);

  let parsedMsg = rawMessage;
  try {
    const parsed = JSON.parse(rawMessage);
    if (parsed?.error?.message) parsedMsg = String(parsed.error.message);
  } catch {
    // Keep rawMessage
  }
  // Redact anything that could resemble an API key just in case
  const safeDetail = parsedMsg.replace(/AIza[0-9A-Za-z\-_]{10,}/g, '[REDACTED]').slice(0, 260);

  if (upstreamStatus === 401 || upstreamStatus === 403 || /API_KEY_INVALID|PERMISSION_DENIED|invalid api key/i.test(rawMessage)) {
    return {
      code: 'AUTH_ERROR',
      httpStatus: upstreamStatus === 403 ? 403 : 400,
      upstreamStatus: upstreamStatus || 403,
      retryable: false,
      failoverRecommended: false,
      cooldownMs: 0,
      safeDetail
    };
  }
  if (upstreamStatus === 404 || /NOT_FOUND|is not found for API version/i.test(rawMessage)) {
    return {
      code: 'MODEL_NOT_FOUND_404',
      httpStatus: 502,
      upstreamStatus: 404,
      retryable: false,
      failoverRecommended: true,
      cooldownMs: MODEL_COOLDOWN_NOT_FOUND_MS,
      safeDetail
    };
  }
  if (upstreamStatus === 429 || /RESOURCE_EXHAUSTED|quota|rate limit/i.test(rawMessage)) {
    return {
      code: 'QUOTA_429',
      httpStatus: 429,
      upstreamStatus: 429,
      retryable: true,
      failoverRecommended: true,
      cooldownMs: MODEL_COOLDOWN_TRANSIENT_MS,
      safeDetail
    };
  }
  if (upstreamStatus === 503 || /UNAVAILABLE|high demand|overloaded|temporarily unavailable/i.test(rawMessage)) {
    return {
      code: 'HIGH_DEMAND_503',
      httpStatus: 503,
      upstreamStatus: 503,
      retryable: true,
      failoverRecommended: true,
      cooldownMs: MODEL_COOLDOWN_TRANSIENT_MS,
      safeDetail
    };
  }
  if (upstreamStatus === 504 || /UPSTREAM_TIMEOUT|timed out|DEADLINE_EXCEEDED/i.test(rawMessage)) {
    return {
      code: 'TIMEOUT_504',
      httpStatus: 504,
      upstreamStatus: 504,
      retryable: true,
      failoverRecommended: true,
      cooldownMs: 45_000,
      safeDetail
    };
  }
  if (upstreamStatus >= 500 && upstreamStatus < 600) {
    return {
      code: 'UPSTREAM_5XX',
      httpStatus: 503,
      upstreamStatus,
      retryable: true,
      failoverRecommended: true,
      cooldownMs: 45_000,
      safeDetail
    };
  }
  if (/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(rawMessage)) {
    return {
      code: 'NETWORK_ERROR',
      httpStatus: 503,
      upstreamStatus: 0,
      retryable: true,
      failoverRecommended: true,
      cooldownMs: 0,
      safeDetail
    };
  }
  if (upstreamStatus === 400) {
    return {
      code: 'BAD_REQUEST_400',
      httpStatus: 400,
      upstreamStatus: 400,
      retryable: false,
      failoverRecommended: false,
      cooldownMs: 0,
      safeDetail
    };
  }
  return {
    code: 'UNKNOWN_ERROR',
    httpStatus: 502,
    upstreamStatus,
    retryable: false,
    failoverRecommended: false,
    cooldownMs: 0,
    safeDetail
  };
}

function getOrderedModels(nowMs = Date.now()): string[] {
  const unique =
    FALLBACK_MODEL_NAME && FALLBACK_MODEL_NAME !== MODEL_NAME
      ? [MODEL_NAME, FALLBACK_MODEL_NAME]
      : [MODEL_NAME];

  const healthy: string[] = [];
  const cooling: string[] = [];
  for (const m of unique) {
    const cd = modelCooldownUntil.get(m);
    if (cd && cd.untilMs > nowMs) {
      cooling.push(m);
    } else {
      if (cd) modelCooldownUntil.delete(m);
      healthy.push(m);
    }
  }
  return [...healthy, ...cooling];
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Upstream Gemini API timed out after ${Math.round(ms / 1000)} seconds.`);
      (err as { status?: number; code?: string }).status = 504;
      (err as { status?: number; code?: string }).code = 'UPSTREAM_TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function generateAssistantReply(
  ai: GoogleGenAI,
  prompt: string
): Promise<{ text: string; model: string; attempts: number; usedFallback: boolean }> {
  const startedAtMs = Date.now();
  const modelsToTry = getOrderedModels(startedAtMs);
  let totalAttempts = 0;
  let lastError: unknown;

  for (let mIdx = 0; mIdx < modelsToTry.length; mIdx++) {
    const model = modelsToTry[mIdx];
    const hasNextModel = mIdx < modelsToTry.length - 1;
    // Allow 1 fast try on primary when a healthy fallback exists (so 503 failover is fast),
    // and up to 2 attempts with exponential backoff on the final/fallback model.
    const maxAttempts = hasNextModel ? 1 : 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const elapsedTotal = Date.now() - startedAtMs;
      const remainingBudget = MAX_ASSISTANT_TOTAL_MS - elapsedTotal;
      if (remainingBudget < 3500 && totalAttempts > 0) {
        break;
      }

      totalAttempts += 1;
      const attemptStart = Date.now();
      const attemptTimeout = Math.min(UPSTREAM_TIMEOUT_MS, Math.max(4000, remainingBudget));

      try {
        const config: Record<string, unknown> = {
          systemInstruction: buildSystemInstruction()
        };
        if (model === 'gemini-4-hydrogen') {
          config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
        }
        const response = await withTimeout(
          ai.models.generateContent({
            model,
            contents: prompt,
            config
          }),
          attemptTimeout
        );
        // Clear any prior cooldown on success
        modelCooldownUntil.delete(model);
        return {
          text: (response.text || '').trim(),
          model,
          attempts: totalAttempts,
          usedFallback: model !== MODEL_NAME
        };
      } catch (err: unknown) {
        lastError = err;
        const info = classifyUpstreamError(err);
        const attemptMs = Date.now() - attemptStart;

        console.warn(
          `[FloodGuard Assistant] Upstream attempt failed: model=${model} attempt=${attempt}/${maxAttempts} code=${info.code} status=${info.upstreamStatus} ms=${attemptMs} detail="${info.safeDetail}"`
        );

        if (info.cooldownMs > 0) {
          modelCooldownUntil.set(model, {
            untilMs: Date.now() + info.cooldownMs,
            reason: info.code
          });
        }

        // Permanent auth or invalid-request errors: stop immediately
        if (!info.retryable && !info.failoverRecommended) {
          throw err;
        }

        // On 404 or 429 on a specific model, immediately fail over without retrying same model
        if ((info.code === 'MODEL_NOT_FOUND_404' || info.code === 'QUOTA_429') && hasNextModel) {
          break;
        }

        // Limited retry with bounded exponential backoff + jitter on same model
        if (info.retryable && attempt < maxAttempts) {
          const backoffMs = Math.min(2500, 700 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 250));
          if (Date.now() - startedAtMs + backoffMs + 3500 < MAX_ASSISTANT_TOTAL_MS) {
            await sleep(backoffMs);
            continue;
          }
        }

        // Move to fallback model if available
        if (info.failoverRecommended && hasNextModel) {
          break;
        }

        throw err;
      }
    }
  }

  throw lastError;
}

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);

  // Trust Render / reverse proxy X-Forwarded-For header so per-IP rate limiting works accurately
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  // Strict CORS middleware for /api/* routes (allows GitHub Pages + configured origins + local dev)
  app.use('/api', (req, res, next) => {
    res.setHeader('Vary', 'Origin');
    const rawOrigin = req.headers.origin;

    // Allow same-origin / non-browser requests with no Origin header (e.g. Render health checks)
    if (!rawOrigin) {
      if (req.method === 'OPTIONS') {
        return res.status(204).end();
      }
      return next();
    }

    const normalized = normalizeOrigin(rawOrigin);
    if (!normalized || !ALLOWED_ORIGINS.has(normalized)) {
      return res.status(403).json({
        error: 'Origin not permitted by NYC FloodGuard API CORS policy.'
      });
    }

    res.setHeader('Access-Control-Allow-Origin', rawOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

    return next();
  });

  const assistantRateLimiter = createRateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS);

  // Render & monitoring health check endpoint
  app.get('/api/health', (_req, res) => {
    const configured = Boolean((process.env.GEMINI_API_KEY || '').trim());
    const orderedModels = getOrderedModels();
    res.json({
      status: 'ok',
      service: 'nyc-floodguard-backend',
      assistantConfigured: configured,
      model: MODEL_NAME,
      fallbackModel: FALLBACK_MODEL_NAME,
      activePreferredModel: orderedModels[0] || MODEL_NAME,
      timestamp: new Date().toISOString()
    });
  });

  app.get('/api/assistant/status', (_req, res) => {
    const configured = Boolean((process.env.GEMINI_API_KEY || '').trim());
    const orderedModels = getOrderedModels();
    const primaryCooldown = modelCooldownUntil.get(MODEL_NAME);
    const inFallbackCooldown = Boolean(primaryCooldown && primaryCooldown.untilMs > Date.now());
    res.json({
      available: configured,
      model: MODEL_NAME,
      fallbackModel: FALLBACK_MODEL_NAME,
      activePreferredModel: orderedModels[0] || MODEL_NAME,
      inFallbackCooldown,
      rateLimit: {
        maxRequests: RATE_LIMIT_MAX_REQUESTS,
        windowMs: RATE_LIMIT_WINDOW_MS
      },
      note: configured
        ? inFallbackCooldown
          ? `Server-side Gemini AI Assistant is ready (routing via ${orderedModels[0]} while primary model recovers from high demand).`
          : 'Server-side Gemini AI Assistant is ready (informational explanations only).'
        : 'Server-side GEMINI_API_KEY is not configured in the server environment.'
    });
  });

  app.post('/api/assistant', assistantRateLimiter, async (req, res) => {
    try {
      const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
      const context =
        req.body?.context && typeof req.body.context === 'object'
          ? (req.body.context as Record<string, unknown>)
          : undefined;

      if (!question) {
        return res.status(400).json({
          error: 'Please enter a question for the FloodGuard Assistant.',
          code: 'EMPTY_QUESTION',
          retryable: false
        });
      }
      if (question.length > 600) {
        return res.status(400).json({
          error: 'Question is too long (maximum 600 characters).',
          code: 'QUESTION_TOO_LONG',
          retryable: false
        });
      }

      const ai = getGeminiClient();
      if (!ai) {
        return res.status(503).json({
          error:
            'AI Assistant is currently unavailable because GEMINI_API_KEY is not configured on the server. Rule-based FloodGuard Risk Intelligence remains fully active.',
          code: 'MISSING_API_KEY',
          retryable: false,
          fallbackActive: true
        });
      }

      const prompt = `${formatContextBlock(context)}\n\nUser Question: ${question}`;
      const { text: answer, model: modelUsed, attempts, usedFallback } = await generateAssistantReply(ai, prompt);

      if (!answer) {
        return res.status(502).json({
          error: 'The AI service returned an empty response. Please try asking again.',
          code: 'EMPTY_RESPONSE',
          retryable: true,
          fallbackActive: true
        });
      }

      return res.json({
        answer,
        model: modelUsed,
        usedFallback,
        attempts,
        informationalOnly: true,
        generatedAt: new Date().toISOString()
      });
    } catch (err: unknown) {
      const info = classifyUpstreamError(err);

      if (info.code === 'AUTH_ERROR') {
        return res.status(info.httpStatus).json({
          error: 'Gemini API key was rejected. Check GEMINI_API_KEY in the Render/server environment.',
          code: info.code,
          upstreamStatus: info.upstreamStatus,
          retryable: false,
          fallbackActive: true
        });
      }
      if (info.code === 'QUOTA_429') {
        return res.status(429).json({
          error:
            'Gemini API quota/rate limit reached (HTTP 429). Please wait a moment and try again — rule-based FloodGuard Risk Intelligence remains active.',
          code: info.code,
          upstreamStatus: info.upstreamStatus,
          retryable: true,
          retryAfterSeconds: 15,
          fallbackActive: true
        });
      }
      if (info.code === 'TIMEOUT_504') {
        return res.status(504).json({
          error:
            'The AI service timed out before responding (HTTP 504). Please try asking again — rule-based FloodGuard Risk Intelligence remains active.',
          code: info.code,
          upstreamStatus: info.upstreamStatus,
          retryable: true,
          fallbackActive: true
        });
      }
      if (info.code === 'HIGH_DEMAND_503' || info.code === 'UPSTREAM_5XX' || info.code === 'NETWORK_ERROR') {
        return res.status(503).json({
          error:
            'Gemini AI models are temporarily experiencing high demand (HTTP 503) even after automatic retry and model failover. Please try again in a few seconds — rule-based FloodGuard Risk Intelligence remains active.',
          code: info.code,
          upstreamStatus: info.upstreamStatus,
          retryable: true,
          retryAfterSeconds: 5,
          fallbackActive: true
        });
      }
      if (info.code === 'MODEL_NOT_FOUND_404') {
        return res.status(502).json({
          error:
            'The configured Gemini model is unavailable for this API key (HTTP 404). Verify GEMINI_MODEL and GEMINI_FALLBACK_MODEL in your server environment.',
          code: info.code,
          upstreamStatus: info.upstreamStatus,
          retryable: false,
          fallbackActive: true
        });
      }
      return res.status(info.httpStatus).json({
        error: `AI Assistant request failed: ${info.safeDetail}`,
        code: info.code,
        upstreamStatus: info.upstreamStatus,
        retryable: info.retryable,
        fallbackActive: true
      });
    }
  });

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(__dirname, 'dist');
    const indexPath = path.join(distDir, 'index.html');

    if (fs.existsSync(indexPath)) {
      app.use(express.static(distDir));
      app.use((req, res, next) => {
        if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
        res.sendFile(indexPath);
      });
    } else {
      // Standalone API-only backend deployment (e.g. Render serving GitHub Pages frontend)
      app.get('/', (_req, res) => {
        res.json({
          service: 'NYC FloodGuard 2.0 Assistant API',
          status: 'ok',
          assistantConfigured: Boolean((process.env.GEMINI_API_KEY || '').trim()),
          endpoints: ['/api/health', '/api/assistant/status', '/api/assistant']
        });
      });
    }
  } else {
    const { createServer: createViteServer } = await import('vite');
    const hmrDisabled = process.env.DISABLE_HMR === 'true';

    // When DISABLE_HMR=true (preview proxy environments), Vite 6 middlewareMode still
    // injects /@vite/client and defaults its WebSocket target to port 24678, causing
    // "[vite] failed to connect to websocket" / "WebSocket closed without opened" errors.
    // Serve a lightweight no-WebSocket shim for /@vite/client and strip the injected tag
    // while keeping full CSS/ESM serving intact. In normal local dev (DISABLE_HMR !== 'true'),
    // attach Vite's HMR WebSocket directly to the shared Express HTTP server on PORT.
    if (hmrDisabled) {
      const noWsViteClientShim = [
        'const sheetsMap = new Map();',
        'export function updateStyle(id, content) {',
        '  let style = sheetsMap.get(id);',
        '  if (!style) {',
        '    style = document.createElement("style");',
        '    style.setAttribute("type", "text/css");',
        '    style.setAttribute("data-vite-dev-id", id);',
        '    document.head.appendChild(style);',
        '    sheetsMap.set(id, style);',
        '  }',
        '  style.textContent = content;',
        '}',
        'export function removeStyle(id) {',
        '  const style = sheetsMap.get(id);',
        '  if (style) {',
        '    style.remove();',
        '    sheetsMap.delete(id);',
        '  }',
        '}',
        'export function createHotContext() {',
        '  return {',
        '    data: {},',
        '    accept() {},',
        '    acceptExports() {},',
        '    dispose() {},',
        '    prune() {},',
        '    invalidate() {},',
        '    on() {},',
        '    off() {},',
        '    send() {}',
        '  };',
        '}',
        'export function injectQuery(url) { return url; }',
        'export class ErrorOverlay {}'
      ].join('\n');

      app.get('/@vite/client', (_req, res) => {
        res.type('application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(noWsViteClientShim);
      });
    }

    const vite = await createViteServer({
      plugins: hmrDisabled
        ? [
            {
              name: 'nyc-floodguard-strip-hmr-client',
              transformIndexHtml: {
                order: 'post',
                handler(html: string) {
                  return html.replace(
                    /\s*<script\s+type="module"\s+src="[^"]*\/@vite\/client"[^>]*><\/script>\s*/gi,
                    '\n'
                  );
                }
              }
            }
          ]
        : [],
      server: {
        middlewareMode: true,
        allowedHosts: true,
        ws: !hmrDisabled,
        hmr: hmrDisabled ? false : { server: httpServer }
      },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  }

  httpServer.listen(PORT, HOST, () => {
    console.log(
      `NYC FloodGuard 2.0 server listening on http://${HOST}:${PORT} (CORS origins: ${Array.from(ALLOWED_ORIGINS).join(', ')})`
    );
  });
}

startServer().catch((err) => {
  console.error('Failed to start NYC FloodGuard 2.0 server:', err);
  process.exit(1);
});
