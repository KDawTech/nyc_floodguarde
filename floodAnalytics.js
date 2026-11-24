/**
 * ============================================================================
 * NYC FloodGuard 2.0 — Reliable Ultrasonic Signal Validation, Noise Filtering,
 *                      Statistical Trend Detection & Early-Warning ETA Engine
 * File: floodAnalytics.js
 *
 * Calibrated for the finalized 3D-printed miniature NYC street prototype:
 *   - Dynamic dry-road baseline (auto-locked from Arduino serial telemetry)
 *   - Synchronized miniature prototype alert thresholds:
 *       NORMAL:   < 0.25 cm
 *       WARNING:  0.25 cm to below 0.60 cm
 *       CRITICAL: >= 0.60 cm
 *   - Also supports Admin-configured thresholds from Supabase `monitoring_settings`
 *     and larger deep-basin setups.
 *
 * Key Guarantees:
 *   1. Mathematical Consistency:
 *      - Filtered Depth (cm) = clamp(Mount Height - Filtered Distance, >= 0)
 *   2. Out-of-Range Protection:
 *      - Distances < 2.0 cm (HC-SR04 blind zone), > Mount Height + 2.0 cm, or
 *        timeouts are flagged OUT_OF_RANGE and NEVER displayed as 0.00 cm depth.
 *   3. Spike Rejection & Causal Median Filtering (with confirmed step-shift reset)
 *   4. Sensor Quality Classification: GOOD | UNSTABLE | OUT_OF_RANGE | UNAVAILABLE
 *   5. Statistically Reliable Trend & Strict ETA Gating
 * ============================================================================
 */

export const PROTOTYPE_PRESETS = {
  EXPERIMENTAL_STREET_MODEL: {
    label: 'Miniature Street Model (0.25 / 0.60 cm)',
    mountHeightCm: 7.88,
    warnThresholdCm: 0.25,
    critThresholdCm: 0.60,
    minRiseRateCmPerMin: 0.08,
    stableBandCmPerMin: 0.04,
    barrierThresholdCm: 0.50
  },
  DEEP_BASIN_MODEL: {
    label: 'Deep Basin Calibration (6.0 / 12.0 cm)',
    mountHeightCm: 25.0,
    warnThresholdCm: 6.0,
    critThresholdCm: 12.0,
    minRiseRateCmPerMin: 0.25,
    stableBandCmPerMin: 0.20,
    barrierThresholdCm: 10.0
  }
};

export const DEFAULT_PROTOTYPE_SETTINGS = {
  mountHeightCm: 7.88,          // Default reference baseline (auto-locked from Arduino dry-road telemetry)
  warnThresholdCm: 0.25,        // Miniature prototype Warning level (Amber: 0.25 to < 0.60 cm)
  critThresholdCm: 0.60,        // Miniature prototype Critical level (Red: >= 0.60 cm)
  minRiseRateCmPerMin: 0.08,    // Minimum slope (cm/min) required for Rising / Falling
  stableBandCmPerMin: 0.04,     // Slope deadband (±cm/min) for Stable classification
  barrierThresholdCm: 0.50,     // Optional future servo flood barrier trigger threshold
  staleTimeoutMs: 10000,        // Live serial timeout before showing UNAVAILABLE
  minValidDistanceCm: 2.0,      // HC-SR04 minimum physical sensing range
  dryToleranceCm: 2.0,          // Small acoustic noise allowance beyond dry floor before OUT_OF_RANGE
  spikeJumpCm: 3.0,             // Single-frame jump threshold vs. trailing median
  maxGoodResidualStdCm: 0.35,   // Max regression residual std dev (cm) for GOOD quality
  maxGoodBurstSpreadCm: 2.5     // Max firmware 5-ping burst spread (cm) for GOOD quality
};

/**
 * Validates a raw ultrasonic distance measurement against physical HC-SR04
 * limits and the sensor's dry-road mounting height.
 * Never converts out-of-range measurements into 0.00 cm water depth.
 */
export function validateDistanceReading(
  mountHeightCm,
  measuredDistanceCm,
  settings = DEFAULT_PROTOTYPE_SETTINGS,
  errorCode = null
) {
  const cfg = { ...DEFAULT_PROTOTYPE_SETTINGS, ...settings };
  const mount = Number(mountHeightCm);
  const dist = measuredDistanceCm != null ? Number(measuredDistanceCm) : NaN;

  if (errorCode && (errorCode !== 'out_of_range' || !Number.isFinite(dist))) {
    return {
      valid: false,
      reason:
        errorCode === 'ultrasonic_timeout'
          ? 'Ultrasonic echo timeout (no valid return pulse)'
          : errorCode === 'out_of_range'
          ? 'Ultrasonic reading reported out of range by firmware'
          : `Sensor reported error: ${errorCode}`,
      rawDistanceCm: Number.isFinite(dist) ? Number(dist.toFixed(2)) : null,
      rawDepthCm: null
    };
  }

  if (!Number.isFinite(mount) || mount <= cfg.minValidDistanceCm) {
    return {
      valid: false,
      reason: 'Invalid sensor mounting height configuration',
      rawDistanceCm: Number.isFinite(dist) ? Number(dist.toFixed(2)) : null,
      rawDepthCm: null
    };
  }

  if (!Number.isFinite(dist)) {
    return {
      valid: false,
      reason: 'Missing or non-numeric ultrasonic distance',
      rawDistanceCm: null,
      rawDepthCm: null
    };
  }

  if (dist < cfg.minValidDistanceCm) {
    return {
      valid: false,
      reason: `Measured distance (${dist.toFixed(2)} cm) is below HC-SR04 minimum range (${cfg.minValidDistanceCm.toFixed(1)} cm)`,
      rawDistanceCm: Number(dist.toFixed(2)),
      rawDepthCm: null
    };
  }

  const maxValidDist = mount + cfg.dryToleranceCm;
  if (dist > maxValidDist) {
    return {
      valid: false,
      reason: `Measured distance (${dist.toFixed(2)} cm) exceeds dry street floor (${mount.toFixed(2)} cm + ${cfg.dryToleranceCm.toFixed(1)} cm tolerance)`,
      rawDistanceCm: Number(dist.toFixed(2)),
      rawDepthCm: null
    };
  }

  const exactDiff = Number((mount - dist).toFixed(2));
  const clampedDepth = Math.max(0, exactDiff);

  return {
    valid: true,
    reason: '',
    rawDistanceCm: Number(dist.toFixed(2)),
    rawDepthCm: clampedDepth,
    exactDiffCm: exactDiff,
    withinDryTolerance: dist > mount
  };
}

export function computeWaterDepthCm(mountHeightCm, measuredDistanceCm, settings = DEFAULT_PROTOTYPE_SETTINGS) {
  const check = validateDistanceReading(mountHeightCm, measuredDistanceCm, settings);
  return check.valid ? check.rawDepthCm : null;
}

function medianOf(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function standardDeviation(values) {
  if (!values || values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

/**
 * Processes raw telemetry packets (supporting both Arduino on-device filtered text packets
 * and raw/JSON packets) to produce mathematically consistent filtered values and quality flags.
 */
export function processTelemetryBuffer(rawPackets, settings = DEFAULT_PROTOTYPE_SETTINGS) {
  const cfg = { ...DEFAULT_PROTOTYPE_SETTINGS, ...settings };
  if (!Array.isArray(rawPackets) || rawPackets.length === 0) {
    return {
      processedPackets: [],
      validFilteredSeries: [],
      consecutiveOutOfRange: 0,
      recentOutOfRangeCount: 0,
      recentSpikeCount: 0,
      recentSuspiciousCount: 0,
      latestPacket: null
    };
  }

  const processedPackets = [];
  let acceptedDistances = [];
  let acceptedDepths = [];
  const validFilteredSeries = [];
  let pendingJumpCandidate = null;

  for (let i = 0; i < rawPackets.length; i++) {
    const pkt = rawPackets[i];
    const mount = Number.isFinite(pkt.mountHeightCm) ? pkt.mountHeightCm : cfg.mountHeightCm;
    const isAuthoritativeText = pkt.format === 'text' && Number.isFinite(pkt.reportedDepthCm);

    // Physical validation of distance (wider upper tolerance for dry acoustic scatter so
    // authoritative Arduino 0.00 cm dry readings like 15.78 cm are flagged as suspicious
    // scatter rather than inventing water depth or crashing the baseline).
    const validationCfg = isAuthoritativeText
      ? { ...cfg, dryToleranceCm: Math.max(cfg.dryToleranceCm, 3.5) }
      : cfg;
    const validation = validateDistanceReading(mount, pkt.distanceCm, validationCfg, pkt.errorCode || null);

    if (!validation.valid) {
      pendingJumpCandidate = null;
      processedPackets.push({
        timestampMs: pkt.timestampMs,
        mountHeightCm: Number(mount.toFixed(2)),
        rawDistanceCm: validation.rawDistanceCm,
        rawDepthCm: null,
        reportedDepthCm: Number.isFinite(pkt.reportedDepthCm) ? Number(pkt.reportedDepthCm.toFixed(2)) : null,
        valid: false,
        isOutOfRange: true,
        isSpike: false,
        isSuspicious: true,
        suspiciousReason: validation.reason,
        invalidReason: validation.reason,
        reportedStatus: pkt.reportedStatus || null,
        packetFormat: pkt.format || 'json',
        burstSpreadCm: pkt.burstSpreadCm ?? null,
        validPings: pkt.validPings ?? null,
        firmwareQuality: pkt.firmwareQuality || null
      });
      continue;
    }

    // Suspicious reading checks (flagged honestly without inventing measurements)
    let isSuspicious = false;
    let suspiciousReason = '';

    if (isAuthoritativeText) {
      // Check 1: Dry-road acoustic scatter well above the locked dry baseline
      if (pkt.reportedDepthCm === 0 && validation.rawDistanceCm > mount + 1.25) {
        isSuspicious = true;
        suspiciousReason = `Dry distance (${validation.rawDistanceCm.toFixed(2)} cm) is +${(validation.rawDistanceCm - mount).toFixed(2)} cm above locked baseline (${mount.toFixed(2)} cm) — echo scatter`;
      }
      // Check 2: Baseline mismatch during positive water depth (do NOT overwrite baseline!)
      if (pkt.reportedDepthCm > 0.05) {
        const impliedBaseline = validation.rawDistanceCm + pkt.reportedDepthCm;
        const baselineDrift = Math.abs(impliedBaseline - mount);
        if (baselineDrift > 0.75) {
          isSuspicious = true;
          suspiciousReason = `Distance + Depth (${impliedBaseline.toFixed(2)} cm) differs from locked baseline (${mount.toFixed(2)} cm) by ${baselineDrift.toFixed(2)} cm — verify riser / recalibrate when dry`;
        }
      }
      // Check 3: Sudden single-frame depth jump (> 2.0 cm vs recent median)
      if (acceptedDepths.length >= 3) {
        const refMedianDepth = medianOf(acceptedDepths.slice(-5));
        const depthJump = Math.abs(pkt.reportedDepthCm - refMedianDepth);
        if (depthJump > 2.0) {
          isSuspicious = true;
          suspiciousReason = `Sudden single-reading depth jump of ${depthJump.toFixed(2)} cm vs. recent median (${refMedianDepth.toFixed(2)} cm)`;
        }
      }

      acceptedDistances.push(validation.rawDistanceCm);
      acceptedDepths.push(pkt.reportedDepthCm);

      // Authoritative Arduino text values: preserve exact reported water depth & distance
      const authoritativeDepth = Math.max(0, Number(pkt.reportedDepthCm.toFixed(2)));
      const entry = {
        timestampMs: pkt.timestampMs,
        mountHeightCm: Number(mount.toFixed(2)),
        rawDistanceCm: validation.rawDistanceCm,
        rawDepthCm: authoritativeDepth,
        reportedDepthCm: authoritativeDepth,
        filteredDistanceCm: validation.rawDistanceCm,
        filteredDepthCm: authoritativeDepth,
        filterWindowSize: 1,
        valid: true,
        isOutOfRange: false,
        isSpike: false,
        isSuspicious,
        suspiciousReason,
        invalidReason: '',
        reportedStatus: pkt.reportedStatus || null,
        packetFormat: pkt.format || 'text',
        burstSpreadCm: pkt.burstSpreadCm ?? null,
        validPings: pkt.validPings ?? null,
        firmwareQuality: pkt.firmwareQuality || null
      };
      processedPackets.push(entry);
      validFilteredSeries.push(entry);
      continue;
    }

    // Non-text streams (JSON firmware or Demo Mode): isolated spike rejection + 3-sample median
    let isSpike = false;
    let spikeReason = '';
    if (acceptedDistances.length >= 3) {
      const refWindow = acceptedDistances.slice(-5);
      const refMedianDist = medianOf(refWindow);
      const jump = Math.abs(validation.rawDistanceCm - refMedianDist);

      if (jump > cfg.spikeJumpCm) {
        if (
          pendingJumpCandidate != null &&
          Math.abs(validation.rawDistanceCm - pendingJumpCandidate) <= cfg.spikeJumpCm * 0.6
        ) {
          pendingJumpCandidate = null;
          acceptedDistances = [validation.rawDistanceCm];
        } else {
          isSpike = true;
          spikeReason = `Isolated jump of ${jump.toFixed(2)} cm vs. recent median (${refMedianDist.toFixed(2)} cm) rejected`;
          pendingJumpCandidate = validation.rawDistanceCm;
        }
      } else {
        pendingJumpCandidate = null;
      }
    }

    if (!isSpike) {
      acceptedDistances.push(validation.rawDistanceCm);
      const nAcc = acceptedDistances.length;
      const winSize = nAcc >= 3 ? 3 : 1;
      const trailingSlice = acceptedDistances.slice(-winSize);
      const filteredDistanceCm = Number(medianOf(trailingSlice).toFixed(2));
      const filteredDepthCm = Math.max(0, Number((mount - filteredDistanceCm).toFixed(2)));
      acceptedDepths.push(filteredDepthCm);

      const entry = {
        timestampMs: pkt.timestampMs,
        mountHeightCm: Number(mount.toFixed(2)),
        rawDistanceCm: validation.rawDistanceCm,
        rawDepthCm: validation.rawDepthCm,
        reportedDepthCm: Number.isFinite(pkt.reportedDepthCm) ? Number(pkt.reportedDepthCm.toFixed(2)) : null,
        filteredDistanceCm,
        filteredDepthCm,
        filterWindowSize: winSize,
        valid: true,
        isOutOfRange: false,
        isSpike: false,
        isSuspicious: false,
        suspiciousReason: '',
        invalidReason: '',
        reportedStatus: pkt.reportedStatus || null,
        packetFormat: pkt.format || 'json',
        burstSpreadCm: pkt.burstSpreadCm ?? null,
        validPings: pkt.validPings ?? null,
        firmwareQuality: pkt.firmwareQuality || null
      };
      processedPackets.push(entry);
      validFilteredSeries.push(entry);
    } else {
      processedPackets.push({
        timestampMs: pkt.timestampMs,
        mountHeightCm: Number(mount.toFixed(2)),
        rawDistanceCm: validation.rawDistanceCm,
        rawDepthCm: validation.rawDepthCm,
        reportedDepthCm: null,
        filteredDistanceCm: null,
        filteredDepthCm: null,
        valid: true,
        isOutOfRange: false,
        isSpike: true,
        isSuspicious: true,
        suspiciousReason: spikeReason,
        invalidReason: spikeReason,
        reportedStatus: pkt.reportedStatus || null,
        packetFormat: pkt.format || 'json',
        burstSpreadCm: pkt.burstSpreadCm ?? null,
        validPings: pkt.validPings ?? null,
        firmwareQuality: pkt.firmwareQuality || null
      });
    }
  }

  let consecutiveOutOfRange = 0;
  for (let i = processedPackets.length - 1; i >= 0; i--) {
    if (processedPackets[i].isOutOfRange) consecutiveOutOfRange++;
    else break;
  }

  const recentWindow = processedPackets.slice(-8);
  const recentOutOfRangeCount = recentWindow.filter((p) => p.isOutOfRange).length;
  const recentSpikeCount = recentWindow.filter((p) => p.isSpike).length;
  const recentSuspiciousCount = recentWindow.filter((p) => p.isSuspicious).length;

  return {
    processedPackets,
    validFilteredSeries,
    consecutiveOutOfRange,
    recentOutOfRangeCount,
    recentSpikeCount,
    recentSuspiciousCount,
    latestPacket: processedPackets[processedPackets.length - 1] || null
  };
}

function computeStatisticalTrend(series) {
  const n = series.length;
  if (n < 3) {
    return {
      slopeCmPerMin: 0,
      rSquared: 0,
      residualStdCm: 0,
      tStat: 0,
      spanSec: 0,
      netDeltaCm: 0
    };
  }

  const t0 = series[0].timestampMs;
  const tLast = series[n - 1].timestampMs;
  const spanSec = (tLast - t0) / 1000;
  const netDeltaCm = Number((series[n - 1].filteredDepthCm - series[0].filteredDepthCm).toFixed(2));

  if (spanSec < 1.5) {
    return {
      slopeCmPerMin: 0,
      rSquared: 0,
      residualStdCm: 0,
      tStat: 0,
      spanSec: Number(spanSec.toFixed(1)),
      netDeltaCm
    };
  }

  const xs = series.map((s) => (s.timestampMs - t0) / 60000);
  const ys = series.map((s) => s.filteredDepthCm);

  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

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
    return {
      slopeCmPerMin: 0,
      rSquared: 0,
      residualStdCm: Number(standardDeviation(ys).toFixed(3)),
      tStat: 0,
      spanSec: Number(spanSec.toFixed(1)),
      netDeltaCm
    };
  }

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  let sse = 0;
  for (let i = 0; i < n; i++) {
    const predicted = intercept + slope * xs[i];
    const err = ys[i] - predicted;
    sse += err * err;
  }

  const dof = Math.max(1, n - 2);
  const residualVariance = sse / dof;
  const residualStdCm = Math.sqrt(Math.max(0, residualVariance));
  const seSlope = Math.sqrt(Math.max(0, residualVariance / sxx));
  const tStat = seSlope > 1e-9 ? Math.abs(slope) / seSlope : Math.abs(slope) > 0 ? 99 : 0;
  const rSquared = syy > 1e-6 ? Math.min(1, Math.max(0, 1 - sse / syy)) : 0;

  return {
    slopeCmPerMin: Number(slope.toFixed(3)),
    rSquared: Number(rSquared.toFixed(3)),
    residualStdCm: Number(residualStdCm.toFixed(3)),
    tStat: Number(Math.min(99, tStat).toFixed(2)),
    spanSec: Number(spanSec.toFixed(1)),
    netDeltaCm
  };
}

export function formatEtaDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'Not available';
  const rounded = Math.round(seconds);
  if (rounded < 60) return `${rounded} sec`;
  const mins = Math.floor(rounded / 60);
  const remSec = rounded % 60;
  if (mins < 60) return remSec > 0 ? `${mins} min ${remSec} sec` : `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hrs > 24) return '> 24 hr';
  return remMins > 0 ? `${hrs} hr ${remMins} min` : `${hrs} hr`;
}

function projectThresholdEta(currentDepthCm, thresholdCm, slopeCmPerMin, allowEta) {
  if (!Number.isFinite(currentDepthCm) || !Number.isFinite(thresholdCm)) {
    return { available: false, reached: false, seconds: null, label: 'Not available' };
  }
  if (!allowEta) {
    return { available: false, reached: false, seconds: null, label: 'Not available' };
  }
  if (currentDepthCm >= thresholdCm) {
    return { available: true, reached: true, seconds: 0, label: 'Threshold reached' };
  }
  if (slopeCmPerMin <= 0) {
    return { available: false, reached: false, seconds: null, label: 'Not available' };
  }
  const remainingCm = thresholdCm - currentDepthCm;
  const secondsToThreshold = (remainingCm / slopeCmPerMin) * 60;
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

export function analyzeWaterTelemetry(rawPackets, settings = DEFAULT_PROTOTYPE_SETTINGS, sourceMode = 'UNAVAILABLE') {
  const cfg = { ...DEFAULT_PROTOTYPE_SETTINGS, ...settings };

  if (sourceMode === 'UNAVAILABLE' || !Array.isArray(rawPackets) || rawPackets.length === 0) {
    return {
      available: false,
      sourceMode: 'UNAVAILABLE',
      sensorQuality: 'UNAVAILABLE',
      sensorQualityLabel: 'Unavailable',
      sensorQualityReason: 'No active sensor stream connected',
      status: 'UNAVAILABLE',
      statusLabel: 'UNAVAILABLE',
      statusSource: 'none',
      trend: 'UNAVAILABLE',
      trendLabel: 'Unavailable',
      trendDetail: 'Waiting for timestamped measurements',
      filteredDepthCm: null,
      filteredDistanceCm: null,
      rawDepthCm: null,
      rawDistanceCm: null,
      rawReadingStatus: 'UNAVAILABLE',
      mountHeightCm: cfg.mountHeightCm,
      rateCmPerMin: null,
      rSquared: 0,
      tStat: 0,
      residualStdCm: 0,
      isReliableRise: false,
      isReliableFall: false,
      predictionConfidence: 'INSUFFICIENT_DATA',
      predictionConfidenceLabel: 'Insufficient Data',
      predictionLimitation: 'Linear trend extrapolation requires at least 4 clean readings over 3 seconds (not a validated weather forecast).',
      etaWarning: { available: false, reached: false, seconds: null, label: 'Insufficient Data' },
      etaCritical: { available: false, reached: false, seconds: null, label: 'Insufficient Data' },
      filteredSamples: [],
      sampleCount: 0,
      lastUpdatedMs: null,
      suspiciousReading: false,
      suspiciousReason: '',
      recentSuspiciousCount: 0,
      authoritativeArduino: false,
      alertConfidenceNote: ''
    };
  }

  const processed = processTelemetryBuffer(rawPackets, cfg);
  const {
    validFilteredSeries,
    consecutiveOutOfRange,
    recentOutOfRangeCount,
    recentSpikeCount,
    recentSuspiciousCount,
    latestPacket
  } = processed;

  if (validFilteredSeries.length === 0 || consecutiveOutOfRange >= 2) {
    const mountVal = latestPacket?.mountHeightCm ?? cfg.mountHeightCm;
    return {
      available: false,
      sourceMode,
      sensorQuality: 'OUT_OF_RANGE',
      sensorQualityLabel: 'Out of Range',
      sensorQualityReason:
        latestPacket?.invalidReason ||
        'Ultrasonic readings are out of valid physical range (not interpreted as 0.00 cm)',
      status: 'OUT_OF_RANGE',
      statusLabel: 'OUT OF RANGE',
      statusSource: 'validation',
      trend: 'UNCERTAIN',
      trendLabel: 'Uncertain',
      trendDetail: 'Ultrasonic measurements are out of range — check sensor alignment and wiring',
      filteredDepthCm: null,
      filteredDistanceCm: null,
      rawDepthCm: null,
      rawDistanceCm: latestPacket?.rawDistanceCm ?? null,
      rawReadingStatus: 'OUT_OF_RANGE',
      mountHeightCm: mountVal,
      rateCmPerMin: null,
      rSquared: 0,
      tStat: 0,
      residualStdCm: 0,
      isReliableRise: false,
      isReliableFall: false,
      predictionConfidence: 'INSUFFICIENT_DATA',
      predictionConfidenceLabel: 'Insufficient Data',
      predictionLimitation: 'Prediction disabled while ultrasonic readings are Out of Range.',
      etaWarning: { available: false, reached: false, seconds: null, label: 'Insufficient Data' },
      etaCritical: { available: false, reached: false, seconds: null, label: 'Insufficient Data' },
      filteredSamples: validFilteredSeries,
      sampleCount: validFilteredSeries.length,
      lastUpdatedMs: latestPacket?.timestampMs ?? null,
      suspiciousReading: true,
      suspiciousReason: latestPacket?.suspiciousReason || latestPacket?.invalidReason || 'Out of valid ultrasonic range',
      recentSuspiciousCount,
      authoritativeArduino: false,
      alertConfidenceNote: 'Sensor out of range — no flood depth fabricated.'
    };
  }

  const latestValid = validFilteredSeries[validFilteredSeries.length - 1];
  const filteredDepthCm = latestValid.filteredDepthCm;
  const filteredDistanceCm = latestValid.filteredDistanceCm;
  const mountHeightCm = latestValid.mountHeightCm;
  const authoritativeArduino = latestValid.packetFormat === 'text' && latestValid.reportedDepthCm != null;

  const stabilizedSeries =
    validFilteredSeries.length >= 7
      ? validFilteredSeries.filter((s) => s.filterWindowSize === 3)
      : validFilteredSeries;
  const rollingWindow = (stabilizedSeries.length >= 4 ? stabilizedSeries : validFilteredSeries).slice(-10);
  const stats = computeStatisticalTrend(rollingWindow);

  const rawSeriesForNoise = rollingWindow.map((s) => ({
    timestampMs: s.timestampMs,
    filteredDepthCm: s.rawDepthCm
  }));
  const rawNoiseStats = computeStatisticalTrend(rawSeriesForNoise);
  const rawNoiseStdCm = rawNoiseStats.residualStdCm;

  let sensorQuality = 'GOOD';
  let sensorQualityLabel = 'Good';
  let sensorQualityReason = 'Consistent ultrasonic echoes within calibrated range';

  const latestBurstTooNoisy =
    latestPacket?.burstSpreadCm != null && latestPacket.burstSpreadCm > cfg.maxGoodBurstSpreadCm;
  const latestTooFewPings =
    latestPacket?.validPings != null && latestPacket.validPings < 3;

  if (latestPacket?.isOutOfRange) {
    sensorQuality = 'OUT_OF_RANGE';
    sensorQualityLabel = 'Out of Range';
    sensorQualityReason = `${latestPacket.invalidReason} (isolated reading rejected; holding previous value)`;
  } else if (
    latestPacket?.isSpike ||
    latestPacket?.isSuspicious ||
    recentSpikeCount >= 2 ||
    recentOutOfRangeCount >= 2 ||
    stats.residualStdCm > cfg.maxGoodResidualStdCm ||
    rawNoiseStdCm > 0.75 ||
    latestBurstTooNoisy ||
    latestTooFewPings ||
    latestPacket?.firmwareQuality === 'unstable'
  ) {
    sensorQuality = 'UNSTABLE';
    sensorQualityLabel = 'Unstable';
    if (latestPacket?.isSuspicious && latestPacket.suspiciousReason) {
      sensorQualityReason = latestPacket.suspiciousReason;
    } else if (latestPacket?.isSpike) {
      sensorQualityReason = latestPacket.invalidReason;
    } else if (latestTooFewPings) {
      sensorQualityReason = `Only ${latestPacket.validPings}/5 ultrasonic pings returned valid echoes`;
    } else if (latestBurstTooNoisy) {
      sensorQualityReason = `High echo spread within burst (${latestPacket.burstSpreadCm.toFixed(2)} cm)`;
    } else if (recentOutOfRangeCount >= 2 || recentSpikeCount >= 2) {
      sensorQualityReason = `Intermittent echoes (${recentSpikeCount} spike, ${recentOutOfRangeCount} out-of-range in recent window)`;
    } else {
      sensorQualityReason = `Elevated surface noise or echo jitter (raw σ = ${rawNoiseStdCm.toFixed(2)} cm, filtered σ = ${stats.residualStdCm.toFixed(2)} cm)`;
    }
  }

  const rawReadingStatus = latestPacket?.isOutOfRange
    ? 'OUT_OF_RANGE'
    : latestPacket?.isSpike
    ? 'SPIKE_REJECTED'
    : latestPacket?.isSuspicious
    ? 'SUSPICIOUS'
    : 'VALID';

  // Statistically reliable trend classification (scaled cleanly for miniature street model depths)
  const enoughData = rollingWindow.length >= 4 && stats.spanSec >= 3.0;
  const stableBand = Math.max(0.05, Number(cfg.stableBandCmPerMin) || 0.06);
  const minSlope = Math.max(stableBand, Number(cfg.minRiseRateCmPerMin) || 0.12);
  const minNetDeltaCm = Math.min(0.25, Math.max(0.05, (cfg.critThresholdCm - cfg.warnThresholdCm) * 0.14));

  let trend = 'STABLE';
  let trendLabel = 'Stable';
  let trendDetail = 'Water level is steady within measurement tolerance';
  let isReliableRise = false;
  let isReliableFall = false;

  if (sensorQuality !== 'GOOD') {
    trend = 'UNCERTAIN';
    trendLabel = 'Uncertain';
    trendDetail =
      sensorQuality === 'OUT_OF_RANGE'
        ? 'Latest ultrasonic reading out of range — trend and ETA paused'
        : 'Suspicious reading or echo jitter flagged — short-term trend uncertain';
  } else if (!enoughData) {
    trend = 'UNCERTAIN';
    trendLabel = 'Collecting baseline…';
    trendDetail = `Need at least 4 clean samples over 3s (${rollingWindow.length}/4 collected)`;
  } else {
    const statReliable = stats.rSquared >= 0.65 && stats.tStat >= 2.2;
    if (stats.slopeCmPerMin >= minSlope && stats.netDeltaCm >= minNetDeltaCm && statReliable) {
      trend = 'RISING';
      trendLabel = 'Rising Water';
      trendDetail = `Reliable upward trend (R² = ${stats.rSquared.toFixed(2)}, Δ = +${stats.netDeltaCm.toFixed(2)} cm)`;
      isReliableRise = true;
    } else if (stats.slopeCmPerMin <= -minSlope && stats.netDeltaCm <= -minNetDeltaCm && statReliable) {
      trend = 'FALLING';
      trendLabel = 'Falling Water';
      trendDetail = `Water level is receding (R² = ${stats.rSquared.toFixed(2)}, Δ = ${stats.netDeltaCm.toFixed(2)} cm)`;
      isReliableFall = true;
    } else if (
      Math.abs(stats.slopeCmPerMin) < stableBand &&
      Math.abs(stats.netDeltaCm) < minNetDeltaCm &&
      stats.residualStdCm <= 0.30
    ) {
      trend = 'STABLE';
      trendLabel = 'Stable';
      trendDetail = 'Water level is steady across the rolling window';
    } else {
      trend = 'UNCERTAIN';
      trendLabel = 'Uncertain';
      trendDetail = `Short-term direction not yet statistically consistent (R² = ${stats.rSquared.toFixed(2)}, t = ${stats.tStat.toFixed(1)})`;
    }
  }

  // Evaluate flood status:
  // Arduino confirmed status on calibrated text lines is ALWAYS authoritative.
  let status = 'NORMAL';
  let statusSource = 'thresholds';
  if (latestValid.packetFormat === 'text' && latestValid.reportedStatus) {
    status = latestValid.reportedStatus;
    statusSource = 'arduino_confirmed';
  } else if (filteredDepthCm >= cfg.critThresholdCm) {
    status = 'CRITICAL';
  } else if (filteredDepthCm >= cfg.warnThresholdCm) {
    status = 'WARNING';
  }

  // Explicitly distinguish uncertain short-term trend from a confirmed flood alert
  let alertConfidenceNote = '';
  if ((status === 'CRITICAL' || status === 'WARNING') && trend === 'UNCERTAIN') {
    alertConfidenceNote =
      statusSource === 'arduino_confirmed'
        ? `Confirmed ${status} alert from Arduino remains active even while short-term trend is uncertain.`
        : `${status} threshold is currently exceeded even though short-term trend direction is uncertain.`;
  } else if ((status === 'CRITICAL' || status === 'WARNING') && statusSource === 'arduino_confirmed') {
    alertConfidenceNote = `Authoritative ${status} status confirmed by Arduino (3-reading verification).`;
  }

  const rawEtaWarn =
    sensorQuality === 'GOOD' && (filteredDepthCm >= cfg.warnThresholdCm || status === 'WARNING' || status === 'CRITICAL')
      ? { available: true, reached: true, seconds: 0, label: 'Threshold reached' }
      : projectThresholdEta(filteredDepthCm, cfg.warnThresholdCm, stats.slopeCmPerMin, sensorQuality === 'GOOD' && isReliableRise);

  const rawEtaCrit =
    sensorQuality === 'GOOD' && (filteredDepthCm >= cfg.critThresholdCm || status === 'CRITICAL')
      ? { available: true, reached: true, seconds: 0, label: 'Threshold reached' }
      : projectThresholdEta(filteredDepthCm, cfg.critThresholdCm, stats.slopeCmPerMin, sensorQuality === 'GOOD' && isReliableRise);

  // Use clear "Insufficient Data" label whenever ETA projection cannot be reliably computed
  const etaWarning = rawEtaWarn.available
    ? rawEtaWarn
    : { ...rawEtaWarn, label: 'Insufficient Data' };
  const etaCritical = rawEtaCrit.available
    ? rawEtaCrit
    : { ...rawEtaCrit, label: 'Insufficient Data' };

  // Prediction confidence & transparent limitations
  let predictionConfidence = 'INSUFFICIENT_DATA';
  let predictionConfidenceLabel = 'Insufficient Data';
  let predictionLimitation =
    'Trend extrapolation only (assumes constant rise rate; not a validated weather or hydraulic forecast).';

  if (sensorQuality !== 'GOOD') {
    predictionConfidence = 'INSUFFICIENT_DATA';
    predictionConfidenceLabel = 'Insufficient Data';
    predictionLimitation = `Prediction suppressed while sensor quality is ${sensorQualityLabel} (splashes, spikes, or invalid echoes).`;
  } else if (!enoughData) {
    predictionConfidence = 'INSUFFICIENT_DATA';
    predictionConfidenceLabel = 'Insufficient Data';
    predictionLimitation = `Collecting rolling baseline (${rollingWindow.length}/4 clean readings over ≥ 3s).`;
  } else if (isReliableRise) {
    if (rollingWindow.length >= 6 && stats.rSquared >= 0.85 && stats.tStat >= 4.0) {
      predictionConfidence = 'HIGH';
      predictionConfidenceLabel = `High (R² = ${stats.rSquared.toFixed(2)}, n = ${rollingWindow.length})`;
    } else {
      predictionConfidence = 'MODERATE';
      predictionConfidenceLabel = `Moderate (R² = ${stats.rSquared.toFixed(2)}, n = ${rollingWindow.length})`;
    }
    predictionLimitation =
      'Short-term linear extrapolation assuming current rise rate continues; not a validated weather forecast.';
  } else if (trend === 'STABLE' || trend === 'FALLING') {
    predictionConfidence = 'NOT_RISING';
    predictionConfidenceLabel = trend === 'FALLING' ? 'Not Rising (Receding)' : 'Not Rising (Stable)';
    predictionLimitation =
      'Threshold arrival ETA is only projected when water level is rising consistently.';
  } else {
    predictionConfidence = 'INSUFFICIENT_DATA';
    predictionConfidenceLabel = 'Insufficient Data';
    predictionLimitation =
      'Short-term trend is noisy or inconsistent; prediction suppressed to avoid false alarms from ripples.';
  }

  return {
    available: true,
    sourceMode,
    sensorQuality,
    sensorQualityLabel,
    sensorQualityReason,
    status,
    statusLabel: status,
    statusSource,
    authoritativeArduino,
    alertConfidenceNote,
    trend,
    trendLabel,
    trendDetail,
    filteredDepthCm,
    filteredDistanceCm,
    rawDepthCm: latestPacket?.rawDepthCm ?? null,
    rawDistanceCm: latestPacket?.rawDistanceCm ?? null,
    rawReadingStatus,
    suspiciousReading: Boolean(latestPacket?.isSuspicious),
    suspiciousReason: latestPacket?.suspiciousReason || '',
    recentSuspiciousCount,
    mountHeightCm,
    rateCmPerMin: enoughData && sensorQuality === 'GOOD' ? stats.slopeCmPerMin : null,
    rawSlopeCmPerMin: stats.slopeCmPerMin,
    rSquared: stats.rSquared,
    tStat: stats.tStat,
    residualStdCm: stats.residualStdCm,
    isReliableRise,
    isReliableFall,
    predictionConfidence,
    predictionConfidenceLabel,
    predictionLimitation,
    etaWarning,
    etaCritical,
    filteredSamples: validFilteredSeries,
    sampleCount: validFilteredSeries.length,
    lastUpdatedMs: latestPacket?.timestampMs ?? latestValid.timestampMs
  };
}
