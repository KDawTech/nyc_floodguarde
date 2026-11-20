/**
 * ============================================================================
 * NYC FloodGuard — Ultrasonic Water-Depth, Rising-Water & Early-Warning Engine
 * File: floodAnalytics.js
 *
 * Pure mathematical telemetry analysis for the physical NYC FloodGuard
 * prototype (all primary measurements in centimeters):
 *   1. Water Depth = max(0, Sensor Mounting Height - Measured Distance to Water)
 *   2. Rolling median filter (window = 3 or 5) to suppress ripples & splashes
 *   3. Ordinary Least Squares (OLS) slope over recent filtered samples
 *   4. Conservative ETA projection to Warning & Critical thresholds
 *      (returns "Not available" whenever water is not rising reliably)
 * ============================================================================
 */

export const DEFAULT_PROTOTYPE_SETTINGS = {
  mountHeightCm: 25.0,          // Physical distance from ultrasonic face to dry street surface
  warnThresholdCm: 6.0,         // Configurable prototype Warning level (Orange)
  critThresholdCm: 12.0,        // Configurable prototype Critical level (Red)
  minRiseRateCmPerMin: 0.25,    // Minimum slope (cm/min) required to treat water as reliably rising
  stableBandCmPerMin: 0.15,     // Deadband (±cm/min) treated as Stable rather than Rising/Falling
  barrierThresholdCm: 10.0,     // Optional future servo flood barrier trigger threshold
  staleTimeoutMs: 8000          // Live serial timeout before showing UNAVAILABLE
};

/**
 * Computes water depth in centimeters from mounting height and measured
 * ultrasonic distance to the water surface.
 * Formula: Water Depth = Sensor Mounting Height − Measured Distance to Water
 */
export function computeWaterDepthCm(mountHeightCm, measuredDistanceCm) {
  const mount = Number(mountHeightCm);
  const dist = Number(measuredDistanceCm);
  if (!Number.isFinite(mount) || !Number.isFinite(dist)) {
    return null;
  }
  const rawDepth = mount - dist;
  // Clamp tiny negative sensor jitter around dry floor to 0.0 cm
  return Math.max(0, Number(rawDepth.toFixed(2)));
}

/**
 * Returns the median value of a small numeric array.
 */
function medianOf(values) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Applies a small sliding-window median filter to raw depth samples to reject
 * single-frame ultrasonic echo glitches and surface splashes/ripples.
 */
export function filterDepthSamples(samples, windowSize = 3) {
  if (!Array.isArray(samples) || samples.length === 0) return [];
  const half = Math.floor(windowSize / 2);

  return samples.map((sample, idx) => {
    const start = Math.max(0, idx - half);
    const end = Math.min(samples.length - 1, idx + half);
    const neighborhood = [];
    for (let i = start; i <= end; i++) {
      if (Number.isFinite(samples[i].depthCm)) {
        neighborhood.push(samples[i].depthCm);
      }
    }
    const filteredDepthCm = neighborhood.length > 0
      ? Number(medianOf(neighborhood).toFixed(2))
      : sample.depthCm;

    return {
      ...sample,
      filteredDepthCm
    };
  });
}

/**
 * Computes Ordinary Least Squares (OLS) linear regression slope (cm/min) and
 * coefficient of determination (R^2) over timestamped filtered samples.
 */
function computeLinearTrend(filteredSamples) {
  const n = filteredSamples.length;
  if (n < 3) {
    return { slopeCmPerMin: 0, rSquared: 0, spanSec: 0 };
  }

  const t0 = filteredSamples[0].timestampMs;
  const tLast = filteredSamples[n - 1].timestampMs;
  const spanSec = (tLast - t0) / 1000;
  if (spanSec < 1.5) {
    return { slopeCmPerMin: 0, rSquared: 0, spanSec };
  }

  // Convert elapsed milliseconds into minutes for direct cm/min slope
  const xs = filteredSamples.map((s) => (s.timestampMs - t0) / 60000);
  const ys = filteredSamples.map((s) => s.filteredDepthCm);

  const meanX = xs.reduce((acc, v) => acc + v, 0) / n;
  const meanY = ys.reduce((acc, v) => acc + v, 0) / n;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }

  if (sxx <= 1e-9) {
    return { slopeCmPerMin: 0, rSquared: 0, spanSec };
  }

  const slopeCmPerMin = sxy / sxx;
  const rSquared = syy > 1e-6 ? Math.min(1, Math.max(0, (sxy * sxy) / (sxx * syy))) : 0;

  return {
    slopeCmPerMin: Number(slopeCmPerMin.toFixed(3)),
    rSquared: Number(rSquared.toFixed(3)),
    spanSec: Number(spanSec.toFixed(1))
  };
}

/**
 * Formats an ETA duration in seconds into a clear human-readable string.
 */
export function formatEtaDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return 'Not available';
  }
  const rounded = Math.round(seconds);
  if (rounded < 60) {
    return `${rounded} sec`;
  }
  const mins = Math.floor(rounded / 60);
  const remSec = rounded % 60;
  if (mins < 60) {
    return remSec > 0 ? `${mins} min ${remSec} sec` : `${mins} min`;
  }
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hrs > 24) {
    return '> 24 hr';
  }
  return remMins > 0 ? `${hrs} hr ${remMins} min` : `${hrs} hr`;
}

/**
 * Evaluates a threshold ETA given current filtered depth, slope, and reliability.
 */
function projectThresholdEta(currentDepthCm, thresholdCm, slopeCmPerMin, isReliableRise) {
  if (!Number.isFinite(currentDepthCm) || !Number.isFinite(thresholdCm)) {
    return { available: false, reached: false, seconds: null, label: 'Not available' };
  }
  if (currentDepthCm >= thresholdCm) {
    return { available: true, reached: true, seconds: 0, label: 'Threshold reached' };
  }
  if (!isReliableRise || slopeCmPerMin <= 0) {
    return { available: false, reached: false, seconds: null, label: 'Not available' };
  }

  const remainingCm = thresholdCm - currentDepthCm;
  const minutesToThreshold = remainingCm / slopeCmPerMin;
  const secondsToThreshold = minutesToThreshold * 60;

  // Guard against absurdly distant projections caused by tiny noisy slopes
  if (!Number.isFinite(secondsToThreshold) || secondsToThreshold > 24 * 3600) {
    return { available: false, reached: false, seconds: null, label: 'Not available' };
  }

  return {
    available: true,
    reached: false,
    seconds: Math.round(secondsToThreshold),
    label: `~${formatEtaDuration(secondsToThreshold)}`
  };
}

/**
 * Full real-time telemetry analysis for the FloodGuard Dashboard.
 *
 * @param {Array<{timestampMs:number, distanceCm:number|null, depthCm:number, mountHeightCm:number}>} samples
 * @param {object} settings - Prototype thresholds & noise-filter configuration
 * @param {string} sourceMode - 'LIVE' | 'SIMULATED' | 'UNAVAILABLE'
 */
export function analyzeWaterTelemetry(samples, settings = DEFAULT_PROTOTYPE_SETTINGS, sourceMode = 'UNAVAILABLE') {
  const cfg = { ...DEFAULT_PROTOTYPE_SETTINGS, ...settings };

  if (sourceMode === 'UNAVAILABLE' || !Array.isArray(samples) || samples.length === 0) {
    return {
      available: false,
      sourceMode: 'UNAVAILABLE',
      status: 'UNAVAILABLE',
      statusLabel: 'Unavailable',
      trend: 'UNAVAILABLE',
      trendLabel: 'No Active Signal',
      currentDepthCm: null,
      rawDepthCm: null,
      measuredDistanceCm: null,
      mountHeightCm: cfg.mountHeightCm,
      rateCmPerMin: null,
      rSquared: 0,
      isReliableRise: false,
      isDraining: false,
      etaWarning: { available: false, reached: false, seconds: null, label: 'Not available' },
      etaCritical: { available: false, reached: false, seconds: null, label: 'Not available' },
      filteredSamples: [],
      sampleCount: 0,
      lastUpdatedMs: null
    };
  }

  // Smooth the full display history with a 3-point median filter
  const filteredSamples = filterDepthSamples(samples, 3);
  const latest = filteredSamples[filteredSamples.length - 1];
  const currentDepthCm = latest.filteredDepthCm;

  // Use a focused rolling window (last 10 samples) for responsive rate-of-change detection
  const rollingWindow = filteredSamples.slice(-10);
  const { slopeCmPerMin, rSquared, spanSec } = computeLinearTrend(rollingWindow);

  // Determine rising / falling / stable state with deadband & noise guard
  const enoughData = rollingWindow.length >= 4 && spanSec >= 2.5;
  const stableBand = Math.max(0.05, Number(cfg.stableBandCmPerMin) || 0.15);
  const minRiseRate = Math.max(stableBand, Number(cfg.minRiseRateCmPerMin) || 0.25);

  // Net change across the rolling window guards against pure high-frequency ripple
  const netDeltaCm = rollingWindow.length >= 2
    ? rollingWindow[rollingWindow.length - 1].filteredDepthCm - rollingWindow[0].filteredDepthCm
    : 0;

  let trend = 'STABLE';
  let trendLabel = 'Stable';
  let isReliableRise = false;
  let isDraining = false;

  if (!enoughData) {
    trend = 'STABLE';
    trendLabel = 'Collecting baseline…';
  } else if (slopeCmPerMin >= stableBand && netDeltaCm >= 0.1) {
    trend = 'RISING';
    trendLabel = 'Rising';
    isReliableRise = slopeCmPerMin >= minRiseRate && rSquared >= 0.45 && netDeltaCm >= 0.15;
  } else if (slopeCmPerMin <= -stableBand && netDeltaCm <= -0.1) {
    trend = 'FALLING';
    trendLabel = 'Falling (Draining)';
    isDraining = true;
  } else {
    trend = 'STABLE';
    trendLabel = 'Stable';
  }

  // Evaluate flood status level against configurable prototype thresholds
  let status = 'NORMAL';
  let statusLabel = 'NORMAL';
  if (currentDepthCm >= cfg.critThresholdCm) {
    status = 'CRITICAL';
    statusLabel = 'CRITICAL';
  } else if (currentDepthCm >= cfg.warnThresholdCm) {
    status = 'WARNING';
    statusLabel = 'WARNING';
  }

  const etaWarning = projectThresholdEta(currentDepthCm, cfg.warnThresholdCm, slopeCmPerMin, isReliableRise);
  const etaCritical = projectThresholdEta(currentDepthCm, cfg.critThresholdCm, slopeCmPerMin, isReliableRise);

  return {
    available: true,
    sourceMode,
    status,
    statusLabel,
    trend,
    trendLabel,
    currentDepthCm,
    rawDepthCm: latest.depthCm,
    measuredDistanceCm: latest.distanceCm,
    mountHeightCm: latest.mountHeightCm ?? cfg.mountHeightCm,
    rateCmPerMin: enoughData ? slopeCmPerMin : 0,
    rSquared,
    isReliableRise,
    isDraining,
    etaWarning,
    etaCritical,
    filteredSamples,
    sampleCount: filteredSamples.length,
    lastUpdatedMs: latest.timestampMs
  };
}
