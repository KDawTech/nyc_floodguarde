/*
 * ============================================================================
 * NYC FloodGuard — Arduino GIGA R1 WiFi Prototype Sensor Firmware
 * File: arduino/nyc_floodguard_giga.ino
 *
 * Hardware:
 *   - Arduino GIGA R1 WiFi (STM32H747XI — 3.3V GPIO LOGIC ONLY!)
 *   - HC-SR04 Ultrasonic Distance Sensor
 *   - Optional Low / High Float Switches (wired to GND with INPUT_PULLUP)
 *   - Optional Future Servo Flood Barrier (disabled by default)
 *   - Two water pumps (MANUALLY operated for flood & drainage demo;
 *     drainage-pump operation is NOT monitored or automatically controlled)
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
 *     (Alternatively, use a bidirectional 5V-to-3.3V logic level shifter
 *      or a 3.3V-compatible HC-SR04P / RCWL-1601 ultrasonic module.)
 *
 * Calibration:
 *   1. Empty the 3D-printed NYC street basin completely so the surface is dry.
 *   2. Measure the distance (in cm) from the ultrasonic sensor face to the
 *      dry street floor (or observe distance_cm in Serial Monitor while dry).
 *   3. Set MOUNT_HEIGHT_CM below (and in the website Admin Settings) to that
 *      exact dry distance.
 *   4. Water Depth = MOUNT_HEIGHT_CM - distance_cm
 *      Distances exceeding MOUNT_HEIGHT_CM + DRY_TOLERANCE_CM are reported as
 *      out_of_range (water_depth_cm: null) and are NOT clamped to 0.00 cm.
 *
 * Serial Output Format (115200 baud, 1 JSON object per line every 1000 ms):
 *   {"device":"GIGA-R1-WIFI","mount_height_cm":25.00,"distance_cm":18.40,"water_depth_cm":6.60,"float_low":true,"float_high":false,"barrier_state":"not_installed","quality":"good","burst_spread_cm":0.18,"valid_pings":5,"uptime_ms":14200}
 * ============================================================================
 */

// Optional future servo barrier extension (0 = disabled, 1 = enabled)
#define ENABLE_SERVO_BARRIER 0

#if ENABLE_SERVO_BARRIER
  #include <Servo.h>
  Servo floodBarrierServo;
  const int SERVO_PIN = 5;
  const int BARRIER_OPEN_ANGLE = 0;
  const int BARRIER_CLOSED_ANGLE = 90;
  const float BARRIER_TRIGGER_CM = 10.0;
#endif

// Pin Assignments (3.3V logic safe with 940 Ohm / 1 kOhm voltage divider on ECHO_PIN)
const int TRIG_PIN = 9;        // HC-SR04 TRIG -> D9
const int ECHO_PIN = 10;       // HC-SR04 ECHO -> 470 Ohm + 470 Ohm -> D10 -> 1 kOhm -> GND
const int FLOAT_LOW_PIN = 6;   // Optional float switch (closed to GND when triggered)
const int FLOAT_HIGH_PIN = 7;  // Optional float switch (closed to GND when triggered)

// Calibration: Distance from HC-SR04 transducer face to dry prototype street floor (cm)
const float MOUNT_HEIGHT_CM = 25.0;
const float MIN_VALID_DIST_CM = 2.0;    // HC-SR04 minimum sensing distance
const float DRY_TOLERANCE_CM = 2.0;     // Small noise margin beyond dry floor
const float MAX_GOOD_SPREAD_CM = 2.5;   // Burst spread threshold for "unstable"

// Sampling configuration
const unsigned long REPORT_INTERVAL_MS = 1000;
const int BURST_SAMPLES = 5;
const unsigned long ECHO_TIMEOUT_US = 25000; // ~4.2m max range timeout

unsigned long lastReportMs = 0;

struct BurstResult {
  float medianCm;
  float spreadCm;
  int validCount;
};

float measureSingleDistanceCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(3);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  unsigned long durationUs = pulseIn(ECHO_PIN, HIGH, ECHO_TIMEOUT_US);
  if (durationUs == 0) {
    return -1.0; // Echo timeout
  }

  // Speed of sound at ~20C: 0.0343 cm/us (divide by 2 for round-trip)
  float distCm = (durationUs * 0.0343f) / 2.0f;

  // Reject echoes beyond HC-SR04 physical maximum range (400 cm) as invalid/timeout;
  // readings below MIN_VALID_DIST_CM (2.0 cm) are kept so loop() explicitly flags out_of_range
  if (distCm > 400.0f) {
    return -1.0;
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
  res.medianCm = -1.0;
  res.spreadCm = 0.0;

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
  if (burst.validCount == 0 || burst.medianCm < 0.0f) {
    const char* timeoutBarrierState = "not_installed";
#if ENABLE_SERVO_BARRIER
    floodBarrierServo.write(BARRIER_OPEN_ANGLE);
    timeoutBarrierState = "standby";
#endif
    // Do not fabricate readings or report 0.0 cm when sensor echo times out
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
    return;
  }

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

  // Emit single-line JSON for NYC FloodGuard Web Serial receiver
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
}
