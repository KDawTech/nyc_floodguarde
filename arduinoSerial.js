/**
 * ============================================================================
 * NYC FloodGuard — Arduino GIGA R1 WiFi USB Web Serial Connection Module
 * File: arduinoSerial.js
 *
 * Uses the browser Web Serial API (Chrome / Edge / Opera on desktop) to receive
 * live newline-delimited JSON sensor readings over USB at 115200 baud.
 *
 * Compatible with BOTH original firmware payloads and upgraded quality payloads:
 *   Valid reading:
 *     {"device":"GIGA-R1-WIFI","mount_height_cm":25.00,"distance_cm":18.40,"water_depth_cm":6.60,"float_low":true,"float_high":false,"barrier_state":"not_installed","quality":"good","burst_spread_cm":0.18,"valid_pings":5,"uptime_ms":14200}
 *   Timeout / Out-of-range reading:
 *     {"device":"GIGA-R1-WIFI","mount_height_cm":25.00,"distance_cm":null,"water_depth_cm":null,"error":"ultrasonic_timeout","quality":"out_of_range","uptime_ms":15200}
 * ============================================================================
 */

export function isWebSerialSupported() {
  return typeof navigator !== 'undefined' && 'serial' in navigator && typeof navigator.serial.requestPort === 'function';
}

/**
 * Safely parses a single newline-delimited JSON line from the Arduino serial stream.
 * Preserves explicit error/out-of-range frames so the dashboard flags Out of Range
 * instead of silently dropping them or interpreting them as 0.0 cm water depth.
 */
export function parseArduinoSerialLine(rawLine) {
  const trimmed = String(rawLine || '').trim();
  if (!trimmed || !trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }

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

    const hasValidMeasurement = Number.isFinite(distanceCm) || Number.isFinite(waterDepthCm);
    const hasExplicitError = Boolean(errorCode) || firmwareQuality === 'out_of_range';

    // Ignore unrelated JSON objects that contain neither measurement nor sensor error
    if (!hasValidMeasurement && !hasExplicitError) {
      return null;
    }

    return {
      device: String(obj.device || 'Arduino GIGA R1 WiFi'),
      distanceCm: Number.isFinite(distanceCm) ? distanceCm : null,
      mountHeightCm: Number.isFinite(mountHeightCm) ? mountHeightCm : null,
      reportedDepthCm: Number.isFinite(waterDepthCm) ? waterDepthCm : null,
      errorCode,
      firmwareQuality,
      burstSpreadCm: Number.isFinite(burstSpreadCm) ? burstSpreadCm : null,
      validPings: Number.isFinite(validPings) ? validPings : null,
      floatLow: typeof obj.float_low === 'boolean' ? obj.float_low : null,
      floatHigh: typeof obj.float_high === 'boolean' ? obj.float_high : null,
      barrierState: obj.barrier_state ? String(obj.barrier_state) : 'not_installed',
      uptimeMs: obj.uptime_ms != null && Number.isFinite(Number(obj.uptime_ms)) ? Number(obj.uptime_ms) : null,
      receivedAtMs: Date.now(),
      rawLine: trimmed
    };
  } catch {
    return null;
  }
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
  }

  async connect() {
    if (!isWebSerialSupported()) {
      const msg =
        'Web Serial is not supported in this browser. Use Chrome or Microsoft Edge on desktop to connect the Arduino GIGA R1 WiFi via USB, or use Simulation Mode.';
      this.onError(msg);
      return { ok: false, error: msg };
    }

    if (this.connected) {
      return { ok: true };
    }

    try {
      this.onStatusChange('connecting', 'Select your Arduino GIGA R1 WiFi USB port…');
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: this.baudRate });

      this.port = port;
      this.connected = true;
      this.keepReading = true;
      this.lineBuffer = '';

      this.onStatusChange('connected', `Connected over USB Serial (${this.baudRate} baud). Waiting for sensor JSON…`);

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
      const message = isCancelled
        ? 'No USB serial port selected.'
        : err instanceof Error
        ? `Unable to open Arduino USB port: ${err.message}`
        : 'Unable to open Arduino USB port.';
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
