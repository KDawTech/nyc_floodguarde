/**
 * ============================================================================
 * NYC FloodGuard 2.0 — Hardware Integrity, Mount Stability, Local Alarm Mode
 *                      & Calibration Protection State Engine
 * File: hardwareSafety.js
 *
 * Pure, deterministic state logic for the four mounted prototype components:
 *   1. HC-SR04 ultrasonic water-level sensor
 *   2. ADXL345 3-axis accelerometer (mount stability & movement detection)
 *   3. Active buzzer (commanded local audio patterns)
 *   4. RGB LED (commanded local visual status patterns)
 *
 * Core Safety Guarantees:
 *   - Never display a sensor error as 0.00 cm water depth or NORMAL status.
 *   - Pause flood predictions and reset the prediction window on sensor faults,
 *     mount movement, recalibration requests, or calibration events.
 *   - Preserve any previously confirmed CRITICAL flood alarm during sensor faults.
 *   - Resume normal monitoring only after calibration succeeds AND fresh valid
 *     telemetry arrives.
 *   - Clearly distinguish Arduino-commanded alarm modes from independently
 *     verified physical LED illumination and buzzer sound.
 * ============================================================================
 */

export const ALARM_MODE_SPECS = Object.freeze({
  NORMAL: Object.freeze({
    code: 'NORMAL',
    label: 'NORMAL',
    ledLabel: 'Green LED',
    ledColor: 'green',
    ledFlashing: false,
    buzzerLabel: 'Silent buzzer',
    summary: 'Green LED, silent buzzer',
    severity: 'normal'
  }),
  WARNING: Object.freeze({
    code: 'WARNING',
    label: 'WARNING',
    ledLabel: 'Yellow LED',
    ledColor: 'yellow',
    ledFlashing: false,
    buzzerLabel: '1-second intermittent buzzer',
    summary: 'Yellow LED, one-second intermittent buzzer',
    severity: 'warning'
  }),
  CRITICAL: Object.freeze({
    code: 'CRITICAL',
    label: 'CRITICAL',
    ledLabel: 'Red LED',
    ledColor: 'red',
    ledFlashing: false,
    buzzerLabel: 'Continuous buzzer',
    summary: 'Red LED, continuous buzzer',
    severity: 'critical'
  }),
  SENSOR_FAULT: Object.freeze({
    code: 'SENSOR_FAULT',
    label: 'SENSOR FAULT',
    ledLabel: 'Flashing Blue LED',
    ledColor: 'blue',
    ledFlashing: true,
    buzzerLabel: 'Fault alarm (unless Critical active)',
    summary: 'Flashing blue LED and fault alarm (unless a previously confirmed CRITICAL alarm remains active)',
    severity: 'fault'
  }),
  CALIBRATING: Object.freeze({
    code: 'CALIBRATING',
    label: 'CALIBRATING',
    ledLabel: 'Blue LED',
    ledColor: 'blue',
    ledFlashing: false,
    buzzerLabel: 'Silent buzzer',
    summary: 'Blue LED, silent buzzer',
    severity: 'calibrating'
  })
});

export const MOUNT_STATUS_SPECS = Object.freeze({
  STABLE: Object.freeze({
    code: 'STABLE',
    label: 'STABLE',
    tone: 'normal',
    description: 'ADXL345 reports a stationary sensor mount.'
  }),
  MOVEMENT_DETECTED: Object.freeze({
    code: 'MOVEMENT_DETECTED',
    label: 'MOVEMENT DETECTED',
    tone: 'warning',
    description: 'ADXL345 detected mount vibration or movement — current depth readings marked invalid and predictions paused.'
  }),
  RECALIBRATION_REQUIRED: Object.freeze({
    code: 'RECALIBRATION_REQUIRED',
    label: 'RECALIBRATION REQUIRED',
    tone: 'critical',
    description: 'Mount shifted — dry-road baseline may be stale. Predictions paused until confirmed dry-road and stationary recalibration succeeds.'
  }),
  UNAVAILABLE: Object.freeze({
    code: 'UNAVAILABLE',
    label: 'UNAVAILABLE',
    tone: 'warning',
    description: 'ADXL345 accelerometer reported unavailable — mount stability cannot be verified.'
  })
});

export function getAlarmModeSpec(mode) {
  if (!mode) return null;
  const key = String(mode).trim().toUpperCase();
  return ALARM_MODE_SPECS[key] || null;
}

export function getMountStatusSpec(status) {
  if (!status) return null;
  const key = String(status).trim().toUpperCase();
  return MOUNT_STATUS_SPECS[key] || null;
}

export function createInitialHardwareSafetyState() {
  return {
    // ADXL345 mount stability telemetry (null when not reported by older firmware)
    mountStatus: null, // null | 'STABLE' | 'MOVEMENT_DETECTED' | 'RECALIBRATION_REQUIRED' | 'UNAVAILABLE'
    mountDeviationG: null,
    mountLastUpdatedMs: null,
    mountReportedByFirmware: false,

    // Arduino-commanded local RGB LED + active buzzer alarm mode
    alarmMode: null, // null | 'NORMAL' | 'WARNING' | 'CRITICAL' | 'SENSOR_FAULT' | 'CALIBRATING'
    alarmLastUpdatedMs: null,
    alarmReportedByFirmware: false,

    // Fault & calibration protection flags
    sensorErrorActive: false,
    sensorErrorReason: '',
    sensorErrorAtMs: null,

    calibrationInProgress: false,
    calibrationRequired: false,
    calibrationFailed: false,
    calibrationFailedAtMs: null,
    adxlCalibratedAtMs: null,
    calibrationCompletedAtMs: null,
    awaitingFreshValidTelemetry: false,
    lastCalibrationNote: '',

    // Previously confirmed CRITICAL flood latch (preserved during sensor faults)
    confirmedCritical: {
      active: false,
      depthCm: null,
      confirmedAtMs: null,
      preservedDuringFault: false
    }
  };
}

/**
 * Evaluates whether live ultrasonic measurements and predictions must be marked
 * invalid/stale and paused based on the current hardware safety state.
 */
export function evaluateHardwareProtection(safety) {
  const s = safety || createInitialHardwareSafetyState();

  const isCalibrationFailed = s.calibrationFailed && !s.calibrationInProgress;
  const isCalibrating = s.calibrationInProgress || (s.alarmMode === 'CALIBRATING' && !s.calibrationFailed);
  const isRecalibRequired = s.calibrationRequired || s.mountStatus === 'RECALIBRATION_REQUIRED';
  const isMountMoved = s.mountStatus === 'MOVEMENT_DETECTED';
  const isSensorFault = s.sensorErrorActive || s.alarmMode === 'SENSOR_FAULT';
  const isAwaitingFresh = s.awaitingFreshValidTelemetry;
  const isMountUnavailable = s.mountStatus === 'UNAVAILABLE';

  let blockCode = null;
  let blockTitle = '';
  let blockReason = '';
  let statusDisplay = null;
  let tone = 'normal';

  if (isCalibrating) {
    blockCode = 'CALIBRATING';
    statusDisplay = 'CALIBRATING';
    tone = 'info';
    blockTitle = 'CALIBRATING — PREDICTIONS PAUSED';
    blockReason = s.adxlCalibratedAtMs
      ? 'ADXL345 calibrated; waiting for Arduino dry-road baseline completion and fresh valid telemetry.'
      : 'Arduino is calibrating the ADXL345 mount reference and dry-road baseline. Keep roadway dry and mount stationary.';
  } else if (isCalibrationFailed) {
    blockCode = 'CALIBRATION_FAILED';
    statusDisplay = 'CALIBRATION FAILED';
    tone = 'critical';
    blockTitle = 'CALIBRATION FAILED — MEASUREMENTS INVALID';
    blockReason =
      'Arduino reported CALIBRATION FAILED. Existing measurements are marked invalid and predictions remain paused until dry-road, stationary recalibration succeeds.';
  } else if (isRecalibRequired) {
    blockCode = 'RECALIBRATION_REQUIRED';
    statusDisplay = 'RECALIBRATION REQUIRED';
    tone = 'critical';
    blockTitle = 'MOUNT SHIFTED — RECALIBRATION REQUIRED';
    blockReason =
      'ADXL345 flagged RECALIBRATION_REQUIRED. Baseline may be stale; measurements are marked invalid and predictions are paused until confirmed dry-road and stationary recalibration succeeds.';
  } else if (isSensorFault) {
    blockCode = 'SENSOR_FAULT';
    statusDisplay = 'SENSOR FAULT';
    tone = 'critical';
    blockTitle = 'SENSOR FAULT — INVALID MEASUREMENT';
    blockReason =
      s.sensorErrorReason ||
      'Arduino reported a sensor fault (SENSOR ERROR / SENSOR_FAULT). Never displayed as 0.00 cm or NORMAL; predictions paused until fresh valid telemetry arrives.';
  } else if (isMountMoved) {
    blockCode = 'MOVEMENT_DETECTED';
    statusDisplay = 'MOUNT MOVED';
    tone = 'warning';
    blockTitle = 'MOUNT MOVEMENT DETECTED — PREDICTIONS PAUSED';
    blockReason =
      s.mountDeviationG != null
        ? `ADXL345 detected ${s.mountDeviationG.toFixed(3)} g deviation. Ultrasonic readings are marked invalid and predictions paused until mount stabilizes.`
        : 'ADXL345 detected mount movement. Ultrasonic readings are marked invalid and predictions paused.';
  } else if (isAwaitingFresh) {
    blockCode = 'AWAITING_FRESH_TELEMETRY';
    statusDisplay = 'AWAITING FRESH DATA';
    tone = 'info';
    blockTitle = 'CALIBRATION COMPLETE — AWAITING FRESH TELEMETRY';
    blockReason =
      'Calibration completed and the prediction window was reset. Monitoring and predictions will resume automatically once fresh valid ultrasonic telemetry arrives.';
  }

  const measurementsInvalid = Boolean(blockCode);
  const predictionsPaused = measurementsInvalid;
  const preservedCriticalActive = Boolean(
    s.confirmedCritical?.active && (measurementsInvalid || s.confirmedCritical?.preservedDuringFault)
  );

  return {
    measurementsInvalid,
    predictionsPaused,
    blockCode,
    statusDisplay,
    tone,
    blockTitle,
    blockReason,
    mountUnavailable: isMountUnavailable,
    preservedCriticalActive,
    preservedCriticalDepthCm: preservedCriticalActive ? s.confirmedCritical.depthCm : null,
    preservedCriticalAtMs: preservedCriticalActive ? s.confirmedCritical.confirmedAtMs : null
  };
}

/**
 * Applies an incoming parsed serial packet to `safety` (mutates `safety` cleanly)
 * and returns action flags for the controller:
 *   - resetPredictionWindow: clear rolling sample buffer to prevent blending stale/pre-calibration points
 *   - eventLog: optional { status, note } to record in Alert History
 *   - toast: optional { message, level }
 */
export function applyPacketToHardwareSafety(safety, packet) {
  const nowMs = packet?.receivedAtMs || Date.now();
  const result = {
    resetPredictionWindow: false,
    eventLog: null,
    toast: null,
    resumedFromHold: false
  };

  if (!packet || !safety) return result;

  // 1. Standalone SENSOR ERROR line
  if (packet.format === 'sensor_error') {
    const wasFault = safety.sensorErrorActive;
    safety.sensorErrorActive = true;
    safety.sensorErrorReason =
      packet.rawLine
        ? `Arduino reported "${packet.rawLine}" — ultrasonic measurement invalid (not 0.00 cm or NORMAL).`
        : 'Arduino reported SENSOR ERROR — ultrasonic measurement invalid.';
    safety.sensorErrorAtMs = nowMs;
    if (safety.confirmedCritical.active) {
      safety.confirmedCritical.preservedDuringFault = true;
    }
    result.resetPredictionWindow = true;
    if (!wasFault) {
      result.eventLog = {
        status: 'SENSOR_FAULT',
        note: safety.confirmedCritical.active
          ? `SENSOR ERROR received — previously confirmed CRITICAL alarm preserved`
          : `SENSOR ERROR received — predictions paused`
      };
      result.toast = {
        message: safety.confirmedCritical.active
          ? 'SENSOR ERROR received — predictions paused, previously confirmed CRITICAL alert preserved.'
          : 'Arduino reported SENSOR ERROR — measurement marked invalid and predictions paused.',
        level: 'CRITICAL'
      };
    }
    return result;
  }

  // 2. Mount Status line (ADXL345)
  if (packet.format === 'mount_status') {
    const prevMount = safety.mountStatus;
    safety.mountStatus = packet.mountStatus;
    safety.mountDeviationG = packet.deviationG;
    safety.mountLastUpdatedMs = nowMs;
    safety.mountReportedByFirmware = true;

    if (packet.mountStatus === 'RECALIBRATION_REQUIRED') {
      safety.calibrationRequired = true;
      safety.calibrationCompletedAtMs = null;
      if (safety.confirmedCritical.active) {
        safety.confirmedCritical.preservedDuringFault = true;
      }
      result.resetPredictionWindow = true;
      if (prevMount !== 'RECALIBRATION_REQUIRED') {
        const devStr = packet.deviationG != null ? ` (${packet.deviationG.toFixed(3)} g)` : '';
        result.eventLog = {
          status: 'RECALIBRATION_REQUIRED',
          note: `ADXL345 Mount Status: RECALIBRATION_REQUIRED${devStr} — predictions paused`
        };
        result.toast = {
          message: 'Mount recalibration required — confirm dry roadway and stationary mount, then send "c".',
          level: 'CRITICAL'
        };
      }
    } else if (packet.mountStatus === 'MOVEMENT_DETECTED') {
      if (safety.confirmedCritical.active) {
        safety.confirmedCritical.preservedDuringFault = true;
      }
      result.resetPredictionWindow = true;
      if (prevMount !== 'MOVEMENT_DETECTED') {
        const devStr = packet.deviationG != null ? ` (${packet.deviationG.toFixed(3)} g)` : '';
        result.eventLog = {
          status: 'MOUNT_MOVEMENT',
          note: `ADXL345 Mount Status: MOVEMENT_DETECTED${devStr} — predictions paused`
        };
        result.toast = {
          message: `Sensor mount movement detected${devStr} — predictions paused.`,
          level: 'WARNING'
        };
      }
    } else if (packet.mountStatus === 'UNAVAILABLE') {
      if (prevMount !== 'UNAVAILABLE') {
        result.eventLog = {
          status: 'MOUNT_UNAVAILABLE',
          note: 'ADXL345 accelerometer reported UNAVAILABLE — mount stability unverified'
        };
      }
    } else if (packet.mountStatus === 'STABLE') {
      // Returning to STABLE clears a transient movement hold (if recalibration isn't required),
      // while still requiring a fresh valid ultrasonic reading before predictions resume.
      if (prevMount === 'MOVEMENT_DETECTED' && !safety.calibrationRequired && !safety.calibrationFailed && !safety.calibrationInProgress) {
        safety.awaitingFreshValidTelemetry = true;
        result.resetPredictionWindow = true;
      }
    }
    return result;
  }

  // 3. Local Alarm Mode line (commanded RGB LED + active buzzer)
  if (packet.format === 'alarm_mode') {
    const prevAlarm = safety.alarmMode;
    safety.alarmMode = packet.alarmMode;
    safety.alarmLastUpdatedMs = nowMs;
    safety.alarmReportedByFirmware = true;

    if (packet.alarmMode === 'SENSOR_FAULT') {
      safety.sensorErrorActive = true;
      if (!safety.sensorErrorReason) {
        safety.sensorErrorReason =
          'Arduino commanded Alarm Mode: SENSOR_FAULT — measurements marked invalid and predictions paused.';
      }
      if (safety.confirmedCritical.active) {
        safety.confirmedCritical.preservedDuringFault = true;
      }
      result.resetPredictionWindow = true;
      if (prevAlarm !== 'SENSOR_FAULT') {
        result.eventLog = {
          status: 'SENSOR_FAULT',
          note: 'Arduino commanded Alarm Mode: SENSOR_FAULT (Flashing blue LED, 2 short beeps / 3s)'
        };
      }
    } else if (packet.alarmMode === 'CALIBRATING') {
      safety.calibrationInProgress = true;
      safety.calibrationFailed = false;
      safety.adxlCalibratedAtMs = null;
      safety.awaitingFreshValidTelemetry = true;
      result.resetPredictionWindow = true;
    } else if (packet.alarmMode === 'CRITICAL') {
      // Do not overwrite an active fault; if no fault is blocking, note critical alarm
      if (!safety.sensorErrorActive && !safety.calibrationRequired && !safety.calibrationInProgress && !safety.calibrationFailed) {
        safety.confirmedCritical.active = true;
        safety.confirmedCritical.confirmedAtMs = safety.confirmedCritical.confirmedAtMs || nowMs;
        safety.confirmedCritical.preservedDuringFault = false;
      }
    } else if (packet.alarmMode === 'NORMAL' || packet.alarmMode === 'WARNING') {
      // If no fault/calibration hold is active, keep confirmedCritical aligned with Arduino's Alarm Mode
      if (!safety.sensorErrorActive && !safety.calibrationRequired && !safety.calibrationInProgress && !safety.calibrationFailed) {
        safety.confirmedCritical = {
          active: false,
          depthCm: null,
          confirmedAtMs: null,
          preservedDuringFault: false
        };
      }
    }
    return result;
  }

  // 4. Calibration status messages
  if (packet.format === 'calibration') {
    result.resetPredictionWindow = true;

    if (packet.calibrationState === 'calibrating') {
      safety.calibrationInProgress = true;
      safety.calibrationFailed = false;
      safety.adxlCalibratedAtMs = null;
      safety.awaitingFreshValidTelemetry = true;
      safety.lastCalibrationNote = 'Arduino calibration started — keep roadway dry and mount stationary.';
    } else if (packet.calibrationState === 'adxl_complete') {
      safety.adxlCalibratedAtMs = nowMs;
      safety.lastCalibrationNote = 'ADXL345 calibration complete — awaiting dry-road baseline completion.';
    } else if (packet.calibrationState === 'failed') {
      safety.calibrationInProgress = false;
      safety.calibrationFailed = true;
      safety.calibrationRequired = true;
      safety.calibrationFailedAtMs = nowMs;
      safety.awaitingFreshValidTelemetry = true;
      safety.lastCalibrationNote = 'CALIBRATION FAILED — verify dry roadway and stationary mount, then retry.';
      if (safety.confirmedCritical.active) {
        safety.confirmedCritical.preservedDuringFault = true;
      }
      result.eventLog = {
        status: 'CALIBRATION_FAILED',
        note: 'Arduino reported CALIBRATION FAILED — predictions remain paused'
      };
      result.toast = {
        message: 'Calibration failed — keep mount completely still on a dry roadway and retry recalibration.',
        level: 'CRITICAL'
      };
    } else if (packet.calibrationState === 'complete' || packet.calibrationState === 'calibrated') {
      safety.calibrationInProgress = false;
      safety.calibrationRequired = false;
      safety.calibrationFailed = false;
      safety.sensorErrorActive = false;
      safety.sensorErrorReason = '';
      safety.calibrationCompletedAtMs = nowMs;
      safety.awaitingFreshValidTelemetry = true;
      if (safety.mountStatus === 'RECALIBRATION_REQUIRED' || safety.mountStatus === 'MOVEMENT_DETECTED') {
        safety.mountStatus = 'STABLE';
      }
      if (safety.alarmMode === 'CALIBRATING' || safety.alarmMode === 'SENSOR_FAULT') {
        safety.alarmMode = 'NORMAL';
      }
      // Confirmed dry-road calibration clears any stale pre-calibration critical latch
      safety.confirmedCritical = {
        active: false,
        depthCm: null,
        confirmedAtMs: null,
        preservedDuringFault: false
      };
      safety.lastCalibrationNote = Number.isFinite(packet.baselineCm)
        ? `Calibration complete (dry baseline ${packet.baselineCm.toFixed(2)} cm) — awaiting fresh valid telemetry.`
        : 'Calibration complete — prediction window reset; awaiting fresh valid telemetry.';
      result.eventLog = {
        status: 'RECALIBRATED',
        note: safety.lastCalibrationNote
      };
      result.toast = {
        message: Number.isFinite(packet.baselineCm)
          ? `Calibration complete (${packet.baselineCm.toFixed(2)} cm). Waiting for fresh telemetry to resume.`
          : 'Calibration complete. Prediction window reset — waiting for fresh telemetry to resume.',
        level: 'NORMAL'
      };
    }
    return result;
  }

  // 5. Ultrasonic Telemetry Frame (text or json)
  if (packet.format === 'text' || packet.format === 'json') {
    const isErrorFrame =
      Boolean(packet.errorCode) ||
      packet.firmwareQuality === 'out_of_range' ||
      packet.reportedStatus === 'SENSOR_FAULT' ||
      packet.reportedStatus === 'SENSOR_ERROR';

    if (isErrorFrame) {
      safety.sensorErrorActive = true;
      safety.sensorErrorReason =
        packet.rawLine
          ? `Invalid ultrasonic frame (${packet.rawLine}) — not displayed as 0.00 cm or NORMAL.`
          : 'Invalid ultrasonic frame — predictions paused.';
      safety.sensorErrorAtMs = nowMs;
      if (safety.confirmedCritical.active) {
        safety.confirmedCritical.preservedDuringFault = true;
      }
      result.resetPredictionWindow = true;
      return result;
    }

    // Valid numeric ultrasonic frame received
    const hasValidNumericReading =
      Number.isFinite(packet.distanceCm) || Number.isFinite(packet.reportedDepthCm);

    if (!hasValidNumericReading) {
      return result;
    }

    // Cannot resume if calibration is still required, in progress, failed, or mount is currently moving
    if (
      safety.calibrationInProgress ||
      safety.calibrationFailed ||
      safety.calibrationRequired ||
      safety.mountStatus === 'RECALIBRATION_REQUIRED' ||
      safety.mountStatus === 'MOVEMENT_DETECTED'
    ) {
      return result;
    }

    // Fresh valid ultrasonic reading clears transient sensor error & post-calibration waiting hold
    if (safety.sensorErrorActive || safety.awaitingFreshValidTelemetry || safety.alarmMode === 'SENSOR_FAULT') {
      safety.sensorErrorActive = false;
      safety.sensorErrorReason = '';
      safety.awaitingFreshValidTelemetry = false;
      if (safety.alarmMode === 'SENSOR_FAULT') {
        safety.alarmMode = packet.reportedStatus || null;
      }
      result.resumedFromHold = true;
    }

    // Update confirmed CRITICAL latch based on fresh valid authoritative status
    if (packet.reportedStatus === 'CRITICAL') {
      safety.confirmedCritical = {
        active: true,
        depthCm: Number.isFinite(packet.reportedDepthCm) ? packet.reportedDepthCm : safety.confirmedCritical.depthCm,
        confirmedAtMs: nowMs,
        preservedDuringFault: false
      };
    } else if (packet.reportedStatus === 'NORMAL' || packet.reportedStatus === 'WARNING') {
      // Fresh valid non-critical telemetry clears a preserved critical latch
      safety.confirmedCritical = {
        active: false,
        depthCm: null,
        confirmedAtMs: null,
        preservedDuringFault: false
      };
    }
  }

  return result;
}

/**
 * Syncs confirmed CRITICAL latch after dashboard threshold analysis (useful for JSON
 * streams or older firmware where status is derived from thresholds rather than text Status).
 */
export function syncConfirmedCriticalFromAnalysis(safety, analysis, isLiveMode) {
  if (!safety || !isLiveMode || !analysis) return;
  const protection = evaluateHardwareProtection(safety);
  if (protection.measurementsInvalid) {
    if (safety.confirmedCritical.active) {
      safety.confirmedCritical.preservedDuringFault = true;
    }
    return;
  }

  if (analysis.available && analysis.status === 'CRITICAL') {
    safety.confirmedCritical = {
      active: true,
      depthCm: analysis.filteredDepthCm ?? safety.confirmedCritical.depthCm,
      confirmedAtMs: analysis.lastUpdatedMs || Date.now(),
      preservedDuringFault: false
    };
  } else if (analysis.available && (analysis.status === 'NORMAL' || analysis.status === 'WARNING')) {
    safety.confirmedCritical = {
      active: false,
      depthCm: null,
      confirmedAtMs: null,
      preservedDuringFault: false
    };
  } else if (analysis.status === 'OUT_OF_RANGE' && safety.confirmedCritical.active) {
    safety.confirmedCritical.preservedDuringFault = true;
  }
}
