/**
 * ============================================================================
 * NYC FloodGuard 2.0 — Presentation Test Session Recorder & CSV Exporter
 * File: sessionRecorder.js
 *
 * Captures timestamped sensor readings, min/max water depths, flood status
 * transitions, exact time spent in each flood status, and post-pump recovery
 * duration for classroom demonstrations and CSV export.
 * ============================================================================
 */

function escapeCsvCell(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function formatDurationSeconds(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0.0 s';
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)} s`;
  const mins = Math.floor(totalSeconds / 60);
  const rem = totalSeconds - mins * 60;
  return `${mins}m ${rem.toFixed(0).padStart(2, '0')}s`;
}

export function formatClockTimer(ms) {
  const totalSec = Math.max(0, Math.floor((ms || 0) / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function normalizeStatusBucket(status) {
  const s = String(status || '').toUpperCase();
  if (s === 'NORMAL') return 'NORMAL';
  if (s === 'WARNING') return 'WARNING';
  if (s === 'CRITICAL') return 'CRITICAL';
  if (s === 'OUT_OF_RANGE') return 'OUT_OF_RANGE';
  return 'OFFLINE';
}

export class TestSessionRecorder {
  constructor() {
    this.reset();
  }

  reset() {
    this.recording = false;
    this.startedAtMs = null;
    this.stoppedAtMs = null;
    this.sourceMode = null;
    this.samples = [];
    this.transitions = [];
    this.pumpStoppedAtMs = null;
    this.pumpStoppedDepthCm = null;
    this.lastStatus = null;
    this.lastStatusChangeMs = null;
    this.statusDurationsMs = {
      NORMAL: 0,
      WARNING: 0,
      CRITICAL: 0,
      OUT_OF_RANGE: 0,
      OFFLINE: 0
    };
  }

  start({ sourceMode = 'UNAVAILABLE', nowMs = Date.now(), initialStatus = null } = {}) {
    this.reset();
    this.recording = true;
    this.startedAtMs = nowMs;
    this.sourceMode = sourceMode;
    if (initialStatus) {
      const bucket = normalizeStatusBucket(initialStatus);
      this.lastStatus = bucket;
      this.lastStatusChangeMs = nowMs;
    }
  }

  stop(nowMs = Date.now()) {
    if (!this.recording) return this.getSummary(nowMs);
    this._accumulateTimeUntil(nowMs);
    this.recording = false;
    this.stoppedAtMs = nowMs;
    return this.getSummary(nowMs);
  }

  _accumulateTimeUntil(nowMs) {
    if (!this.lastStatus || !this.lastStatusChangeMs) return;
    const delta = Math.max(0, nowMs - this.lastStatusChangeMs);
    if (Object.prototype.hasOwnProperty.call(this.statusDurationsMs, this.lastStatus)) {
      this.statusDurationsMs[this.lastStatus] += delta;
    } else {
      this.statusDurationsMs.OFFLINE += delta;
    }
    this.lastStatusChangeMs = nowMs;
  }

  markPumpStopped({ nowMs = Date.now(), currentDepthCm = null } = {}) {
    if (!this.recording) return false;
    this.pumpStoppedAtMs = nowMs;
    this.pumpStoppedDepthCm = Number.isFinite(currentDepthCm) ? Number(currentDepthCm.toFixed(2)) : null;
    this.transitions.push({
      timestampMs: nowMs,
      timestampIso: new Date(nowMs).toISOString(),
      eventType: 'PUMP_STOPPED',
      fromStatus: this.lastStatus || 'UNKNOWN',
      toStatus: this.lastStatus || 'UNKNOWN',
      depthCm: this.pumpStoppedDepthCm,
      note: 'Presenter marked Pump 2 stopped — monitoring drainage recovery'
    });
    return true;
  }

  recordEvent({
    timestampMs = Date.now(),
    eventType = 'STATUS_CHANGE',
    fromStatus = null,
    toStatus = 'OFFLINE',
    depthCm = null,
    note = ''
  }) {
    if (!this.recording) return;
    const bucket = normalizeStatusBucket(toStatus);
    if (this.lastStatus && this.lastStatusChangeMs) {
      this._accumulateTimeUntil(timestampMs);
    } else {
      this.lastStatusChangeMs = timestampMs;
    }
    const prev = fromStatus || this.lastStatus || 'START';
    this.lastStatus = bucket;
    this.lastStatusChangeMs = timestampMs;

    this.transitions.push({
      timestampMs,
      timestampIso: new Date(timestampMs).toISOString(),
      eventType,
      fromStatus: prev,
      toStatus: String(toStatus || bucket),
      depthCm: Number.isFinite(depthCm) ? Number(depthCm.toFixed(2)) : null,
      note
    });
  }

  recordSample({
    timestampMs = Date.now(),
    sourceMode = 'LIVE',
    status = 'UNAVAILABLE',
    depthCm = null,
    distanceCm = null,
    baselineCm = null,
    trend = 'UNAVAILABLE',
    rateCmPerMin = null,
    sensorQuality = 'UNAVAILABLE',
    suspicious = false,
    suspiciousReason = '',
    rawLine = ''
  }) {
    if (!this.recording) return;
    if (!this.startedAtMs) this.startedAtMs = timestampMs;
    if (!this.sourceMode || this.sourceMode === 'UNAVAILABLE') {
      this.sourceMode = sourceMode;
    }

    const bucket = normalizeStatusBucket(status);
    if (this.lastStatus && this.lastStatusChangeMs) {
      this._accumulateTimeUntil(timestampMs);
    } else {
      this.lastStatusChangeMs = timestampMs;
    }

    if (this.lastStatus !== bucket) {
      const prev = this.lastStatus || 'START';
      this.transitions.push({
        timestampMs,
        timestampIso: new Date(timestampMs).toISOString(),
        eventType: 'STATUS_CHANGE',
        fromStatus: prev,
        toStatus: String(status),
        depthCm: Number.isFinite(depthCm) ? Number(depthCm.toFixed(2)) : null,
        note: ''
      });
      this.lastStatus = bucket;
      this.lastStatusChangeMs = timestampMs;
    }

    const elapsedSec = Number(((timestampMs - this.startedAtMs) / 1000).toFixed(2));
    this.samples.push({
      timestampMs,
      timestampIso: new Date(timestampMs).toISOString(),
      elapsedSec,
      sourceMode,
      status: String(status),
      depthCm: Number.isFinite(depthCm) ? Number(depthCm.toFixed(2)) : null,
      distanceCm: Number.isFinite(distanceCm) ? Number(distanceCm.toFixed(2)) : null,
      baselineCm: Number.isFinite(baselineCm) ? Number(baselineCm.toFixed(2)) : null,
      trend: String(trend || 'UNAVAILABLE'),
      rateCmPerMin: Number.isFinite(rateCmPerMin) ? Number(rateCmPerMin.toFixed(3)) : null,
      sensorQuality: String(sensorQuality || 'UNAVAILABLE'),
      suspicious: Boolean(suspicious),
      suspiciousReason: String(suspiciousReason || ''),
      rawLine: String(rawLine || '')
    });
  }

  getSummary(nowMs = Date.now()) {
    const endMs = this.recording ? nowMs : this.stoppedAtMs || nowMs;
    const durationMs = this.startedAtMs ? Math.max(0, endMs - this.startedAtMs) : 0;

    // Include ongoing time in current status without mutating stored totals
    const durationsMs = { ...this.statusDurationsMs };
    if (this.recording && this.lastStatus && this.lastStatusChangeMs) {
      const extra = Math.max(0, endMs - this.lastStatusChangeMs);
      if (Object.prototype.hasOwnProperty.call(durationsMs, this.lastStatus)) {
        durationsMs[this.lastStatus] += extra;
      } else {
        durationsMs.OFFLINE += extra;
      }
    }

    const validDepthSamples = this.samples.filter((s) => s.depthCm != null);
    let minDepthCm = null;
    let minDepthAtMs = null;
    let maxDepthCm = null;
    let maxDepthAtMs = null;

    for (const s of validDepthSamples) {
      if (minDepthCm === null || s.depthCm < minDepthCm) {
        minDepthCm = s.depthCm;
        minDepthAtMs = s.timestampMs;
      }
      if (maxDepthCm === null || s.depthCm > maxDepthCm) {
        maxDepthCm = s.depthCm;
        maxDepthAtMs = s.timestampMs;
      }
    }

    const suspiciousCount = this.samples.filter((s) => s.suspicious).length;
    const statusTransitions = this.transitions.filter((t) => t.eventType === 'STATUS_CHANGE');

    // Compute recovery after peak flooding (or after explicit "Pump Stopped" marker)
    let recoveryFromPeakSec = null;
    let recoveredFromPeak = false;
    let recoveryReturnAtMs = null;
    const reachedElevatedFlood = this.samples.some(
      (s) => s.status === 'WARNING' || s.status === 'CRITICAL'
    );

    if (reachedElevatedFlood && maxDepthAtMs != null) {
      const recoverySample = this.samples.find(
        (s) => s.timestampMs > maxDepthAtMs && s.status === 'NORMAL'
      );
      if (recoverySample) {
        recoveredFromPeak = true;
        recoveryReturnAtMs = recoverySample.timestampMs;
        recoveryFromPeakSec = Number(((recoverySample.timestampMs - maxDepthAtMs) / 1000).toFixed(1));
      }
    }

    let recoveryAfterPumpStopSec = null;
    let recoveredAfterPumpStop = false;
    if (this.pumpStoppedAtMs != null) {
      const postPumpNormal = this.samples.find(
        (s) => s.timestampMs >= this.pumpStoppedAtMs && s.status === 'NORMAL'
      );
      if (postPumpNormal) {
        recoveredAfterPumpStop = true;
        recoveryAfterPumpStopSec = Number(
          ((postPumpNormal.timestampMs - this.pumpStoppedAtMs) / 1000).toFixed(1)
        );
      }
    }

    let recoverySummaryText = 'No flood peak recorded yet.';
    if (this.pumpStoppedAtMs != null) {
      if (recoveredAfterPumpStop) {
        recoverySummaryText = `Recovered to NORMAL in ${formatDurationSeconds(recoveryAfterPumpStopSec)} after Pump 2 stopped${maxDepthCm != null ? ` (peak ${maxDepthCm.toFixed(2)} cm)` : ''}.`;
      } else {
        recoverySummaryText = `Pump 2 stopped at ${new Date(this.pumpStoppedAtMs).toLocaleTimeString()} — water has not returned to NORMAL yet.`;
      }
    } else if (reachedElevatedFlood) {
      if (recoveredFromPeak) {
        recoverySummaryText = `Recovered from ${maxDepthCm.toFixed(2)} cm peak back to NORMAL in ${formatDurationSeconds(recoveryFromPeakSec)}.`;
      } else {
        recoverySummaryText = `Flood alert reached (peak ${maxDepthCm != null ? maxDepthCm.toFixed(2) : '--'} cm) — awaiting return to NORMAL drainage.`;
      }
    } else if (validDepthSamples.length > 0) {
      recoverySummaryText = 'Roadway remained in NORMAL drainage throughout the session.';
    }

    const statusSeconds = {
      NORMAL: Number((durationsMs.NORMAL / 1000).toFixed(1)),
      WARNING: Number((durationsMs.WARNING / 1000).toFixed(1)),
      CRITICAL: Number((durationsMs.CRITICAL / 1000).toFixed(1)),
      OUT_OF_RANGE: Number((durationsMs.OUT_OF_RANGE / 1000).toFixed(1)),
      OFFLINE: Number((durationsMs.OFFLINE / 1000).toFixed(1))
    };

    const classroomHighlights = [];
    if (this.startedAtMs) {
      classroomHighlights.push(
        `Session Mode: ${this.sourceMode === 'LIVE' ? 'LIVE Arduino GIGA R1 WiFi (USB Serial)' : this.sourceMode === 'SIMULATED' ? 'DEMO MODE (Simulated)' : 'No Active Sensor'} · Duration: ${formatDurationSeconds(durationMs / 1000)} (${this.samples.length} readings).`
      );
      if (minDepthCm != null && maxDepthCm != null) {
        classroomHighlights.push(
          `Observed Water Depth Range: Min ${minDepthCm.toFixed(2)} cm → Peak ${maxDepthCm.toFixed(2)} cm.`
        );
      }
      classroomHighlights.push(
        `Time by Status: NORMAL ${formatDurationSeconds(statusSeconds.NORMAL)} · WARNING ${formatDurationSeconds(statusSeconds.WARNING)} · CRITICAL ${formatDurationSeconds(statusSeconds.CRITICAL)}${statusSeconds.OFFLINE > 0 ? ` · OFFLINE/STALE ${formatDurationSeconds(statusSeconds.OFFLINE)}` : ''}.`
      );
      classroomHighlights.push(
        `Alert Transitions Logged: ${statusTransitions.length}${suspiciousCount > 0 ? ` (${suspiciousCount} suspicious readings flagged)` : ' (0 suspicious readings flagged)'}.`
      );
      classroomHighlights.push(`Drainage Recovery: ${recoverySummaryText}`);
    }

    return {
      recording: this.recording,
      hasData: this.samples.length > 0 || this.transitions.length > 0,
      startedAtMs: this.startedAtMs,
      stoppedAtMs: this.stoppedAtMs,
      durationMs,
      durationSec: Number((durationMs / 1000).toFixed(1)),
      sourceMode: this.sourceMode || 'UNAVAILABLE',
      sampleCount: this.samples.length,
      minDepthCm,
      minDepthAtMs,
      maxDepthCm,
      maxDepthAtMs,
      statusSeconds,
      transitions: [...this.transitions],
      statusTransitionCount: statusTransitions.length,
      suspiciousCount,
      pumpStoppedAtMs: this.pumpStoppedAtMs,
      recoveredFromPeak,
      recoveryFromPeakSec,
      recoveryReturnAtMs,
      recoveredAfterPumpStop,
      recoveryAfterPumpStopSec,
      recoverySummaryText,
      classroomHighlights
    };
  }

  toCsv(nowMs = Date.now()) {
    const summary = this.getSummary(nowMs);
    const lines = [];

    lines.push('# NYC FloodGuard 2.0 — Test Session Export');
    lines.push(`# Started,${escapeCsvCell(summary.startedAtMs ? new Date(summary.startedAtMs).toISOString() : '')}`);
    lines.push(`# Ended,${escapeCsvCell(summary.stoppedAtMs ? new Date(summary.stoppedAtMs).toISOString() : new Date(nowMs).toISOString())}`);
    lines.push(`# Source Mode,${escapeCsvCell(summary.sourceMode)}`);
    lines.push(`# Duration (sec),${summary.durationSec}`);
    lines.push(`# Total Samples,${summary.sampleCount}`);
    lines.push(`# Min Depth (cm),${summary.minDepthCm != null ? summary.minDepthCm.toFixed(2) : ''}`);
    lines.push(`# Max Depth (cm),${summary.maxDepthCm != null ? summary.maxDepthCm.toFixed(2) : ''}`);
    lines.push(`# Time NORMAL (sec),${summary.statusSeconds.NORMAL}`);
    lines.push(`# Time WARNING (sec),${summary.statusSeconds.WARNING}`);
    lines.push(`# Time CRITICAL (sec),${summary.statusSeconds.CRITICAL}`);
    lines.push(`# Time OUT_OF_RANGE (sec),${summary.statusSeconds.OUT_OF_RANGE}`);
    lines.push(`# Time OFFLINE_OR_STALE (sec),${summary.statusSeconds.OFFLINE}`);
    lines.push(`# Status Transitions,${summary.statusTransitionCount}`);
    lines.push(`# Suspicious Readings Flagged,${summary.suspiciousCount}`);
    lines.push(`# Recovery Summary,${escapeCsvCell(summary.recoverySummaryText)}`);
    lines.push('');

    // Status transitions table
    lines.push('# Status Transitions & Session Events');
    lines.push('event_timestamp_iso,event_type,from_status,to_status,water_depth_cm,note');
    for (const tr of summary.transitions) {
      lines.push(
        [
          escapeCsvCell(tr.timestampIso),
          escapeCsvCell(tr.eventType),
          escapeCsvCell(tr.fromStatus),
          escapeCsvCell(tr.toStatus),
          tr.depthCm != null ? tr.depthCm.toFixed(2) : '',
          escapeCsvCell(tr.note)
        ].join(',')
      );
    }

    lines.push('');
    lines.push('# Timestamped Sensor Readings');
    lines.push(
      [
        'timestamp_iso',
        'elapsed_sec',
        'source_mode',
        'status',
        'water_depth_cm',
        'sensor_distance_cm',
        'calibrated_baseline_cm',
        'trend',
        'rate_cm_per_min',
        'sensor_quality',
        'suspicious_flag',
        'suspicious_reason',
        'raw_serial_line'
      ].join(',')
    );

    for (const row of this.samples) {
      lines.push(
        [
          escapeCsvCell(row.timestampIso),
          row.elapsedSec.toFixed(2),
          escapeCsvCell(row.sourceMode),
          escapeCsvCell(row.status),
          row.depthCm != null ? row.depthCm.toFixed(2) : '',
          row.distanceCm != null ? row.distanceCm.toFixed(2) : '',
          row.baselineCm != null ? row.baselineCm.toFixed(2) : '',
          escapeCsvCell(row.trend),
          row.rateCmPerMin != null ? row.rateCmPerMin.toFixed(3) : '',
          escapeCsvCell(row.sensorQuality),
          row.suspicious ? 'YES' : 'NO',
          escapeCsvCell(row.suspiciousReason),
          escapeCsvCell(row.rawLine)
        ].join(',')
      );
    }

    return lines.join('\n') + '\n';
  }
}
