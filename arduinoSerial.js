/**
 * ============================================================================
 * NYC FloodGuard 2.0 — Arduino GIGA R1 WiFi USB Web Serial Connection Module
 * File: arduinoSerial.js
 *
 * Uses the browser Web Serial API (Chrome / Edge / Opera on desktop) to receive
 * live sensor readings over USB at 115200 baud and send manual commands (e.g. 'c'
 * for dry-road recalibration).
 *
 * Supports BOTH serial output formats seamlessly:
 *
 *   1. Human-readable Arduino pipe-delimited format (authoritative depth & status):
 *      Distance: 14.39 cm | Water Depth: 0.00 cm | Status: NORMAL
 *      Distance: 13.36 cm | Water Depth: 1.03 cm | Status: WARNING
 *      Distance: 12.67 cm | Water Depth: 1.72 cm | Status: CRITICAL
 *
 *   2. Explicit Arduino calibration status lines (on startup or after 'c' command):
 *      Dry Baseline: 14.05 cm
 *      Calibrated Baseline: 14.05 cm
 *      Recalibrating dry baseline...
 *
 *   3. Newline-delimited JSON format (nyc_floodguard_giga.ino):
 *      {"device":"GIGA-R1-WIFI","mount_height_cm":14.39,"distance_cm":13.36,"water_depth_cm":1.03,...}
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
  if (upper === 'OUT_OF_RANGE' || upper === 'OUT OF RANGE' || upper === 'ERROR' || upper === 'INVALID') {
    return 'OUT_OF_RANGE';
  }
  return null;
}

/**
 * Parses explicit Arduino calibration messages printed on startup or after sending 'c'.
 * Examples:
 *   "Calibrated Baseline: 14.05 cm"
 *   "Dry-road baseline set to 14.39 cm"
 *   "Dry Baseline = 14.12 cm"
 *   "Recalibrating..."
 */
function parseCalibrationMessageLine(trimmed) {
  const hasCalibKeyword = /\b(calibrat\w*|baseline|dry[\s-]*road|zero[\s-]*point)\b/i.test(trimmed);
  if (!hasCalibKeyword) return null;

  // Ignore regular telemetry lines that happen to include pipe-delimited Water Depth
  if (/water\s*depth\s*:/i.test(trimmed)) return null;

  const valMatch = trimmed.match(/([+-]?\d+(?:\.\d+)?)\s*cm\b/i) ||
    trimmed.match(/(?:baseline|calibrated|dry[\s-]*road)\s*(?:height|distance)?\s*(?:is|set\s*to|=|:)\s*([+-]?\d+(?:\.\d+)?)/i);
  const baselineCm = valMatch ? Number(valMatch[1]) : null;
  const isStarting = /\b(recalibrat\w*|calibrating|starting\s+calibration)\b/i.test(trimmed) && !Number.isFinite(baselineCm);

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

function normalizeFloatSwitchState(raw) {
  if (!raw) return null;
  const upper = String(raw).trim().toUpperCase();
  if (upper === 'OPEN' || upper === 'DRY' || upper === '0' || upper === 'LOW') return 'OPEN';
  if (upper === 'CLOSED' || upper === 'CLOSE' || upper === 'WET' || upper === 'TRIGGERED' || upper === '1' || upper === 'HIGH') {
    return 'CLOSED';
  }
  return null;
}

/**
 * Parses standalone float-switch serial lines emitted by the Arduino GIGA R1 WiFi:
 *   "Float Switch: OPEN"
 *   "Float Switch: CLOSED"
 * Does NOT match lines that also carry ultrasonic Distance / Water Depth readings
 * (those are parsed by parseTextSerialLine with optional floatSwitchState attached).
 */
function parseFloatSwitchLine(trimmed) {
  if (/distance\s*:|(?:water\s*)?depth\s*:/i.test(trimmed)) {
    return null;
  }
  const match = trimmed.match(/^(?:backup\s+)?float(?:\s+switch|\s+sensor)?\s*(?::|=)\s*(OPEN|CLOSED)\b/i);
  if (!match) return null;

  const state = normalizeFloatSwitchState(match[1]);
  if (!state) return null;

  return {
    format: 'float_switch',
    device: 'Arduino GIGA R1 WiFi',
    sensorModel: 'Liyafy XSL-3508-P',
    floatSwitchState: state,
    receivedAtMs: Date.now(),
    rawLine: trimmed
  };
}

/**
 * Parses the pipe-delimited text line emitted by the tested Arduino GIGA R1 WiFi sketch:
 *   "Distance: 14.03 cm | Water Depth: 0.00 cm | Status: NORMAL"
 * Also preserves optional inline float-switch status if appended on the same line:
 *   "Distance: 14.03 cm | Water Depth: 0.00 cm | Status: NORMAL | Float Switch: OPEN"
 *
 * IMPORTANT CALIBRATION RELIABILITY RULE:
 *   - When Water Depth is 0.00 cm, the Arduino clamps negative differences (distance > baseline)
 *     to 0.00 cm. Therefore (distance + 0.00) does NOT equal the true dry baseline when
 *     ultrasonic noise bounces above the baseline (e.g. 15.78 cm + 0.00 != 14.05 cm).
 *   - We therefore compute `inferredBaselineCm = distance + depth` ONLY when depth > 0.02 cm
 *     (unclamped), and expose it separately from `distanceCm` so the dashboard NEVER overwrites
 *     a locked baseline from noisy clamped-zero readings or during active flooding.
 */
function parseTextSerialLine(trimmed) {
  const distMatch = trimmed.match(/distance\s*:\s*([+-]?\d+(?:\.\d+)?)\s*(?:cm)?/i);
  const depthMatch = trimmed.match(/(?:water\s*)?depth\s*:\s*([+-]?\d+(?:\.\d+)?)\s*(?:cm)?/i);
  const statusMatch = trimmed.match(/status\s*:\s*([a-zA-Z0-9_\- ]+)/i);
  const floatMatch = trimmed.match(/float(?:\s+switch|\s+sensor)?\s*(?::|=)\s*(OPEN|CLOSED)\b/i);

  const hasOutOfRangeWord = /\b(out\s*of\s*range|timeout|no\s*echo|invalid\s*reading)\b/i.test(trimmed);

  if (!distMatch && !depthMatch && !hasOutOfRangeWord) {
    return null;
  }

  const distanceCm = distMatch ? Number(distMatch[1]) : null;
  const reportedDepthCm = depthMatch ? Number(depthMatch[1]) : null;
  const reportedStatus = statusMatch ? normalizeStatusToken(statusMatch[1].split('|')[0]) : null;
  const floatSwitchState = floatMatch ? normalizeFloatSwitchState(floatMatch[1]) : null;

  const isExplicitError =
    hasOutOfRangeWord ||
    reportedStatus === 'OUT_OF_RANGE' ||
    (distMatch && !Number.isFinite(distanceCm));

  // Only infer the Arduino's internal baseline when depth is strictly positive (unclamped).
  // Clamped zero readings (e.g. Distance: 15.78 cm | Water Depth: 0.00 cm) are NOT valid
  // baseline measurements because ultrasonic scatter above the dry floor clamps to 0.00 cm.
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
    errorCode = /timeout|no\s*echo/i.test(trimmed) ? 'ultrasonic_timeout' : 'out_of_range';
    firmwareQuality = 'out_of_range';
  }

  return {
    format: 'text',
    device: 'Arduino GIGA R1 WiFi',
    distanceCm: Number.isFinite(distanceCm) ? Number(distanceCm.toFixed(2)) : null,
    // Keep mountHeightCm populated only when mathematically unclamped (or null when clamped at 0)
    mountHeightCm: inferredBaselineCm,
    inferredBaselineCm,
    reportedDepthCm:
      !isExplicitError && Number.isFinite(reportedDepthCm) ? Number(reportedDepthCm.toFixed(2)) : null,
    reportedStatus: reportedStatus && reportedStatus !== 'OUT_OF_RANGE' ? reportedStatus : null,
    errorCode,
    firmwareQuality,
    burstSpreadCm: null,
    validPings: null,
    floatLow: null,
    floatHigh: null,
    floatSwitchState,
    barrierState: 'not_installed',
    uptimeMs: null,
    receivedAtMs: Date.now(),
    rawLine: trimmed
  };
}

/**
 * Safely parses a single newline-delimited serial line (JSON, calibration message,
 * standalone float-switch line, or ultrasonic text format).
 * Preserves explicit error/out-of-range frames so the dashboard flags Out of Range
 * instead of silently dropping them or interpreting them as 0.00 cm water depth.
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
      const floatSwitchState = normalizeFloatSwitchState(obj.float_switch ?? obj.float_state);

      const hasValidMeasurement = Number.isFinite(distanceCm) || Number.isFinite(waterDepthCm);
      const hasExplicitError = Boolean(errorCode) || firmwareQuality === 'out_of_range';

      if (!hasValidMeasurement && !hasExplicitError && !floatSwitchState) {
        return null;
      }

      if (!hasValidMeasurement && !hasExplicitError && floatSwitchState) {
        return {
          format: 'float_switch',
          device: String(obj.device || 'Arduino GIGA R1 WiFi'),
          sensorModel: 'Liyafy XSL-3508-P',
          floatSwitchState,
          receivedAtMs: Date.now(),
          rawLine: trimmed
        };
      }

      return {
        format: 'json',
        device: String(obj.device || 'Arduino GIGA R1 WiFi'),
        distanceCm: Number.isFinite(distanceCm) ? distanceCm : null,
        mountHeightCm: Number.isFinite(mountHeightCm) ? mountHeightCm : null,
        inferredBaselineCm: Number.isFinite(mountHeightCm) ? mountHeightCm : null,
        reportedDepthCm: Number.isFinite(waterDepthCm) ? waterDepthCm : null,
        reportedStatus: reportedStatus && reportedStatus !== 'OUT_OF_RANGE' ? reportedStatus : null,
        errorCode,
        firmwareQuality,
        burstSpreadCm: Number.isFinite(burstSpreadCm) ? burstSpreadCm : null,
        validPings: Number.isFinite(validPings) ? validPings : null,
        floatLow: typeof obj.float_low === 'boolean' ? obj.float_low : null,
        floatHigh: typeof obj.float_high === 'boolean' ? obj.float_high : null,
        floatSwitchState,
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

  // 2. Standalone float-switch line ("Float Switch: OPEN" / "Float Switch: CLOSED")
  const floatMsg = parseFloatSwitchLine(trimmed);
  if (floatMsg) return floatMsg;

  // 3. Explicit Arduino calibration message (on boot or after 'c' command)
  const calibMsg = parseCalibrationMessageLine(trimmed);
  if (calibMsg) return calibMsg;

  // 4. Pipe-delimited ultrasonic text format ("Distance: 14.03 cm | Water Depth: 0.00 cm | Status: NORMAL")
  return parseTextSerialLine(trimmed);
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
    this.lineBuffer = '';
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
      this.lineBuffer = '';

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
   * Sends a single serial command (such as 'c' for dry-road recalibration) to the connected Arduino.
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
          this.lineBuffer += value;
          const lines = this.lineBuffer.split(/\r?\n/);
          this.lineBuffer = lines.pop() || '';

          for (const line of lines) {
            const parsed = parseArduinoSerialLine(line);
            if (parsed) {
              this.onReading(parsed);
            }
          }
        }
      }
      // If stream ended cleanly while we still expected to read, treat as connection lost
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

    if (typeof navigator !== 'undefined' && navigator.serial && typeof navigator.serial.removeEventListener === 'function') {
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
      this.lineBuffer = '';
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
