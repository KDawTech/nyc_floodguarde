/**
 * ============================================================================
 * NYC FloodGuard 2.0 — Independent Backup Float Sensor Tracker & Agreement Logic
 * File: floatSensor.js
 *
 * Supports the Liyafy XSL-3508-P float switch wired to Arduino GIGA R1 WiFi.
 *
 * Design Guarantees:
 *   1. Completely independent from HC-SR04 ultrasonic depth & flood alerts.
 *   2. NEVER triggers WARNING or CRITICAL flood status on its own.
 *   3. Logs every state transition (OPEN <-> CLOSED) with timestamps and
 *      concurrent ultrasonic depth (when available) for future field validation.
 *   4. Sensor-agreement indicator remains disabled until the user explicitly
 *      configures the float switch's measured physical activation height (cm).
 * ============================================================================
 */

export const FLOAT_AGREEMENT_TOLERANCE_CM = 0.2;

export function createInitialFloatSwitchState() {
  return {
    model: 'Liyafy XSL-3508-P',
    state: null, // 'OPEN' | 'CLOSED' | null
    lastUpdatedMs: null,
    lastRawLine: '',
    activationHeightCm: null, // Must be explicitly configured after physical mounting
    closedMeansWater: true, // true: CLOSED = water at/above activation height; false: OPEN = water
    transitionCount: 0,
    history: [] // newest first: { timestampMs, previousState, newState, transitionLabel, ultrasonicDepthCm, rawLine }
  };
}

/**
 * Records an incoming float-switch reading ('OPEN' or 'CLOSED').
 * Only appends a new timestamped log entry on the initial reading or when state changes.
 * Returns { changed: boolean, entry: object | null }.
 */
export function recordFloatSwitchReading(floatState, newState, { timestampMs = Date.now(), rawLine = '', ultrasonicDepthCm = null } = {}) {
  const normalized = newState === 'OPEN' || newState === 'CLOSED' ? newState : null;
  if (!normalized) {
    return { changed: false, entry: null };
  }

  const prev = floatState.state;
  floatState.lastUpdatedMs = timestampMs;
  if (rawLine) {
    floatState.lastRawLine = rawLine;
  }

  if (prev === normalized) {
    return { changed: false, entry: null };
  }

  floatState.state = normalized;
  const entry = {
    timestampMs,
    previousState: prev,
    newState: normalized,
    transitionLabel: prev ? `${prev} → ${normalized}` : `Initial: ${normalized}`,
    ultrasonicDepthCm: Number.isFinite(ultrasonicDepthCm) ? Number(ultrasonicDepthCm.toFixed(2)) : null,
    rawLine: rawLine || `Float Switch: ${normalized}`
  };

  if (prev !== null) {
    floatState.transitionCount += 1;
  }

  floatState.history.unshift(entry);
  if (floatState.history.length > 60) {
    floatState.history = floatState.history.slice(0, 60);
  }

  return { changed: true, entry };
}

/**
 * Evaluates agreement between the primary HC-SR04 ultrasonic sensor and the
 * backup Liyafy XSL-3508-P float switch.
 *
 * CRITICAL HONESTY RULE:
 *   If `activationHeightCm` is null / unconfigured, agreement checking is disabled
 *   because the float switch has not been mounted at a known physical depth yet.
 */
export function evaluateFloatAgreement(floatState, ultrasonicAnalysis) {
  const heightCm =
    floatState.activationHeightCm != null && Number.isFinite(Number(floatState.activationHeightCm))
      ? Number(floatState.activationHeightCm)
      : null;

  if (heightCm === null || heightCm <= 0) {
    return {
      status: 'UNCONFIGURED',
      tagClass: 'tag-neutral',
      label: 'Not Configured',
      detail:
        'Float switch passed electrical testing but is not yet mounted at a configured activation height. Set its physical activation height (cm) after mounting to enable ultrasonic agreement checks.'
    };
  }

  if (!floatState.state) {
    return {
      status: 'AWAITING_FLOAT',
      tagClass: 'tag-neutral',
      label: 'Awaiting Float Signal',
      detail: `Activation height set to ${heightCm.toFixed(2)} cm, waiting for live "Float Switch: OPEN/CLOSED" serial telemetry.`
    };
  }

  const hasValidUltrasonic =
    Boolean(ultrasonicAnalysis?.available) &&
    ultrasonicAnalysis?.status !== 'OUT_OF_RANGE' &&
    ultrasonicAnalysis?.filteredDepthCm != null &&
    Number.isFinite(Number(ultrasonicAnalysis.filteredDepthCm));

  if (!hasValidUltrasonic) {
    return {
      status: 'AWAITING_ULTRASONIC',
      tagClass: 'tag-neutral',
      label: 'Awaiting Ultrasonic',
      detail: `Float switch reports ${floatState.state} (configured at ${heightCm.toFixed(2)} cm), but valid ultrasonic depth is not currently available for comparison.`
    };
  }

  const depthCm = Number(ultrasonicAnalysis.filteredDepthCm);
  const floatIndicatesWater = floatState.closedMeansWater
    ? floatState.state === 'CLOSED'
    : floatState.state === 'OPEN';

  const diffFromHeight = depthCm - heightCm;
  if (Math.abs(diffFromHeight) <= FLOAT_AGREEMENT_TOLERANCE_CM) {
    return {
      status: 'TRANSITION_BAND',
      tagClass: 'tag-info',
      label: 'Near Activation Height',
      detail: `Ultrasonic depth (${depthCm.toFixed(2)} cm) is within ±${FLOAT_AGREEMENT_TOLERANCE_CM.toFixed(2)} cm of the configured ${heightCm.toFixed(2)} cm float height (float currently ${floatState.state}).`
    };
  }

  const ultrasonicIndicatesWater = depthCm > heightCm + FLOAT_AGREEMENT_TOLERANCE_CM;

  if (ultrasonicIndicatesWater === floatIndicatesWater) {
    return {
      status: 'AGREE',
      tagClass: 'tag-normal',
      label: 'Sensors Agree',
      detail: ultrasonicIndicatesWater
        ? `Both sensors indicate water at or above ${heightCm.toFixed(2)} cm (Ultrasonic: ${depthCm.toFixed(2)} cm, Float: ${floatState.state}).`
        : `Both sensors indicate water below ${heightCm.toFixed(2)} cm (Ultrasonic: ${depthCm.toFixed(2)} cm, Float: ${floatState.state}).`
    };
  }

  return {
    status: 'DISAGREE',
    tagClass: 'tag-warn',
    label: 'Sensor Disagreement',
    detail: ultrasonicIndicatesWater
      ? `Ultrasonic depth (${depthCm.toFixed(2)} cm) is above ${heightCm.toFixed(2)} cm, but float switch reports ${floatState.state} (expected ${floatState.closedMeansWater ? 'CLOSED' : 'OPEN'}). Check float mounting, polarity, or ultrasonic alignment.`
      : `Ultrasonic depth (${depthCm.toFixed(2)} cm) is below ${heightCm.toFixed(2)} cm, while float switch reports ${floatState.state} (indicating water contact). Inspect float switch or ultrasonic calibration.`
  };
}
