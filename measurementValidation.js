/**
 * ============================================================================
 * NYC FloodGuard 2.0 — Independent Measurement Validation (Ruler vs. Sensor)
 * File: measurementValidation.js
 *
 * Allows recording manual ruler-measured water depth (cm) alongside the active
 * HC-SR04 ultrasonic sensor reading to compute absolute error, bias, MAE, and
 * maximum error across repeated trials.
 *
 * Scientific Honesty Guarantees:
 *   - Never fabricates sensor measurements.
 *   - Reports "Not Scientifically Validated" until actual LIVE ruler comparisons
 *     are recorded.
 *   - Strictly separates LIVE hardware comparisons from SIMULATED demo runs.
 * ============================================================================
 */

export function createInitialValidationState() {
  return {
    entries: [] // newest first: { id, timestampMs, sourceMode, rulerCm, sensorCm, signedErrorCm, absErrorCm, note }
  };
}

/**
 * Adds a ruler-vs-sensor comparison entry.
 * Both rulerCm and sensorCm must be finite, non-negative numbers.
 */
export function addValidationComparison(state, { rulerCm, sensorCm, sourceMode = 'LIVE', note = '', timestampMs = Date.now() }) {
  const r = Number(rulerCm);
  const s = Number(sensorCm);
  if (!Number.isFinite(r) || r < 0 || r > 200) {
    return { ok: false, error: 'Enter a valid ruler-measured water depth between 0.00 and 200.00 cm.' };
  }
  if (!Number.isFinite(s) || s < 0 || s > 200) {
    return { ok: false, error: 'A valid live ultrasonic sensor depth reading is required for comparison.' };
  }

  const signedErrorCm = Number((s - r).toFixed(2));
  const absErrorCm = Number(Math.abs(s - r).toFixed(2));

  const entry = {
    id: `${timestampMs}-${Math.random().toString(36).slice(2, 7)}`,
    timestampMs,
    sourceMode: sourceMode === 'LIVE' ? 'LIVE' : 'SIMULATED',
    rulerCm: Number(r.toFixed(2)),
    sensorCm: Number(s.toFixed(2)),
    signedErrorCm,
    absErrorCm,
    note: String(note || '').trim().slice(0, 120)
  };

  state.entries.unshift(entry);
  if (state.entries.length > 100) {
    state.entries = state.entries.slice(0, 100);
  }

  return { ok: true, entry };
}

/**
 * Summarizes empirical validation accuracy using LIVE hardware comparisons only.
 */
export function summarizeValidationResults(entries = []) {
  const all = Array.isArray(entries) ? entries : [];
  const liveEntries = all.filter((e) => e.sourceMode === 'LIVE');
  const count = liveEntries.length;

  if (count === 0) {
    return {
      totalEntries: all.length,
      liveCount: 0,
      maeCm: null,
      maxAbsErrorCm: null,
      meanBiasCm: null,
      statusTagClass: 'tag-neutral',
      statusLabel: 'Not Scientifically Validated',
      summaryNote:
        'No live ruler-vs-sensor comparisons recorded yet. Enter physical millimeter-ruler measurements during LIVE Arduino operation to measure empirical error.'
    };
  }

  let sumAbs = 0;
  let sumSigned = 0;
  let maxAbs = 0;

  for (const e of liveEntries) {
    sumAbs += e.absErrorCm;
    sumSigned += e.signedErrorCm;
    if (e.absErrorCm > maxAbs) maxAbs = e.absErrorCm;
  }

  const maeCm = Number((sumAbs / count).toFixed(2));
  const meanBiasCm = Number((sumSigned / count).toFixed(2));
  const maxAbsErrorCm = Number(maxAbs.toFixed(2));

  if (count < 5) {
    return {
      totalEntries: all.length,
      liveCount: count,
      maeCm,
      maxAbsErrorCm,
      meanBiasCm,
      statusTagClass: 'tag-warn',
      statusLabel: `Preliminary (${count}/5 LIVE trials)`,
      summaryNote: `Preliminary MAE: ±${maeCm.toFixed(2)} cm across ${count} live trial${count === 1 ? '' : 's'} (max error ${maxAbsErrorCm.toFixed(2)} cm). Record at least 5 ruler comparisons across dry, rising, and calm/rippled water before drawing accuracy conclusions.`
    };
  }

  return {
    totalEntries: all.length,
    liveCount: count,
    maeCm,
    maxAbsErrorCm,
    meanBiasCm,
    statusTagClass: maeCm <= 0.30 ? 'tag-normal' : 'tag-warn',
    statusLabel: `Benchmarked (${count} LIVE trials)`,
    summaryNote: `Observed tabletop error across ${count} live ruler comparisons: Mean Absolute Error ±${maeCm.toFixed(2)} cm, Max Error ${maxAbsErrorCm.toFixed(2)} cm, Mean Bias ${meanBiasCm >= 0 ? '+' : ''}${meanBiasCm.toFixed(2)} cm (tabletop prototype trials only — not outdoor certification).`
  };
}
