/**
 * ============================================================================
 * NYC FloodGuard 2.0 — Arduino GIGA R1 WiFi USB Web Serial Connection Module
 * File: arduinoSerial.js
 *
 * Uses the browser Web Serial API (Chrome / Edge / Opera on desktop) to receive
 * live sensor readings over USB at 115200 baud and send manual commands ('c'
 * for dry-road & stationary-mount recalibration).
 *
 * Supported Arduino GIGA R1 Serial Messages (115200 baud):
 *   1. Ultrasonic water telemetry:
 *      Distance: 15.42 cm | Water Depth: 0.00 cm | Status: NORMAL
 *      Distance: 14.80 cm | Water Depth: 0.62 cm | Status: WARNING
 *      Distance: 13.90 cm | Water Depth: 1.52 cm | Status: CRITICAL
 *      SENSOR ERROR
 *
 *   2. ADXL345 mount stability telemetry:
 *      Mount Status: STABLE | Deviation: 0.003 g
 *      Mount Status: MOVEMENT_DETECTED | Deviation: 0.279 g
 *      Mount Status: RECALIBRATION_REQUIRED | Deviation: 0.009 g
 *      Mount Status: UNAVAILABLE
 *
 *   3. Commanded local RGB LED + active buzzer alarm mode:
 *      Alarm Mode: NORMAL
 *      Alarm Mode: WARNING
 *      Alarm Mode: CRITICAL
 *      Alarm Mode: SENSOR_FAULT
 *      Alarm Mode: CALIBRATING
 *
 *   4. Calibration lifecycle messages:
 *      ADXL345 CALIBRATION COMPLETE
 *      Calibration complete.
 *      CALIBRATION FAILED
 *      Dry Baseline: 15.42 cm / Calibrated Baseline: 15.42 cm
 *
 *   5. Backwards-compatible older firmware (ultrasonic lines without Mount/Alarm)
 *      and newline-delimited JSON format.
 * ============================================================================
 */

export function isWebSerialSupported() {
  return (
    typeof navigator !== 'undefined' &&
    'serial' in navigator &&
    typeof navigator.serial.requestPort === 'function'
  );
}

function normalizeStatusToken(raw) {
  if (!raw) return null;
  const upper = String(raw).trim().toUpperCase();
  if (upper === 'NORMAL' || upper === 'OK' || upper === 'SAFE') return 'NORMAL';
  if (upper === 'WARNING' || upper === 'WARN' || upper === 'CAUTION') return 'WARNING';
  if (upper === 'CRITICAL' || upper === 'CRIT' || upper === 'DANGER' || upper === 'FLOOD') return 'CRITICAL';
  if (upper === 'SENSOR_FAULT' || upper === 'SENSOR FAULT' || upper === 'SENSOR_ERROR' || upper === 'SENSOR ERROR') {
    return 'SENSOR_FAULT';
  }
  if (upper === 'OUT_OF_RANGE' || upper === 'OUT OF RANGE' || upper === 'ERROR' || upper === 'INVALID') {
    return 'OUT_OF_RANGE';
  }
  return null;
}

function normalizeMountStatusToken(raw) {
  if (!raw) return null;
  const upper = String(raw).trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (upper === 'STABLE') return 'STABLE';
  if (upper === 'MOVEMENT_DETECTED' || upper === 'MOVED' || upper === 'UNSTABLE') return 'MOVEMENT_DETECTED';
  if (upper === 'RECALIBRATION_REQUIRED' || upper === 'NEEDS_RECALIBRATION') return 'RECALIBRATION_REQUIRED';
  if (upper === 'UNAVAILABLE' || upper === 'OFFLINE' || upper === 'NOT_FOUND') return 'UNAVAILABLE';
  return null;
}

function normalizeAlarmModeToken(raw) {
  if (!raw) return null;
  const upper = String(raw).trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (upper === 'NORMAL') return 'NORMAL';
  if (upper === 'WARNING') return 'WARNING';
  if (upper === 'CRITICAL') return 'CRITICAL';
  if (upper === 'SENSOR_FAULT' || upper === 'FAULT' || upper === 'ERROR') return 'SENSOR_FAULT';
  if (upper === 'CALIBRATING' || upper === 'CALIBRATION') return 'CALIBRATING';
  return null;
}

/**
 * Parses standalone ultrasonic/hardware fault messages such as:
 *   "SENSOR ERROR"
 *   "Sensor Error: no echo"
 * Never interprets a sensor error as 0.00 cm depth or NORMAL status.
 */
function parseSensorErrorLine(trimmed) {
  if (!/^sensor\s+error\b/i.test(trimmed)) return null;
  return {
    format: 'sensor_error',
    device: 'Arduino GIGA R1 WiFi',
    distanceCm: null,
    mountHeightCm: null,
    inferredBaselineCm: null,
    reportedDepthCm: null,
    reportedStatus: 'SENSOR_FAULT',
    errorCode: 'sensor_error',
    firmwareQuality: 'out_of_range',
    receivedAtMs: Date.now(),
    rawLine: trimmed
  };
}

/**
 * Parses ADXL345 mount stability lines:
 *   "Mount Status: STABLE | Deviation: 0.003 g"
 *   "Mount Status: MOVEMENT_DETECTED | Deviation: 0.279 g"
 *   "Mount Status: RECALIBRATION_REQUIRED | Deviation: 0.009 g"
 *   "Mount Status: UNAVAILABLE"
 */
function parseMountStatusLine(trimmed) {
  const statusMatch = trimmed.match(/^mount\s+status\s*:\s*([a-zA-Z0-9_\- ]+?)(?:\s*\||$)/i);
  if (!statusMatch) return null;

  const mountStatus = normalizeMountStatusToken(statusMatch[1]);
  if (!mountStatus) return null;

  const devMatch = trimmed.match(/deviation\s*:\s*([+-]?\d+(?:\.\d+)?)\s*g?\b/i);
  const deviationG = devMatch && Number.isFinite(Number(devMatch[1]))
    ? Number(Number(devMatch[1]).toFixed(3))
    : null;

  return {
    format: 'mount_status',
    device: 'Arduino GIGA R1 WiFi',
    sensorModel: 'ADXL345',
    mountStatus,
    deviationG,
    receivedAtMs: Date.now(),
    rawLine: trimmed
  };
}

/**
 * Parses Arduino-commanded local RGB LED + active buzzer alarm mode lines:
 *   "Alarm Mode: NORMAL"
 *   "Alarm Mode: WARNING"
 *   "Alarm Mode: CRITICAL"
 *   "Alarm Mode: SENSOR_FAULT"
 *   "Alarm Mode: CALIBRATING"
 */
function parseAlarmModeLine(trimmed) {
  const match = trimmed.match(/^alarm\s+mode\s*:\s*([a-zA-Z0-9_\- ]+)$/i);
  if (!match) return null;

  const alarmMode = normalizeAlarmModeToken(match[1]);
  if (!alarmMode) return null;

  return {
    format: 'alarm_mode',
    device: 'Arduino GIGA R1 WiFi',
    alarmMode,
    commandedOnly: true,
    receivedAtMs: Date.now(),
    rawLine: trimmed
  };
}

/**
 * Parses explicit Arduino calibration lifecycle lines printed on startup or after sending 'c':
 *   "ADXL345 CALIBRATION COMPLETE"
 *   "Calibration complete."
 *   "CALIBRATION FAILED"
 *   "Calibrated Baseline: 15.42 cm"
 *   "Dry Baseline: 15.42 cm"
 *   "Recalibrating..."
 */
function parseCalibrationMessageLine(trimmed) {
  // Ignore regular telemetry lines that carry Water Depth, Mount Status, or Alarm Mode
  if (/water\s*depth\s*:|^mount\s+status\s*:|^alarm\s+mode\s*:/i.test(trimmed)) return null;

  // 1. Explicit calibration failure
  if (/\bcalibration\s+failed\b/i.test(trimmed)) {
    return {
      format: 'calibration',
      device: 'Arduino GIGA R1 WiFi',
      calibrationState: 'failed',
      baselineCm: null,
      receivedAtMs: Date.now(),
      rawLine: trimmed
    };
  }

  // 2. Explicit ADXL345 accelerometer calibration completion
  if (/\badxl345\s+calibration\s+complete\b/i.test(trimmed)) {
    return {
      format: 'calibration',
      device: 'Arduino GIGA R1 WiFi',
      calibrationState: 'adxl_complete',
      baselineCm: null,
      receivedAtMs: Date.now(),
      rawLine: trimmed
    };
  }

  const hasCalibKeyword = /\b(calibrat\w*|baseline|dry[\s-]*road|zero[\s-]*point)\b/i.test(trimmed);
  if (!hasCalibKeyword) return null;

  const valMatch =
    trimmed.match(/([+-]?\d+(?:\.\d+)?)\s*cm\b/i) ||
    trimmed.match(
      /(?:baseline|calibrated|dry[\s-]*road)\s*(?:height|distance)?\s*(?:is|set\s*to|=|:)\s*([+-]?\d+(?:\.\d+)?)/i
    );
  const baselineCm = valMatch ? Number(valMatch[1]) : null;

  // 3. Explicit calibration complete (with or without numeric baseline cm)
  if (/\bcalibration\s+complete\b/i.test(trimmed)) {
    return {
      format: 'calibration',
      device: 'Arduino GIGA R1 WiFi',
      calibrationState: 'complete',
      baselineCm:
        Number.isFinite(baselineCm) && baselineCm >= 3.0 && baselineCm <= 400.0
          ? Number(baselineCm.toFixed(2))
          : null,
      receivedAtMs: Date.now(),
      rawLine: trimmed
    };
  }

  // 4. Explicit numeric baseline report
  if (Number.isFinite(baselineCm) && baselineCm >= 3.0 && baselineCm <= 400.0) {
    return {
      format: 'calibration',
      device: 'Arduino GIGA R1 WiFi',
      calibrationState: 'calibrated',
      baselineCm: Number(baselineCm.toFixed(2)),
      receivedAtMs: Date.now(),
      rawLine: trimmed
    };
  }

  // 5. Calibration starting / in progress
  const isStarting = /\b(recalibrat\w*|calibrating|starting\s+calibration)\b/i.test(trimmed);
  if (isStarting) {
    return {
      format: 'calibration',
      device: 'Arduino GIGA R1 WiFi',
      calibrationState: 'calibrating',
      baselineCm: null,
      receivedAtMs: Date.now(),
      rawLine: trimmed
    };
  }

  return null;
}

/**
 * Parses the pipe-delimited ultrasonic telemetry line emitted by the Arduino GIGA R1 WiFi:
 *   "Distance: 15.42 cm | Water Depth: 0.00 cm | Status: NORMAL"
 *
 * IMPORTANT CALIBRATION RELIABILITY RULE:
 *   - When Water Depth is 0.00 cm, the Arduino clamps negative differences (distance > baseline)
 *     to 0.00 cm. Therefore `inferredBaselineCm = distance + depth` is computed ONLY when
 *     depth > 0.02 cm (unclamped), so noisy dry echoes never overwrite a locked baseline.
 */
function parseTextSerialLine(trimmed) {
  const distMatch = trimmed.match(/distance\s*:\s*([+-]?\d+(?:\.\d+)?)\s*(?:cm)?/i);
  const depthMatch = trimmed.match(/(?:water\s*)?depth\s*:\s*([+-]?\d+(?:\.\d+)?)\s*(?:cm)?/i);
  const statusMatch = trimmed.match(/status\s*:\s*([a-zA-Z0-9_\- ]+)/i);

  const hasOutOfRangeWord = /\b(out\s*of\s*range|timeout|no\s*echo|invalid\s*reading|sensor\s*error)\b/i.test(
    trimmed
  );

  if (!distMatch && !depthMatch && !hasOutOfRangeWord) {
    return null;
  }

  const distanceCm = distMatch ? Number(distMatch[1]) : null;
  const reportedDepthCm = depthMatch ? Number(depthMatch[1]) : null;
  const reportedStatus = statusMatch ? normalizeStatusToken(statusMatch[1].split('|')[0]) : null;

  const isExplicitError =
    hasOutOfRangeWord ||
    reportedStatus === 'OUT_OF_RANGE' ||
    reportedStatus === 'SENSOR_FAULT' ||
    (distMatch && !Number.isFinite(distanceCm));

  let inferredBaselineCm = null;
  if (
    !isExplicitError &&
    Number.isFinite(distanceCm) &&
    Number.isFinite(reportedDepthCm) &&
    distanceCm >= 2.0 &&
    reportedDepthCm > 0.02
  ) {
    inferredBaselineCm = Number((distanceCm + reportedDepthCm).toFixed(2));
  }

  let errorCode = null;
  let firmwareQuality = null;
  if (isExplicitError) {
    errorCode = /sensor\s*error/i.test(trimmed) || reportedStatus === 'SENSOR_FAULT'
      ? 'sensor_error'
      : /timeout|no\s*echo/i.test(trimmed)
      ? 'ultrasonic_timeout'
      : 'out_of_range';
    firmwareQuality = 'out_of_range';
  }

  return {
    format: 'text',
    device: 'Arduino GIGA R1 WiFi',
    distanceCm: !isExplicitError && Number.isFinite(distanceCm) ? Number(distanceCm.toFixed(2)) : null,
    mountHeightCm: inferredBaselineCm,
    inferredBaselineCm,
    reportedDepthCm:
      !isExplicitError && Number.isFinite(reportedDepthCm) ? Number(reportedDepthCm.toFixed(2)) : null,
    reportedStatus:
      reportedStatus && reportedStatus !== 'OUT_OF_RANGE' ? reportedStatus : null,
    errorCode,
    firmwareQuality,
    burstSpreadCm: null,
    validPings: null,
    barrierState: 'not_installed',
    uptimeMs: null,
    receivedAtMs: Date.now(),
    rawLine: trimmed
  };
}

/**
 * Safely parses a single newline-delimited serial line (JSON, SENSOR ERROR,
 * Mount Status, Alarm Mode, calibration lifecycle message, or ultrasonic text line).
 */
export function parseArduinoSerialLine(rawLine) {
  const trimmed = String(rawLine || '').trim();
  if (!trimmed) return null;

  // 1. JSON format (newline-delimited JSON from nyc_floodguard_giga.ino)
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed);
      if (!obj || typeof obj !== 'object') return null;

      const errorCode = obj.error ? String(obj.error) : null;
      const distanceCm = obj.distance_cm != null ? Number(obj.distance_cm) : null;
      const mountHeightCm =
        obj.baseline_cm != null
          ? Number(obj.baseline_cm)
          : obj.mount_height_cm != null
          ? Number(obj.mount_height_cm)
          : null;
      const waterDepthCm =
        obj.water_depth_cm != null
          ? Number(obj.water_depth_cm)
          : obj.water_level_cm != null
          ? Number(obj.water_level_cm)
          : null;
      const burstSpreadCm = obj.burst_spread_cm != null ? Number(obj.burst_spread_cm) : null;
      const validPings = obj.valid_pings != null ? Number(obj.valid_pings) : null;
      const firmwareQuality = obj.quality ? String(obj.quality).toLowerCase() : null;
      const reportedStatus = normalizeStatusToken(obj.status || obj.flood_status);
      const mountStatus = normalizeMountStatusToken(obj.mount_status);
      const deviationG =
        obj.deviation_g != null && Number.isFinite(Number(obj.deviation_g))
          ? Number(Number(obj.deviation_g).toFixed(3))
          : null;
      const alarmMode = normalizeAlarmModeToken(obj.alarm_mode);

      const hasValidMeasurement = Number.isFinite(distanceCm) || Number.isFinite(waterDepthCm);
      const hasExplicitError = Boolean(errorCode) || firmwareQuality === 'out_of_range';

      if (!hasValidMeasurement && !hasExplicitError) {
        return null;
      }

      return {
        format: 'json',
        device: String(obj.device || 'Arduino GIGA R1 WiFi'),
        distanceCm: !hasExplicitError && Number.isFinite(distanceCm) ? distanceCm : null,
        mountHeightCm: Number.isFinite(mountHeightCm) ? mountHeightCm : null,
        inferredBaselineCm: Number.isFinite(mountHeightCm) ? mountHeightCm : null,
        reportedDepthCm: !hasExplicitError && Number.isFinite(waterDepthCm) ? waterDepthCm : null,
        reportedStatus: reportedStatus && reportedStatus !== 'OUT_OF_RANGE' ? reportedStatus : null,
        mountStatus,
        deviationG,
        alarmMode,
        errorCode,
        firmwareQuality,
        burstSpreadCm: Number.isFinite(burstSpreadCm) ? burstSpreadCm : null,
        validPings: Number.isFinite(validPings) ? validPings : null,
        barrierState: obj.barrier_state ? String(obj.barrier_state) : 'not_installed',
        uptimeMs:
          obj.uptime_ms != null && Number.isFinite(Number(obj.uptime_ms))
            ? Number(obj.uptime_ms)
            : null,
        receivedAtMs: Date.now(),
        rawLine: trimmed
      };
    } catch {
      return null;
    }
  }

  // 2. Standalone SENSOR ERROR line
  const sensorErrMsg = parseSensorErrorLine(trimmed);
  if (sensorErrMsg) return sensorErrMsg;

  // 3. ADXL345 Mount Status line
  const mountMsg = parseMountStatusLine(trimmed);
  if (mountMsg) return mountMsg;

  // 4. Local Alarm Mode line
  const alarmMsg = parseAlarmModeLine(trimmed);
  if (alarmMsg) return alarmMsg;

  // 5. Explicit Arduino calibration lifecycle message
  const calibMsg = parseCalibrationMessageLine(trimmed);
  if (calibMsg) return calibMsg;

  // 6. Pipe-delimited ultrasonic text format
  return parseTextSerialLine(trimmed);
}

/**
 * Stateful USB serial chunk reassembler that safely handles arbitrary split
 * chunks (mid-line splits, CR/LF boundaries, multi-line bursts) and emits
 * parsed packets in exact arrival order.
 */
export function createSerialStreamParser(onParsed) {
  let lineBuffer = '';

  return {
    pushChunk(chunk) {
      const parsedItems = [];
      if (!chunk) return parsedItems;
      lineBuffer += String(chunk);
      // Guard against runaway memory if corrupted binary stream never sends newlines
      if (lineBuffer.length > 16384) {
        lineBuffer = lineBuffer.slice(-4096);
      }
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || '';

      for (const line of lines) {
        const parsed = parseArduinoSerialLine(line);
        if (parsed) {
          parsedItems.push(parsed);
          if (typeof onParsed === 'function') {
            onParsed(parsed);
          }
        }
      }
      return parsedItems;
    },
    reset() {
      lineBuffer = '';
    },
    getPendingBuffer() {
      return lineBuffer;
    }
  };
}

export class ArduinoSerialClient {
  constructor({ onReading, onStatusChange, onError, baudRate = 115200 } = {}) {
    this.onReading = onReading || (() => {});
    this.onStatusChange = onStatusChange || (() => {});
    this.onError = onError || (() => {});
    this.baudRate = baudRate;

    this.port = null;
    this.reader = null;
    this.readableStreamClosed = null;
    this.connected = false;
    this.keepReading = false;
    this.streamParser = createSerialStreamParser((packet) => this.onReading(packet));
    this._boundPortDisconnect = (ev) => {
      if (this.port && ev.target === this.port) {
        const msg = 'Arduino USB cable was disconnected — Connection Lost.';
        this.onError(msg);
        this.disconnect({ reason: 'unplugged', message: msg });
      }
    };
  }

  async connect() {
    if (!isWebSerialSupported()) {
      const msg =
        'Web Serial is not supported in this browser. Open NYC FloodGuard in desktop Chrome or Microsoft Edge to connect your Arduino GIGA R1 WiFi via USB, or use Demo Mode.';
      this.onError(msg);
      return { ok: false, error: msg };
    }

    if (this.connected) {
      return { ok: true };
    }

    try {
      this.onStatusChange(
        'connecting',
        'Select your Arduino GIGA R1 WiFi USB port (make sure Arduino IDE Serial Monitor is closed)…',
        { reason: 'connecting' }
      );
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: this.baudRate });

      this.port = port;
      this.connected = true;
      this.keepReading = true;
      this.streamParser.reset();

      if (typeof navigator.serial.addEventListener === 'function') {
        navigator.serial.addEventListener('disconnect', this._boundPortDisconnect);
      }

      this.onStatusChange(
        'connected',
        `Connected over USB Serial (${this.baudRate} baud). Listening for Arduino sensor readings…`,
        { reason: 'connected' }
      );

      this._readLoop().catch((err) => {
        if (this.keepReading) {
          const msg =
            err instanceof Error
              ? `Arduino USB serial connection lost: ${err.message}`
              : 'Arduino USB serial connection interrupted — Connection Lost.';
          this.onError(msg);
          this.disconnect({ reason: 'error', message: msg });
        }
      });

      return { ok: true };
    } catch (err) {
      this.connected = false;
      this.port = null;
      const isCancelled = err && (err.name === 'NotFoundError' || err.name === 'AbortError');
      let message;
      if (isCancelled) {
        message = 'No USB serial port selected.';
      } else if (err instanceof Error && /failed to open|busy|in use|access denied/i.test(err.message)) {
        message = `Could not open Arduino USB port (${err.message}). Close the Arduino IDE Serial Monitor and try again.`;
      } else {
        message =
          err instanceof Error
            ? `Unable to open Arduino USB port: ${err.message}`
            : 'Unable to open Arduino USB port.';
      }
      this.onStatusChange('disconnected', message, { reason: isCancelled ? 'cancelled' : 'error' });
      if (!isCancelled) {
        this.onError(message);
      }
      return { ok: false, error: message, cancelled: isCancelled };
    }
  }

  /**
   * Sends a single serial command (such as 'c' for dry-road & stationary-mount recalibration).
   */
  async sendCommand(command) {
    if (!this.connected || !this.port) {
      return { ok: false, error: 'Arduino is not connected over USB Serial.' };
    }
    if (!this.port.writable) {
      return { ok: false, error: 'Connected serial port does not expose a writable stream.' };
    }

    const writer = this.port.writable.getWriter();
    try {
      const payload = new TextEncoder().encode(`${String(command).trim()}\n`);
      await writer.write(payload);
      return { ok: true };
    } catch (err) {
      const msg =
        err instanceof Error
          ? `Failed to send command "${command}" to Arduino: ${err.message}`
          : `Failed to send command "${command}" to Arduino.`;
      this.onError(msg);
      return { ok: false, error: msg };
    } finally {
      try {
        writer.releaseLock();
      } catch {
        // Ignore lock release errors
      }
    }
  }

  async _readLoop() {
    if (!this.port || !this.port.readable) return;

    const textDecoder = new TextDecoderStream();
    this.readableStreamClosed = this.port.readable.pipeTo(textDecoder.writable);
    this.reader = textDecoder.readable.getReader();

    try {
      while (this.keepReading) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) {
          this.streamParser.pushChunk(value);
        }
      }
      if (this.keepReading) {
        const msg = 'Arduino USB serial stream closed unexpectedly — Connection Lost.';
        this.onError(msg);
        await this.disconnect({ reason: 'unplugged', message: msg });
      }
    } catch (err) {
      if (this.keepReading) {
        throw err;
      }
    } finally {
      try {
        this.reader?.releaseLock();
      } catch {
        // Ignore release errors
      }
    }
  }

  async disconnect({ reason = 'manual', message = '' } = {}) {
    this.keepReading = false;
    const wasConnected = this.connected;
    this.connected = false;

    if (
      typeof navigator !== 'undefined' &&
      navigator.serial &&
      typeof navigator.serial.removeEventListener === 'function'
    ) {
      navigator.serial.removeEventListener('disconnect', this._boundPortDisconnect);
    }

    try {
      if (this.reader) {
        await this.reader.cancel().catch(() => {});
      }
      if (this.readableStreamClosed) {
        await this.readableStreamClosed.catch(() => {});
      }
      if (this.port) {
        await this.port.close().catch(() => {});
      }
    } finally {
      this.reader = null;
      this.readableStreamClosed = null;
      this.port = null;
      this.streamParser.reset();
      if (wasConnected) {
        this.onStatusChange(
          'disconnected',
          message || (reason === 'manual' ? 'Arduino USB disconnected.' : 'Arduino USB connection lost.'),
          { reason }
        );
      }
    }
  }
}
