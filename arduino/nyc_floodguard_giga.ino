/*
 * ============================================================================
 * NYC FloodGuard — Arduino GIGA R1 WiFi + GIGA Display Shield Firmware
 * File: arduino/nyc_floodguard_giga.ino
 *
 * Hardware:
 *   - Arduino GIGA R1 WiFi (STM32H747XI — 3.3V GPIO LOGIC ONLY!)
 *   - Arduino GIGA Display Shield (800 x 480 touchscreen, landscape rotation 1)
 *   - HC-SR04 Ultrasonic Distance Sensor
 *   - Optional Low / High Float Switches (wired to GND with INPUT_PULLUP)
 *   - Optional Future Servo Flood Barrier (disabled by default)
 *   - Two water pumps (MANUALLY operated for flood & drainage demo;
 *     pump state and drainage operation are NOT monitored or automated)
 *
 * Local Display Note:
 *   The GIGA Display Shield operates as a local standalone hardware dashboard
 *   (no Wi-Fi or Supabase sync). Locally configured Warning and Critical
 *   thresholds below default to Warning = 5.0 cm and Critical = 12.0 cm to
 *   match your Supabase prototype settings. Update these constants manually if
 *   you recalibrate your mounting height or thresholds.
 *
 * CRITICAL 3.3V GPIO SAFETY REQUIREMENT (ARDUINO GIGA R1 WiFi):
 *   The Arduino GIGA R1 WiFi GPIO pins are strictly 3.3V tolerant and are
 *   NOT 5V tolerant. Because a standard HC-SR04 runs on 5V VCC, its ECHO pin
 *   outputs 5V! You MUST step ECHO down to <= 3.3V before connecting to D10:
 *
 *     HC-SR04 VCC  ---> 5V
 *     HC-SR04 GND  ---> GND
 *     HC-SR04 TRIG ---> D9  (3.3V output from GIGA triggers HC-SR04 safely)
 *     HC-SR04 ECHO ---> 470 Ohm ---> 470 Ohm (940 Ohm series) ---> D10
 *                                                                   |
 *                                                                 1 kOhm
 *                                                                   |
 *                                                                  GND
 *                       (Voltage divider: 5V * 1000 / (940 + 1000) = 2.58V,
 *                        safely <= 3.3V and reliably above GIGA logic HIGH)
 *     Float Switch LOW  ---> D6 and GND (INPUT_PULLUP)
 *     Float Switch HIGH ---> D7 and GND (INPUT_PULLUP)
 *     Optional Servo    ---> D5 (disabled by default; ENABLE_SERVO_BARRIER = 0)
 *
 * Calibration:
 *   1. Empty the 3D-printed NYC street basin completely so the surface is dry.
 *   2. Measure the distance (in cm) from the ultrasonic sensor face to the
 *      dry street floor (or observe distance_cm in Serial Monitor while dry).
 *   3. Set MOUNT_HEIGHT_CM below (and in the website Admin Settings) to that
 *      exact dry distance.
 *   4. Water Depth = MOUNT_HEIGHT_CM - Filtered Sensor Distance
 *      Invalid or out-of-range readings are NEVER shown as 0.00 cm.
 *
 * Serial Output Format (115200 baud, 1 JSON object per line every 1000 ms):
 *   {"device":"GIGA-R1-WIFI","mount_height_cm":25.00,"distance_cm":18.40,"water_depth_cm":6.60,"float_low":true,"float_high":false,"barrier_state":"not_installed","quality":"good","burst_spread_cm":0.18,"valid_pings":5,"uptime_ms":14200}
 *   NOTE: No non-JSON debug text is ever printed to Serial so the FloodGuard
 *         website Web Serial parser and GIGA touchscreen work simultaneously.
 * ============================================================================
 */

#include <math.h>
#include <stdio.h>
#include <string.h>
#include "Arduino_GigaDisplay_GFX.h"

GigaDisplay_GFX display;

// Optional future servo barrier extension (0 = disabled, 1 = enabled)
#define ENABLE_SERVO_BARRIER 0

#if ENABLE_SERVO_BARRIER
  #include <Servo.h>
  Servo floodBarrierServo;
  const int SERVO_PIN = 5;
  const int BARRIER_OPEN_ANGLE = 0;
  const int BARRIER_CLOSED_ANGLE = 90;
  const float BARRIER_TRIGGER_CM = 10.0f;
#endif

// ============================================================================
// 1. PRESERVED HARDWARE PIN ASSIGNMENTS (DO NOT CHANGE)
// ============================================================================
const int TRIG_PIN = 9;        // HC-SR04 TRIG -> D9
const int ECHO_PIN = 10;       // HC-SR04 ECHO -> 470 Ohm + 470 Ohm -> D10 -> 1 kOhm -> GND
const int FLOAT_LOW_PIN = 6;   // LOW float switch -> D6 and GND (INPUT_PULLUP)
const int FLOAT_HIGH_PIN = 7;  // HIGH float switch -> D7 and GND (INPUT_PULLUP)

// ============================================================================
// 2. LOCAL CALIBRATION & THRESHOLD CONSTANTS (STANDALONE — NO WI-FI/SUPABASE)
// ============================================================================
const float MOUNT_HEIGHT_CM = 25.0f;         // Distance from sensor face to dry street floor (cm)
const float WARN_THRESHOLD_CM = 5.0f;        // Local Warning threshold (matches confirmed 5 cm)
const float CRIT_THRESHOLD_CM = 12.0f;       // Local Critical threshold (matches confirmed 12 cm)

// Measurement validation & statistical trend rules (aligned with website floodAnalytics.js)
const float MIN_VALID_DIST_CM = 2.0f;        // HC-SR04 minimum sensing distance
const float DRY_TOLERANCE_CM = 2.0f;         // Acoustic tolerance beyond dry floor before out-of-range
const float MAX_GOOD_SPREAD_CM = 2.5f;       // Max 5-ping burst spread for "Good" quality
const float SPIKE_JUMP_CM = 3.0f;            // Single-frame jump threshold vs. recent median
const float MIN_RISE_RATE_CM_PER_MIN = 0.25f;// Minimum reliable slope (cm/min)
const float STABLE_BAND_CM_PER_MIN = 0.20f;  // Deadband (±cm/min) for Stable classification
const float MIN_NET_DELTA_CM = 0.25f;        // Minimum net depth change across window
const float MAX_GOOD_RESIDUAL_STD_CM = 0.45f;// Max regression residual std dev for "Good" quality
const float MAX_GOOD_RAW_NOISE_CM = 0.75f;   // Max detrended raw noise std dev for "Good" quality
const float MIN_RELIABLE_R2 = 0.65f;         // Minimum R^2 for Rising / Falling classification
const float MIN_RELIABLE_TSTAT = 2.5f;       // Minimum |t|-statistic for Rising / Falling

// Sampling configuration
const unsigned long REPORT_INTERVAL_MS = 1000;
const int BURST_SAMPLES = 5;
const unsigned long ECHO_TIMEOUT_US = 25000; // ~4.2 m ultrasonic timeout

// ============================================================================
// 3. DISPLAY PALETTE (RGB565 — DARK NAVY SCIENTIFIC DASHBOARD, 800 x 480)
// ============================================================================
const uint16_t COL_BG_NAVY      = 0x08C5; // #0A192F dark navy background
const uint16_t COL_HEADER_BG    = 0x0084; // #061020 header bar
const uint16_t COL_CARD_BG      = 0x1108; // #112240 card surface
const uint16_t COL_CARD_BORDER  = 0x220C; // #264166 crisp slate-blue border
const uint16_t COL_WHITE        = 0xFFFF; // #FFFFFF primary text
const uint16_t COL_MUTED        = 0x9517; // #94A3B8 labels & subtitles
const uint16_t COL_CYAN         = 0x269D; // #22D3EE telemetry accent
const uint16_t COL_GREEN        = 0x262B; // #22C55E NORMAL / Good
const uint16_t COL_GREEN_BG     = 0x09C4; // #0D3B22 NORMAL banner fill
const uint16_t COL_ORANGE       = 0xFB82; // #F97316 WARNING / Unstable / Rising
const uint16_t COL_ORANGE_BG    = 0x4901; // #4A2108 WARNING banner fill
const uint16_t COL_RED          = 0xEA28; // #EF4444 CRITICAL / Out of Range
const uint16_t COL_RED_BG       = 0x4882; // #4C1116 CRITICAL / No Reading banner fill
const uint16_t COL_YELLOW       = 0xFE62; // #FACC15 Uncertain

// ============================================================================
// 4. TELEMETRY DATA STRUCTURES & ROLLING HISTORY STATE
// ============================================================================
struct BurstResult {
  float medianCm;
  float spreadCm;
  int validCount;
};

struct CleanSample {
  unsigned long timestampMs;
  float rawDistanceCm;
  float rawDepthCm;
  float filteredDistanceCm;
  float filteredDepthCm;
  uint8_t filterWindowSize;
};

struct TrendStats {
  float slopeCmPerMin;
  float rSquared;
  float residualStdCm;
  float tStat;
  float spanSec;
  float netDeltaCm;
};

enum QualityCode {
  QUAL_GOOD = 0,
  QUAL_UNSTABLE = 1,
  QUAL_OUT_OF_RANGE = 2
};

enum FloodStatusCode {
  STAT_NO_READING = 0,
  STAT_NORMAL = 1,
  STAT_WARNING = 2,
  STAT_CRITICAL = 3
};

enum TrendCode {
  TREND_UNCERTAIN = 0,
  TREND_STABLE = 1,
  TREND_RISING = 2,
  TREND_FALLING = 3
};

struct LocalDashboardState {
  bool hasValidReading;
  float filteredDepthCm;
  float filteredDistanceCm;
  float rawDistanceCm;
  bool rawIsTimeout;
  bool rawIsSpike;
  FloodStatusCode floodStatus;
  QualityCode quality;
  TrendCode trend;
  bool hasRate;
  float rateCmPerMin;
  bool etaAvailable;
  bool etaReached;
  long etaCritSeconds;
  int validPings;
  float burstSpreadCm;
  bool floatLow;
  bool floatHigh;
};

const int HISTORY_CAPACITY = 12;
CleanSample historyBuf[HISTORY_CAPACITY];
int historyCount = 0;

// Recent packet event ring (last 8 packets) for spike / out-of-range counting
const int EVENT_WINDOW = 8;
uint8_t recentEvents[EVENT_WINDOW]; // 0 = clean, 1 = spike, 2 = out_of_range
int recentEventIdx = 0;
int recentEventCount = 0;

int consecutiveOutOfRange = 0;
bool hasPendingJump = false;
float pendingJumpDistanceCm = 0.0f;

unsigned long lastReportMs = 0;

// Cached rendered strings/colors to avoid unnecessary redraws & flickering
struct DisplayCache {
  bool initialized;
  char depthMain[24];
  char depthSub[48];
  uint16_t depthColor;

  char statusText[20];
  uint16_t statusBg;
  uint16_t statusFg;

  char trendMain[20];
  char trendSub[28];
  uint16_t trendColor;

  char etaMain[24];
  char etaSub[28];
  uint16_t etaColor;

  char qualMain[20];
  char qualSub[28];
  uint16_t qualColor;

  char footerText[72];
};

DisplayCache uiCache = { false, "", "", 0, "", 0, 0, "", "", 0, "", "", 0, "", "", 0, "" };

// ============================================================================
// 5. ULTRASONIC SENSOR MEASUREMENT (5-PING MEDIAN + BURST SPREAD)
// ============================================================================
float measureSingleDistanceCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(3);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  unsigned long durationUs = pulseIn(ECHO_PIN, HIGH, ECHO_TIMEOUT_US);
  if (durationUs == 0) {
    return -1.0f; // Echo timeout
  }

  // Speed of sound at ~20C: 0.0343 cm/us (divide by 2 for round-trip)
  float distCm = (durationUs * 0.0343f) / 2.0f;

  // Reject echoes beyond HC-SR04 physical maximum range (400 cm) as timeout;
  // readings below MIN_VALID_DIST_CM (2.0 cm) are kept so loop() explicitly flags out_of_range
  if (distCm > 400.0f) {
    return -1.0f;
  }
  return distCm;
}

BurstResult measureBurstDistanceCm() {
  float readings[BURST_SAMPLES];
  int validCount = 0;

  for (int i = 0; i < BURST_SAMPLES; i++) {
    float d = measureSingleDistanceCm();
    if (d > 0.0f) {
      readings[validCount++] = d;
    }
    delay(35); // Wait for ultrasonic echoes to dissipate between pings
  }

  BurstResult res;
  res.validCount = validCount;
  res.medianCm = -1.0f;
  res.spreadCm = 0.0f;

  if (validCount == 0) {
    return res;
  }

  // Insertion sort to compute median and burst spread (max - min)
  for (int i = 1; i < validCount; i++) {
    float key = readings[i];
    int j = i - 1;
    while (j >= 0 && readings[j] > key) {
      readings[j + 1] = readings[j];
      j--;
    }
    readings[j + 1] = key;
  }

  res.spreadCm = readings[validCount - 1] - readings[0];
  int mid = validCount / 2;
  if (validCount % 2 == 1) {
    res.medianCm = readings[mid];
  } else {
    res.medianCm = (readings[mid - 1] + readings[mid]) / 2.0f;
  }
  return res;
}

// ============================================================================
// 6. LOCAL FILTERING, SPIKE REJECTION, REGRESSION TREND & CONSERVATIVE ETA
// ============================================================================
float medianOfArray(const float* src, int count) {
  float tmp[5];
  if (count <= 0) return 0.0f;
  if (count > 5) count = 5;
  for (int i = 0; i < count; i++) tmp[i] = src[i];
  for (int i = 1; i < count; i++) {
    float key = tmp[i];
    int j = i - 1;
    while (j >= 0 && tmp[j] > key) {
      tmp[j + 1] = tmp[j];
      j--;
    }
    tmp[j + 1] = key;
  }
  int mid = count / 2;
  if (count % 2 == 1) return tmp[mid];
  return (tmp[mid - 1] + tmp[mid]) / 2.0f;
}

void recordRecentEvent(uint8_t code) {
  recentEvents[recentEventIdx] = code;
  recentEventIdx = (recentEventIdx + 1) % EVENT_WINDOW;
  if (recentEventCount < EVENT_WINDOW) recentEventCount++;
}

void countRecentEvents(int& spikeCount, int& outOfRangeCount) {
  spikeCount = 0;
  outOfRangeCount = 0;
  for (int i = 0; i < recentEventCount; i++) {
    if (recentEvents[i] == 1) spikeCount++;
    else if (recentEvents[i] == 2) outOfRangeCount++;
  }
}

void pushCleanSample(const CleanSample& s) {
  if (historyCount < HISTORY_CAPACITY) {
    historyBuf[historyCount++] = s;
  } else {
    for (int i = 1; i < HISTORY_CAPACITY; i++) {
      historyBuf[i - 1] = historyBuf[i];
    }
    historyBuf[HISTORY_CAPACITY - 1] = s;
  }
}

TrendStats computeOlsTrend(const CleanSample* arr, int n, bool useRawDepth) {
  TrendStats st = { 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f };
  if (n < 3) return st;

  unsigned long t0 = arr[0].timestampMs;
  unsigned long tLast = arr[n - 1].timestampMs;
  if (tLast <= t0) return st;

  st.spanSec = (float)(tLast - t0) / 1000.0f;
  float yFirst = useRawDepth ? arr[0].rawDepthCm : arr[0].filteredDepthCm;
  float yLast = useRawDepth ? arr[n - 1].rawDepthCm : arr[n - 1].filteredDepthCm;
  st.netDeltaCm = yLast - yFirst;

  if (st.spanSec < 1.5f) return st;

  float meanX = 0.0f;
  float meanY = 0.0f;
  for (int i = 0; i < n; i++) {
    float x = (float)(arr[i].timestampMs - t0) / 60000.0f; // minutes
    float y = useRawDepth ? arr[i].rawDepthCm : arr[i].filteredDepthCm;
    meanX += x;
    meanY += y;
  }
  meanX /= (float)n;
  meanY /= (float)n;

  float sxx = 0.0f;
  float sxy = 0.0f;
  float syy = 0.0f;
  for (int i = 0; i < n; i++) {
    float dx = ((float)(arr[i].timestampMs - t0) / 60000.0f) - meanX;
    float dy = (useRawDepth ? arr[i].rawDepthCm : arr[i].filteredDepthCm) - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }

  if (sxx <= 1e-9f) return st;

  float slope = sxy / sxx;
  float intercept = meanY - slope * meanX;

  float sse = 0.0f;
  for (int i = 0; i < n; i++) {
    float x = (float)(arr[i].timestampMs - t0) / 60000.0f;
    float y = useRawDepth ? arr[i].rawDepthCm : arr[i].filteredDepthCm;
    float err = y - (intercept + slope * x);
    sse += err * err;
  }

  float dof = (float)((n - 2) > 1 ? (n - 2) : 1);
  float residualVar = sse / dof;
  if (residualVar < 0.0f) residualVar = 0.0f;

  st.residualStdCm = sqrtf(residualVar);
  float seSlope = sqrtf(residualVar / sxx);
  float tVal = (seSlope > 1e-9f) ? (fabsf(slope) / seSlope) : (fabsf(slope) > 0.0f ? 99.0f : 0.0f);
  if (tVal > 99.0f) tVal = 99.0f;

  float r2 = 0.0f;
  if (syy > 1e-6f) {
    r2 = 1.0f - (sse / syy);
    if (r2 < 0.0f) r2 = 0.0f;
    if (r2 > 1.0f) r2 = 1.0f;
  }

  st.slopeCmPerMin = slope;
  st.rSquared = r2;
  st.tStat = tVal;
  return st;
}

LocalDashboardState evaluateLocalDashboard(
  unsigned long nowMs,
  const BurstResult& burst,
  bool isTimeout,
  bool isOutOfRange,
  bool floatLow,
  bool floatHigh
) {
  LocalDashboardState state;
  state.hasValidReading = false;
  state.filteredDepthCm = 0.0f;
  state.filteredDistanceCm = 0.0f;
  state.rawDistanceCm = isTimeout ? -1.0f : burst.medianCm;
  state.rawIsTimeout = isTimeout;
  state.rawIsSpike = false;
  state.floodStatus = STAT_NO_READING;
  state.quality = QUAL_OUT_OF_RANGE;
  state.trend = TREND_UNCERTAIN;
  state.hasRate = false;
  state.rateCmPerMin = 0.0f;
  state.etaAvailable = false;
  state.etaReached = false;
  state.etaCritSeconds = -1;
  state.validPings = burst.validCount;
  state.burstSpreadCm = burst.spreadCm;
  state.floatLow = floatLow;
  state.floatHigh = floatHigh;

  bool frameInvalid = isTimeout || isOutOfRange;
  bool isSpike = false;

  if (frameInvalid) {
    consecutiveOutOfRange++;
    hasPendingJump = false;
    recordRecentEvent(2);
  } else {
    consecutiveOutOfRange = 0;

    // Isolated spike check against trailing median (once >= 3 clean samples exist)
    if (historyCount >= 3) {
      int refCount = historyCount >= 5 ? 5 : historyCount;
      float refDists[5];
      for (int i = 0; i < refCount; i++) {
        refDists[i] = historyBuf[historyCount - refCount + i].rawDistanceCm;
      }
      float refMed = medianOfArray(refDists, refCount);
      float jump = fabsf(burst.medianCm - refMed);

      if (jump > SPIKE_JUMP_CM) {
        if (hasPendingJump && fabsf(burst.medianCm - pendingJumpDistanceCm) <= (SPIKE_JUMP_CM * 0.6f)) {
          // Confirmed sustained shift by 2 consecutive consistent readings:
          // reset the old rolling baseline so subsequent readings at the new level are accepted cleanly
          hasPendingJump = false;
          historyCount = 0;
        } else {
          isSpike = true;
          hasPendingJump = true;
          pendingJumpDistanceCm = burst.medianCm;
        }
      } else {
        hasPendingJump = false;
      }
    }

    if (isSpike) {
      state.rawIsSpike = true;
      recordRecentEvent(1);
    } else {
      recordRecentEvent(0);

      // Causal 3-sample trailing median on clean distances (1-sample lag, zero 2-sample averaging artifact)
      float winDists[3];
      uint8_t winSize = 1;
      if (historyCount >= 2) {
        winDists[0] = historyBuf[historyCount - 2].rawDistanceCm;
        winDists[1] = historyBuf[historyCount - 1].rawDistanceCm;
        winDists[2] = burst.medianCm;
        winSize = 3;
      } else {
        winDists[0] = burst.medianCm;
        winSize = 1;
      }

      float filteredDist = medianOfArray(winDists, winSize);
      float rawDepth = MOUNT_HEIGHT_CM - burst.medianCm;
      if (rawDepth < 0.0f) rawDepth = 0.0f;
      float filteredDepth = MOUNT_HEIGHT_CM - filteredDist;
      if (filteredDepth < 0.0f) filteredDepth = 0.0f;

      CleanSample cs;
      cs.timestampMs = nowMs;
      cs.rawDistanceCm = burst.medianCm;
      cs.rawDepthCm = rawDepth;
      cs.filteredDistanceCm = filteredDist;
      cs.filteredDepthCm = filteredDepth;
      cs.filterWindowSize = winSize;
      pushCleanSample(cs);
    }
  }

  // Never show 0 cm if no valid samples exist or >= 2 consecutive out-of-range frames occurred
  if (historyCount == 0 || consecutiveOutOfRange >= 2) {
    state.hasValidReading = false;
    state.floodStatus = STAT_NO_READING;
    state.quality = QUAL_OUT_OF_RANGE;
    state.trend = TREND_UNCERTAIN;
    return state;
  }

  // Use latest clean filtered values (mathematically consistent: Depth = Mount - Filtered Dist)
  const CleanSample& latestClean = historyBuf[historyCount - 1];
  state.hasValidReading = true;
  state.filteredDistanceCm = latestClean.filteredDistanceCm;
  state.filteredDepthCm = latestClean.filteredDepthCm;

  // Build stabilized rolling window (skip initial 2 warm-up samples with winSize=1 once >= 7 exist)
  CleanSample regWindow[HISTORY_CAPACITY];
  int regCount = 0;
  if (historyCount >= 7) {
    for (int i = 0; i < historyCount; i++) {
      if (historyBuf[i].filterWindowSize == 3) {
        regWindow[regCount++] = historyBuf[i];
      }
    }
  }
  if (regCount < 5) {
    regCount = historyCount;
    for (int i = 0; i < historyCount; i++) regWindow[i] = historyBuf[i];
  }
  if (regCount > 10) {
    int shift = regCount - 10;
    for (int i = 0; i < 10; i++) regWindow[i] = regWindow[i + shift];
    regCount = 10;
  }

  TrendStats stats = computeOlsTrend(regWindow, regCount, false);
  TrendStats rawNoiseStats = computeOlsTrend(regWindow, regCount, true);

  int recentSpikes = 0;
  int recentOutOfRange = 0;
  countRecentEvents(recentSpikes, recentOutOfRange);

  // Determine Sensor Quality: Good | Unstable | Out of Range
  if (frameInvalid) {
    state.quality = QUAL_OUT_OF_RANGE;
  } else if (
    isSpike ||
    burst.validCount < 3 ||
    burst.spreadCm > MAX_GOOD_SPREAD_CM ||
    recentSpikes >= 2 ||
    recentOutOfRange >= 2 ||
    stats.residualStdCm > MAX_GOOD_RESIDUAL_STD_CM ||
    rawNoiseStats.residualStdCm > MAX_GOOD_RAW_NOISE_CM
  ) {
    state.quality = QUAL_UNSTABLE;
  } else {
    state.quality = QUAL_GOOD;
  }

  // Flood Status Level from trusted filtered depth
  if (state.filteredDepthCm >= CRIT_THRESHOLD_CM) {
    state.floodStatus = STAT_CRITICAL;
  } else if (state.filteredDepthCm >= WARN_THRESHOLD_CM) {
    state.floodStatus = STAT_WARNING;
  } else {
    state.floodStatus = STAT_NORMAL;
  }

  // Statistically reliable Trend & conservative Time to Critical
  bool enoughData = (regCount >= 5) && (stats.spanSec >= 4.0f);
  bool reliableRise = false;

  if (state.quality == QUAL_GOOD && enoughData) {
    state.hasRate = true;
    state.rateCmPerMin = stats.slopeCmPerMin;

    bool statReliable = (stats.rSquared >= MIN_RELIABLE_R2) && (stats.tStat >= MIN_RELIABLE_TSTAT);
    if (stats.slopeCmPerMin >= MIN_RISE_RATE_CM_PER_MIN &&
        stats.netDeltaCm >= MIN_NET_DELTA_CM &&
        statReliable) {
      state.trend = TREND_RISING;
      reliableRise = true;
    } else if (stats.slopeCmPerMin <= -MIN_RISE_RATE_CM_PER_MIN &&
               stats.netDeltaCm <= -MIN_NET_DELTA_CM &&
               statReliable) {
      state.trend = TREND_FALLING;
    } else if (fabsf(stats.slopeCmPerMin) < STABLE_BAND_CM_PER_MIN &&
               fabsf(stats.netDeltaCm) < MIN_NET_DELTA_CM &&
               stats.residualStdCm <= 0.35f) {
      state.trend = TREND_STABLE;
    } else {
      state.trend = TREND_UNCERTAIN;
    }
  } else {
    state.trend = TREND_UNCERTAIN;
    state.hasRate = false;
  }

  // Time to Critical ETA — ONLY when Sensor Quality is Good and rise is sustained & reliable
  if (state.quality == QUAL_GOOD && state.filteredDepthCm >= CRIT_THRESHOLD_CM) {
    state.etaAvailable = true;
    state.etaReached = true;
    state.etaCritSeconds = 0;
  } else if (state.quality == QUAL_GOOD && reliableRise && stats.slopeCmPerMin > 0.0f) {
    float remainingCm = CRIT_THRESHOLD_CM - state.filteredDepthCm;
    float secToCrit = (remainingCm / stats.slopeCmPerMin) * 60.0f;
    if (isfinite(secToCrit) && secToCrit >= 0.0f && secToCrit <= 86400.0f) {
      state.etaAvailable = true;
      state.etaReached = false;
      state.etaCritSeconds = (long)(secToCrit + 0.5f);
    }
  }

  return state;
}

// ============================================================================
// 7. ARDUINO GIGA DISPLAY SHIELD DASHBOARD (800 x 480 LANDSCAPE, FLICKER-FREE)
// ============================================================================
// Deterministic fixed-point formatters (avoids Mbed minimal-printf %f quirks)
void formatFixed1(float val, char* outBuf, size_t outSize, bool forcePlus = false) {
  long tenths = (long)lroundf(val * 10.0f);
  const char* sign = "";
  if (tenths < 0) {
    sign = "-";
    tenths = -tenths;
  } else if (forcePlus && tenths > 0) {
    sign = "+";
  }
  snprintf(outBuf, outSize, "%s%ld.%ld", sign, tenths / 10L, tenths % 10L);
}

void formatFixed2(float val, char* outBuf, size_t outSize, bool forcePlus = false) {
  long hundredths = (long)lroundf(val * 100.0f);
  const char* sign = "";
  if (hundredths < 0) {
    sign = "-";
    hundredths = -hundredths;
  } else if (forcePlus && hundredths > 0) {
    sign = "+";
  }
  snprintf(outBuf, outSize, "%s%ld.%02ld", sign, hundredths / 100L, hundredths % 100L);
}

void formatEtaText(long seconds, char* outBuf, size_t outSize) {
  if (seconds < 0) {
    snprintf(outBuf, outSize, "Not available");
    return;
  }
  if (seconds < 60) {
    snprintf(outBuf, outSize, "~%ld sec", seconds);
  } else if (seconds < 3600) {
    long mins = seconds / 60;
    long remSec = seconds % 60;
    if (remSec > 0) snprintf(outBuf, outSize, "~%ldm %lds", mins, remSec);
    else snprintf(outBuf, outSize, "~%ld min", mins);
  } else {
    long hrs = seconds / 3600;
    long remMins = (seconds % 3600) / 60;
    if (hrs > 24) snprintf(outBuf, outSize, "> 24 hr");
    else if (remMins > 0) snprintf(outBuf, outSize, "~%ldh %ldm", hrs, remMins);
    else snprintf(outBuf, outSize, "~%ld hr", hrs);
  }
}

void drawStaticDashboardLayout() {
  display.fillScreen(COL_BG_NAVY);
  display.setTextWrap(false);

  // Top Header Bar (800 x 56)
  display.fillRect(0, 0, 800, 56, COL_HEADER_BG);
  display.drawFastHLine(0, 56, 800, COL_CYAN);

  display.setTextColor(COL_WHITE);
  display.setTextSize(3);
  display.setCursor(24, 16);
  display.print("NYC FLOODGUARD");

  display.setTextColor(COL_CYAN);
  display.setTextSize(2);
  display.setCursor(496, 20);
  display.print("LOCAL TOUCHSCREEN");

  // Row 1 — Card 1: WATER LEVEL (x=24, y=74, w=368, h=170)
  display.fillRoundRect(24, 74, 368, 170, 10, COL_CARD_BG);
  display.drawRoundRect(24, 74, 368, 170, 10, COL_CARD_BORDER);
  display.setTextColor(COL_MUTED);
  display.setTextSize(2);
  display.setCursor(44, 90);
  display.print("WATER LEVEL");

  // Row 1 — Card 2: FLOOD STATUS (x=408, y=74, w=368, h=170)
  display.fillRoundRect(408, 74, 368, 170, 10, COL_CARD_BG);
  display.drawRoundRect(408, 74, 368, 170, 10, COL_CARD_BORDER);
  display.setTextColor(COL_MUTED);
  display.setTextSize(2);
  display.setCursor(428, 90);
  display.print("FLOOD STATUS");

  char warnStr[12], critStr[12], threshLine[48];
  formatFixed1(WARN_THRESHOLD_CM, warnStr, sizeof(warnStr));
  formatFixed1(CRIT_THRESHOLD_CM, critStr, sizeof(critStr));
  snprintf(threshLine, sizeof(threshLine), "Warn %scm | Crit %scm", warnStr, critStr);
  display.setTextColor(COL_MUTED);
  display.setTextSize(2);
  display.setCursor(428, 210);
  display.print(threshLine);

  // Row 2 — Card 3: WATER TREND (x=24, y=262, w=240, h=152)
  display.fillRoundRect(24, 262, 240, 152, 10, COL_CARD_BG);
  display.drawRoundRect(24, 262, 240, 152, 10, COL_CARD_BORDER);
  display.setTextColor(COL_MUTED);
  display.setTextSize(2);
  display.setCursor(40, 278);
  display.print("WATER TREND");

  // Row 2 — Card 4: TIME TO CRITICAL (x=280, y=262, w=240, h=152)
  display.fillRoundRect(280, 262, 240, 152, 10, COL_CARD_BG);
  display.drawRoundRect(280, 262, 240, 152, 10, COL_CARD_BORDER);
  display.setTextColor(COL_MUTED);
  display.setTextSize(2);
  display.setCursor(294, 278);
  display.print("TIME TO CRITICAL");

  // Row 2 — Card 5: SENSOR QUALITY (x=536, y=262, w=240, h=152)
  display.fillRoundRect(536, 262, 240, 152, 10, COL_CARD_BG);
  display.drawRoundRect(536, 262, 240, 152, 10, COL_CARD_BORDER);
  display.setTextColor(COL_MUTED);
  display.setTextSize(2);
  display.setCursor(552, 278);
  display.print("SENSOR QUALITY");

  // Bottom Hardware Strip (x=24, y=430, w=752, h=36)
  display.fillRoundRect(24, 430, 752, 36, 6, COL_HEADER_BG);
  display.drawRoundRect(24, 430, 752, 36, 6, COL_CARD_BORDER);

  uiCache.initialized = true;
}

void updateDisplayDashboard(const LocalDashboardState& st) {
  if (!uiCache.initialized) {
    drawStaticDashboardLayout();
  }

  // --- 1. WATER LEVEL CARD ---
  char depthMain[24];
  char depthSub[48];
  uint16_t depthColor = COL_WHITE;

  if (!st.hasValidReading) {
    snprintf(depthMain, sizeof(depthMain), "NO READING");
    depthColor = COL_RED;
    if (st.rawIsTimeout) {
      snprintf(depthSub, sizeof(depthSub), "Ultrasonic echo timeout");
    } else if (st.rawDistanceCm > 0.0f) {
      char rawStr[12];
      formatFixed1(st.rawDistanceCm, rawStr, sizeof(rawStr));
      snprintf(depthSub, sizeof(depthSub), "Out of range (%s cm)", rawStr);
    } else {
      snprintf(depthSub, sizeof(depthSub), "Waiting for valid echo");
    }
  } else {
    char depthStr[12];
    formatFixed2(st.filteredDepthCm, depthStr, sizeof(depthStr));
    snprintf(depthMain, sizeof(depthMain), "%s cm", depthStr);
    depthColor = (st.floodStatus == STAT_CRITICAL) ? COL_RED
               : (st.floodStatus == STAT_WARNING)  ? COL_ORANGE
                                                   : COL_WHITE;
    if (st.rawIsSpike) {
      char rawStr[12];
      formatFixed1(st.rawDistanceCm, rawStr, sizeof(rawStr));
      snprintf(depthSub, sizeof(depthSub), "Spike rejected (%s cm)", rawStr);
    } else {
      char mStr[12], fDistStr[12], fDepthStr[12];
      formatFixed1(MOUNT_HEIGHT_CM, mStr, sizeof(mStr));
      formatFixed1(st.filteredDistanceCm, fDistStr, sizeof(fDistStr));
      formatFixed1(st.filteredDepthCm, fDepthStr, sizeof(fDepthStr));
      snprintf(depthSub, sizeof(depthSub), "%s - %s = %s cm", mStr, fDistStr, fDepthStr);
    }
  }

  if (strcmp(depthMain, uiCache.depthMain) != 0 ||
      strcmp(depthSub, uiCache.depthSub) != 0 ||
      depthColor != uiCache.depthColor) {
    display.fillRect(36, 120, 344, 114, COL_CARD_BG);
    display.setTextColor(depthColor);
    if (!st.hasValidReading) {
      display.setTextSize(5);
      display.setCursor(44, 134);
    } else {
      display.setTextSize(6);
      display.setCursor(44, 128);
    }
    display.print(depthMain);

    display.setTextColor(st.hasValidReading ? COL_MUTED : COL_ORANGE);
    display.setTextSize(2);
    display.setCursor(44, 206);
    display.print(depthSub);

    strncpy(uiCache.depthMain, depthMain, sizeof(uiCache.depthMain) - 1);
    uiCache.depthMain[sizeof(uiCache.depthMain) - 1] = '\0';
    strncpy(uiCache.depthSub, depthSub, sizeof(uiCache.depthSub) - 1);
    uiCache.depthSub[sizeof(uiCache.depthSub) - 1] = '\0';
    uiCache.depthColor = depthColor;
  }

  // --- 2. FLOOD STATUS CARD ---
  char statusText[20];
  uint16_t statusBg = COL_RED_BG;
  uint16_t statusFg = COL_RED;

  if (st.floodStatus == STAT_NORMAL) {
    snprintf(statusText, sizeof(statusText), "NORMAL");
    statusBg = COL_GREEN_BG;
    statusFg = COL_GREEN;
  } else if (st.floodStatus == STAT_WARNING) {
    snprintf(statusText, sizeof(statusText), "WARNING");
    statusBg = COL_ORANGE_BG;
    statusFg = COL_ORANGE;
  } else if (st.floodStatus == STAT_CRITICAL) {
    snprintf(statusText, sizeof(statusText), "CRITICAL");
    statusBg = COL_RED_BG;
    statusFg = COL_RED;
  } else {
    snprintf(statusText, sizeof(statusText), "NO READING");
    statusBg = COL_RED_BG;
    statusFg = COL_RED;
  }

  if (strcmp(statusText, uiCache.statusText) != 0 || statusBg != uiCache.statusBg) {
    display.fillRoundRect(424, 120, 336, 76, 8, statusBg);
    display.drawRoundRect(424, 120, 336, 76, 8, statusFg);
    display.setTextColor(statusFg);
    display.setTextSize(5);
    int textLen = (int)strlen(statusText);
    int textPx = textLen * 30;
    int textX = 424 + (336 - textPx) / 2;
    if (textX < 430) textX = 430;
    display.setCursor(textX, 138);
    display.print(statusText);

    strncpy(uiCache.statusText, statusText, sizeof(uiCache.statusText) - 1);
    uiCache.statusText[sizeof(uiCache.statusText) - 1] = '\0';
    uiCache.statusBg = statusBg;
    uiCache.statusFg = statusFg;
  }

  // --- 3. WATER TREND CARD ---
  char trendMain[20];
  char trendSub[28];
  uint16_t trendColor = COL_YELLOW;

  if (st.trend == TREND_RISING) {
    snprintf(trendMain, sizeof(trendMain), "Rising");
    trendColor = COL_ORANGE;
  } else if (st.trend == TREND_FALLING) {
    snprintf(trendMain, sizeof(trendMain), "Falling");
    trendColor = COL_CYAN;
  } else if (st.trend == TREND_STABLE) {
    snprintf(trendMain, sizeof(trendMain), "Stable");
    trendColor = COL_GREEN;
  } else {
    snprintf(trendMain, sizeof(trendMain), "Uncertain");
    trendColor = COL_YELLOW;
  }

  if (st.hasRate) {
    char rateStr[14];
    formatFixed2(st.rateCmPerMin, rateStr, sizeof(rateStr), true);
    snprintf(trendSub, sizeof(trendSub), "%s cm/min", rateStr);
  } else if (st.quality == QUAL_OUT_OF_RANGE) {
    snprintf(trendSub, sizeof(trendSub), "Sensor invalid");
  } else if (st.quality == QUAL_UNSTABLE) {
    snprintf(trendSub, sizeof(trendSub), "Signal noisy");
  } else {
    snprintf(trendSub, sizeof(trendSub), "Collecting...");
  }

  if (strcmp(trendMain, uiCache.trendMain) != 0 ||
      strcmp(trendSub, uiCache.trendSub) != 0 ||
      trendColor != uiCache.trendColor) {
    display.fillRect(34, 308, 220, 94, COL_CARD_BG);
    display.setTextColor(trendColor);
    display.setTextSize(3);
    display.setCursor(40, 316);
    display.print(trendMain);

    display.setTextColor(COL_MUTED);
    display.setTextSize(2);
    display.setCursor(40, 368);
    display.print(trendSub);

    strncpy(uiCache.trendMain, trendMain, sizeof(uiCache.trendMain) - 1);
    uiCache.trendMain[sizeof(uiCache.trendMain) - 1] = '\0';
    strncpy(uiCache.trendSub, trendSub, sizeof(uiCache.trendSub) - 1);
    uiCache.trendSub[sizeof(uiCache.trendSub) - 1] = '\0';
    uiCache.trendColor = trendColor;
  }

  // --- 4. TIME TO CRITICAL CARD ---
  char etaMain[24];
  char etaSub[28];
  uint16_t etaColor = COL_MUTED;

  char critValStr[12];
  formatFixed1(CRIT_THRESHOLD_CM, critValStr, sizeof(critValStr));

  if (st.etaAvailable && st.etaReached) {
    snprintf(etaMain, sizeof(etaMain), "REACHED");
    snprintf(etaSub, sizeof(etaSub), ">= %s cm now", critValStr);
    etaColor = COL_RED;
  } else if (st.etaAvailable && st.etaCritSeconds >= 0) {
    formatEtaText(st.etaCritSeconds, etaMain, sizeof(etaMain));
    snprintf(etaSub, sizeof(etaSub), "Estimate only");
    etaColor = COL_ORANGE;
  } else {
    snprintf(etaMain, sizeof(etaMain), "Not available");
    snprintf(etaSub, sizeof(etaSub), "Crit >= %s cm", critValStr);
    etaColor = COL_MUTED;
  }

  if (strcmp(etaMain, uiCache.etaMain) != 0 ||
      strcmp(etaSub, uiCache.etaSub) != 0 ||
      etaColor != uiCache.etaColor) {
    display.fillRect(290, 308, 220, 94, COL_CARD_BG);
    display.setTextColor(etaColor);
    if (strlen(etaMain) <= 10) {
      display.setTextSize(3);
      display.setCursor(294, 316);
    } else {
      display.setTextSize(2);
      display.setCursor(294, 322);
    }
    display.print(etaMain);

    display.setTextColor(COL_MUTED);
    display.setTextSize(2);
    display.setCursor(294, 368);
    display.print(etaSub);

    strncpy(uiCache.etaMain, etaMain, sizeof(uiCache.etaMain) - 1);
    uiCache.etaMain[sizeof(uiCache.etaMain) - 1] = '\0';
    strncpy(uiCache.etaSub, etaSub, sizeof(uiCache.etaSub) - 1);
    uiCache.etaSub[sizeof(uiCache.etaSub) - 1] = '\0';
    uiCache.etaColor = etaColor;
  }

  // --- 5. SENSOR QUALITY CARD ---
  char qualMain[20];
  char qualSub[28];
  uint16_t qualColor = COL_GREEN;

  if (st.quality == QUAL_GOOD) {
    snprintf(qualMain, sizeof(qualMain), "Good");
    snprintf(qualSub, sizeof(qualSub), "Pings: %d/%d", st.validPings, BURST_SAMPLES);
    qualColor = COL_GREEN;
  } else if (st.quality == QUAL_UNSTABLE) {
    snprintf(qualMain, sizeof(qualMain), "Unstable");
    if (st.rawIsSpike) {
      snprintf(qualSub, sizeof(qualSub), "Spike rejected");
    } else if (st.burstSpreadCm > MAX_GOOD_SPREAD_CM) {
      char spStr[12];
      formatFixed1(st.burstSpreadCm, spStr, sizeof(spStr));
      snprintf(qualSub, sizeof(qualSub), "Spread: %s cm", spStr);
    } else {
      snprintf(qualSub, sizeof(qualSub), "Pings: %d/%d", st.validPings, BURST_SAMPLES);
    }
    qualColor = COL_ORANGE;
  } else {
    snprintf(qualMain, sizeof(qualMain), "Out of Range");
    if (st.rawIsTimeout) {
      snprintf(qualSub, sizeof(qualSub), "Echo timeout");
    } else {
      snprintf(qualSub, sizeof(qualSub), "Check alignment");
    }
    qualColor = COL_RED;
  }

  if (strcmp(qualMain, uiCache.qualMain) != 0 ||
      strcmp(qualSub, uiCache.qualSub) != 0 ||
      qualColor != uiCache.qualColor) {
    display.fillRect(546, 308, 220, 94, COL_CARD_BG);
    display.setTextColor(qualColor);
    if (strlen(qualMain) <= 10) {
      display.setTextSize(3);
      display.setCursor(552, 316);
    } else {
      display.setTextSize(2);
      display.setCursor(552, 322);
    }
    display.print(qualMain);

    display.setTextColor(COL_MUTED);
    display.setTextSize(2);
    display.setCursor(552, 368);
    display.print(qualSub);

    strncpy(uiCache.qualMain, qualMain, sizeof(uiCache.qualMain) - 1);
    uiCache.qualMain[sizeof(uiCache.qualMain) - 1] = '\0';
    strncpy(uiCache.qualSub, qualSub, sizeof(uiCache.qualSub) - 1);
    uiCache.qualSub[sizeof(uiCache.qualSub) - 1] = '\0';
    uiCache.qualColor = qualColor;
  }

  // --- 6. BOTTOM HARDWARE SUMMARY STRIP ---
  char mountStr[12], footerText[72];
  formatFixed1(MOUNT_HEIGHT_CM, mountStr, sizeof(mountStr));
  snprintf(
    footerText,
    sizeof(footerText),
    "Mount:%scm  Float L:%s H:%s  Pumps:MANUAL  USB:115200",
    mountStr,
    st.floatLow ? "WET" : "DRY",
    st.floatHigh ? "WET" : "DRY"
  );

  if (strcmp(footerText, uiCache.footerText) != 0) {
    display.fillRect(32, 434, 736, 28, COL_HEADER_BG);
    display.setTextColor(COL_MUTED);
    display.setTextSize(2);
    display.setCursor(38, 440);
    display.print(footerText);

    strncpy(uiCache.footerText, footerText, sizeof(uiCache.footerText) - 1);
    uiCache.footerText[sizeof(uiCache.footerText) - 1] = '\0';
  }
}

// ============================================================================
// 8. SETUP & MAIN 1-SECOND SENSOR + JSON + DISPLAY LOOP
// ============================================================================
void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(FLOAT_LOW_PIN, INPUT_PULLUP);
  pinMode(FLOAT_HIGH_PIN, INPUT_PULLUP);
  digitalWrite(TRIG_PIN, LOW);

#if ENABLE_SERVO_BARRIER
  floodBarrierServo.attach(SERVO_PIN);
  floodBarrierServo.write(BARRIER_OPEN_ANGLE);
#endif

  // Initialize Arduino GIGA Display Shield in 800 x 480 landscape mode
  display.begin();
  display.setRotation(1);
  drawStaticDashboardLayout();

  // Brief startup delay for USB Serial enumeration
  delay(500);
}

void loop() {
  unsigned long now = millis();
  if (now - lastReportMs < REPORT_INTERVAL_MS) {
    return;
  }
  lastReportMs = now;

  // Float switches wired to GND with INPUT_PULLUP read LOW when closed/triggered
  bool floatLowTriggered = (digitalRead(FLOAT_LOW_PIN) == LOW);
  bool floatHighTriggered = (digitalRead(FLOAT_HIGH_PIN) == LOW);

  BurstResult burst = measureBurstDistanceCm();

  // Case A: Ultrasonic echo timeout (no valid return pulse in 5-ping burst)
  if (burst.validCount == 0 || burst.medianCm < 0.0f) {
    const char* timeoutBarrierState = "not_installed";
#if ENABLE_SERVO_BARRIER
    floodBarrierServo.write(BARRIER_OPEN_ANGLE);
    timeoutBarrierState = "standby";
#endif

    // 1. Emit clean newline-delimited JSON to USB Serial (for FloodGuard website)
    Serial.print("{\"device\":\"GIGA-R1-WIFI\",\"mount_height_cm\":");
    Serial.print(MOUNT_HEIGHT_CM, 2);
    Serial.print(",\"distance_cm\":null,\"water_depth_cm\":null,\"float_low\":");
    Serial.print(floatLowTriggered ? "true" : "false");
    Serial.print(",\"float_high\":");
    Serial.print(floatHighTriggered ? "true" : "false");
    Serial.print(",\"barrier_state\":\"");
    Serial.print(timeoutBarrierState);
    Serial.print("\",\"quality\":\"out_of_range\",\"error\":\"ultrasonic_timeout\",\"valid_pings\":0,\"uptime_ms\":");
    Serial.print(now);
    Serial.println("}");

    // 2. Update local GIGA Display Shield from the exact same reading
    LocalDashboardState dashState = evaluateLocalDashboard(
      now, burst, true, true, floatLowTriggered, floatHighTriggered
    );
    updateDisplayDashboard(dashState);
    return;
  }

  // Case B: Valid echo burst received — check physical range and burst quality
  float distanceCm = burst.medianCm;
  bool isOutOfRange = (distanceCm < MIN_VALID_DIST_CM) || (distanceCm > (MOUNT_HEIGHT_CM + DRY_TOLERANCE_CM));

  const char* quality = "good";
  if (isOutOfRange) {
    quality = "out_of_range";
  } else if (burst.validCount < 3 || burst.spreadCm > MAX_GOOD_SPREAD_CM) {
    quality = "unstable";
  }

  float waterDepthCm = MOUNT_HEIGHT_CM - distanceCm;
  if (!isOutOfRange && waterDepthCm < 0.0f) {
    // Only clamp tiny dry-floor jitter within DRY_TOLERANCE_CM to 0.0 cm
    waterDepthCm = 0.0f;
  }

  const char* barrierState = "not_installed";
#if ENABLE_SERVO_BARRIER
  if (!isOutOfRange && waterDepthCm >= BARRIER_TRIGGER_CM) {
    floodBarrierServo.write(BARRIER_CLOSED_ANGLE);
    barrierState = "deployed";
  } else {
    floodBarrierServo.write(BARRIER_OPEN_ANGLE);
    barrierState = "standby";
  }
#endif

  // 1. Emit single-line JSON for NYC FloodGuard Web Serial receiver (zero debug text)
  Serial.print("{\"device\":\"GIGA-R1-WIFI\",\"mount_height_cm\":");
  Serial.print(MOUNT_HEIGHT_CM, 2);
  Serial.print(",\"distance_cm\":");
  Serial.print(distanceCm, 2);
  Serial.print(",\"water_depth_cm\":");
  if (isOutOfRange) {
    Serial.print("null");
  } else {
    Serial.print(waterDepthCm, 2);
  }
  Serial.print(",\"float_low\":");
  Serial.print(floatLowTriggered ? "true" : "false");
  Serial.print(",\"float_high\":");
  Serial.print(floatHighTriggered ? "true" : "false");
  Serial.print(",\"barrier_state\":\"");
  Serial.print(barrierState);
  Serial.print("\",\"quality\":\"");
  Serial.print(quality);
  Serial.print("\",\"burst_spread_cm\":");
  Serial.print(burst.spreadCm, 2);
  Serial.print(",\"valid_pings\":");
  Serial.print(burst.validCount);
  if (isOutOfRange) {
    Serial.print(",\"error\":\"out_of_range\"");
  }
  Serial.print(",\"uptime_ms\":");
  Serial.print(now);
  Serial.println("}");

  // 2. Update local GIGA Display Shield from the exact same sensor burst
  LocalDashboardState dashState = evaluateLocalDashboard(
    now, burst, false, isOutOfRange, floatLowTriggered, floatHighTriggered
  );
  updateDisplayDashboard(dashState);
}
