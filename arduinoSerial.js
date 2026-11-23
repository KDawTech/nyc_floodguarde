/**
 * ============================================================================
 * NYC FloodGuard 2.0 — Arduino GIGA R1 WiFi USB Web Serial Connection Module
 * File: arduinoSerial.js
 *
 * Uses the browser Web Serial API (Chrome / Edge / Opera on desktop) to receive
 * live sensor readings over USB at 115200 baud.
 *
 * Supports BOTH serial output formats seamlessly:
 *
 *   1. Human-readable Arduino pipe-delimited format (auto dry-road calibrated):
 *      Distance: 14.39 cm | Water Depth: 0.00 cm | Status: NORMAL
 *      Distance: 13.36 cm | Water Depth: 1.03 cm | Status: WARNING
 *      Distance: 12.67 cm | Water Depth: 1.72 cm | Status: CRITICAL
 *
 *   2. Newline-delimited JSON format (nyc_floodguard_giga.ino):
 *      {"device":"GIGA-R1-WIFI","mount_height_cm":25.00,"distance_cm":18.40,"water_depth_cm":6.60,...}
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
 * Parses the pipe-delimited text line emitted by the tested Arduino GIGA R1 WiFi sketch:
 *   "Distance: 14.39 cm | Water Depth: 0.00 cm | Status: NORMAL"
 * Also tolerates minor whitespace, casing, or error tokens (e.g. "Distance: Out of Range").
 */
function parseTextSerialLine(trimmed) {
  // Match "Distance: <number> cm" (unit optional)
  const distMatch = trimmed.match(/distance\s*:\s*([+-]?\d+(?:\.\d+)?)\s*(?:cm)?/i);
  // Match "Water Depth: <number> cm" or "Depth: <number> cm"
  const depthMatch = trimmed.match(/(?:water\s*)?depth\s*:\s*([+-]?\d+(?:\.\d+)?)\s*(?:cm)?/i);
  // Match "Status: <token>"
  const statusMatch = trimmed.match(/status\s*:\s*([a-zA-Z0-9_\- ]+)/i);

  const hasOutOfRangeWord = /\b(out\s*of\s*range|timeout|no\s*echo|invalid\s*reading)\b/i.test(trimmed);

  if (!distMatch && !depthMatch && !hasOutOfRangeWord) {
    return null;
  }

  const distanceCm = distMatch ? Number(distMatch[1]) : null;
  const reportedDepthCm = depthMatch ? Number(depthMatch[1]) : null;
  const reportedStatus = statusMatch ? normalizeStatusToken(statusMatch[1].split('|')[0]) : null;

  const isExplicitError =
    hasOutOfRangeWord ||
    reportedStatus === 'OUT_OF_RANGE' ||
    (distMatch && !Number.isFinite(distanceCm));

  // Auto-calibrated dry-road baseline from the Arduino:
  // Example: 14.39 + 0.00 = 14.39, 13.36 + 1.03 = 14.39, 12.67 + 1.72 = 14.39
  let mountHeightCm = null;
  if (
    Number.isFinite(distanceCm) &&
    Number.isFinite(reportedDepthCm) &&
    distanceCm > 0 &&
    reportedDepthCm >= 0
  ) {
    mountHeightCm = Number((distanceCm + reportedDepthCm).toFixed(2));
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
    mountHeightCm,
    reportedDepthCm: Number.isFinite(reportedDepthCm) ? Number(reportedDepthCm.toFixed(2)) : null,
    reportedStatus: reportedStatus && reportedStatus !== 'OUT_OF_RANGE' ? reportedStatus : null,
    errorCode,
    firmwareQuality,
    burstSpreadCm: null,
    validPings: null,
    floatLow: null,
    floatHigh: null,
    barrierState: 'not_installed',
    uptimeMs: null,
    receivedAtMs: Date.now(),
    rawLine: trimmed
  };
}

/**
 * Safely parses a single newline-delimited serial line (either text format or JSON format).
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
      const mountHeightCm = obj.mount_height_cm != null ? Number(obj.mount_height_cm) : null;
      const waterDepthCm = obj.water_depth_cm != null ? Number(obj.water_depth_cm) : null;
      const burstSpreadCm = obj.burst_spread_cm != null ? Number(obj.burst_spread_cm) : null;
      const validPings = obj.valid_pings != null ? Number(obj.valid_pings) : null;
      const firmwareQuality = obj.quality ? String(obj.quality).toLowerCase() : null;
      const reportedStatus = normalizeStatusToken(obj.status || obj.flood_status);

      const hasValidMeasurement = Number.isFinite(distanceCm) || Number.isFinite(waterDepthCm);
      const hasExplicitError = Boolean(errorCode) || firmwareQuality === 'out_of_range';

      if (!hasValidMeasurement && !hasExplicitError) {
        return null;
      }

      return {
        format: 'json',
        device: String(obj.device || 'Arduino GIGA R1 WiFi'),
        distanceCm: Number.isFinite(distanceCm) ? distanceCm : null,
        mountHeightCm: Number.isFinite(mountHeightCm) ? mountHeightCm : null,
        reportedDepthCm: Number.isFinite(waterDepthCm) ? waterDepthCm : null,
        reportedStatus: reportedStatus && reportedStatus !== 'OUT_OF_RANGE' ? reportedStatus : null,
        errorCode,
        firmwareQuality,
        burstSpreadCm: Number.isFinite(burstSpreadCm) ? burstSpreadCm : null,
        validPings: Number.isFinite(validPings) ? validPings : null,
        floatLow: typeof obj.float_low === 'boolean' ? obj.float_low : null,
        floatHigh: typeof obj.float_high === 'boolean' ? obj.float_high : null,
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

  // 2. Pipe-delimited text format ("Distance: 14.39 cm | Water Depth: 0.00 cm | Status: NORMAL")
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
        this.onError('Arduino USB cable was disconnected.');
        this.disconnect();
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
        'Select your Arduino GIGA R1 WiFi USB port (make sure Arduino IDE Serial Monitor is closed)…'
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
        `Connected over USB Serial (${this.baudRate} baud). Listening for Arduino sensor readings…`
      );

      this._readLoop().catch((err) => {
        if (this.keepReading) {
          this.onError(err instanceof Error ? err.message : 'USB Serial connection interrupted.');
          this.disconnect();
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
      this.onStatusChange('disconnected', message);
      if (!isCancelled) {
        this.onError(message);
      }
      return { ok: false, error: message, cancelled: isCancelled };
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

  async disconnect() {
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
        this.onStatusChange('disconnected', 'Arduino USB disconnected.');
      }
    }
  }
}
