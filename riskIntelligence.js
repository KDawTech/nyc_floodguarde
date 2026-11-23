/**
 * ============================================================================
 * NYC FloodGuard 2.0 — Rule-Based FloodGuard Risk Intelligence Engine
 * File: riskIntelligence.js
 *
 * Transparent, deterministic risk analysis that combines:
 *   1. OBSERVED SENSOR DATA (prototype ultrasonic water depth, flood status,
 *      rate of change, and drainage persistence)
 *   2. LIVE NYC WEATHER FORECAST (Open-Meteo rainfall amounts & probabilities)
 *
 * Always distinguishes observed physical measurements from weather forecast
 * information, and never claims validated real-world citywide prediction.
 * ============================================================================
 */

/**
 * Evaluates current flood risk, rapid-rise conditions, potential blocked-drain
 * signatures, and actionable early-warning recommendations.
 */
export function evaluateFloodRiskIntelligence({
  analysis,
  settings,
  weather,
  sourceMode = 'UNAVAILABLE'
}) {
  const warnCm = Number(settings?.warnThresholdCm ?? 0.5);
  const critCm = Number(settings?.critThresholdCm ?? 1.25);

  const hasObserved =
    Boolean(analysis && analysis.available && analysis.filteredDepthCm != null) &&
    sourceMode !== 'UNAVAILABLE';
  const hasWeather = Boolean(weather && weather.current && weather.summary);

  const depthCm = hasObserved ? Number(analysis.filteredDepthCm) : null;
  const rateCmPerMin = hasObserved && analysis.rateCmPerMin != null ? Number(analysis.rateCmPerMin) : null;
  const status = hasObserved ? analysis.status : 'UNAVAILABLE';
  const trend = hasObserved ? analysis.trend : 'UNAVAILABLE';
  const samples = hasObserved && Array.isArray(analysis.filteredSamples) ? analysis.filteredSamples : [];

  // 1. Rapid-Rise Detection (scaled relative to active prototype threshold span)
  const rapidRiseThresholdCmPerMin = Math.max(0.35, Number(((critCm - warnCm) * 0.45).toFixed(2)));
  const rapidRiseDetected =
    hasObserved &&
    analysis.sensorQuality === 'GOOD' &&
    trend === 'RISING' &&
    rateCmPerMin != null &&
    rateCmPerMin >= rapidRiseThresholdCmPerMin;

  // 2. Potential Blocked Storm Drain Detection (transparent physical rule)
  // Triggered when:
  //   (a) Water is at/above Warning depth and remains elevated without receding for >= 5 readings
  //       (stable/non-draining pooling or still rising), OR
  //   (b) Rapid rise is observed while water is already pooling (>= 60% of warning threshold)
  const recentSamples = samples.slice(-6);
  const sustainedElevatedCount = recentSamples.filter((s) => s.filteredDepthCm >= warnCm).length;
  const sustainedPoolingNotDraining =
    hasObserved &&
    depthCm >= warnCm &&
    sustainedElevatedCount >= 4 &&
    trend !== 'FALLING';

  const rapidPoolingOnStreet =
    rapidRiseDetected && depthCm >= warnCm * 0.6;

  const blockedDrainSuspected = Boolean(sustainedPoolingNotDraining || rapidPoolingOnStreet);

  let blockedDrainNote = '';
  if (blockedDrainSuspected) {
    if (trend === 'RISING' && depthCm >= critCm) {
      blockedDrainNote =
        'Water depth has exceeded the Critical threshold and continues rising — consistent with a severely obstructed storm drain unable to discharge inflow.';
    } else if (trend === 'RISING') {
      blockedDrainNote =
        'Sustained water accumulation at or above Warning level indicates inflow is outpacing drainage — inspect for a blocked storm-drain grate.';
    } else {
      blockedDrainNote =
        'Water remains pooled above the Warning threshold without receding across consecutive readings — a blocked catch basin may be preventing effective drainage.';
    }
  } else if (hasObserved && trend === 'FALLING' && depthCm > 0.1) {
    blockedDrainNote =
      'Observed depth is actively receding, indicating that water is draining off the street surface.';
  } else {
    blockedDrainNote =
      'No blocked-drain pooling signature currently detected from observed sensor readings.';
  }

  // 3. Weather Forecast Assessment (strictly labeled as Forecast, not Observed Sensor)
  const forecastLevel = hasWeather ? weather.severity?.level || 'LOW' : 'UNAVAILABLE';
  const next6hMm = hasWeather ? weather.summary.next6hPrecipMm : null;
  const maxProb6h = hasWeather ? weather.summary.maxRainProb6h : null;
  const peakRateMm = hasWeather ? weather.summary.peakHourlyRateMm : null;

  // 4. Combined Risk Level & Trajectory Explanation
  const drivers = [];
  const recommendations = [];
  let riskLevel = 'LOW';
  let riskLabel = 'Low Risk';
  let trajectoryLabel = 'Stable';

  if (!hasObserved && !hasWeather) {
    return {
      riskLevel: 'UNAVAILABLE',
      riskLabel: 'Awaiting Data',
      trajectoryLabel: 'No Data',
      rapidRiseDetected: false,
      rapidRiseThresholdCmPerMin,
      blockedDrainSuspected: false,
      blockedDrainNote: 'Connect the Arduino sensor or start Demo Mode to evaluate drainage behavior.',
      observedSummary: 'No active prototype sensor stream connected (LIVE or DEMO).',
      forecastSummary: 'Live NYC weather forecast unavailable.',
      drivers: ['Connect the Arduino GIGA R1 WiFi via USB Serial or start Demo Mode for live ultrasonic risk analysis.'],
      recommendations: [
        'Close the Arduino IDE Serial Monitor and connect your Arduino to begin real-time depth monitoring.',
        'Refresh Live NYC Weather to include upcoming Open-Meteo rainfall conditions.'
      ],
      disclaimer:
        'Rule-based prototype risk analysis only — combines tabletop sensor measurements with Open-Meteo NYC forecasts and is not validated for official emergency forecasting.'
    };
  }

  // Evaluate observed drivers
  if (hasObserved) {
    const modeTag = sourceMode === 'LIVE' ? 'Observed Arduino sensor' : 'Demo Mode simulation';
    if (status === 'CRITICAL') {
      drivers.push(
        `${modeTag} reports CRITICAL depth (${depthCm.toFixed(2)} cm, threshold ≥ ${critCm.toFixed(2)} cm).`
      );
    } else if (status === 'WARNING') {
      drivers.push(
        `${modeTag} reports WARNING depth (${depthCm.toFixed(2)} cm, range ${warnCm.toFixed(2)}–${(critCm - 0.01).toFixed(2)} cm).`
      );
    } else if (status === 'NORMAL') {
      drivers.push(
        `${modeTag} reports NORMAL depth (${depthCm.toFixed(2)} cm, below ${warnCm.toFixed(2)} cm warning threshold).`
      );
    }

    if (rapidRiseDetected) {
      drivers.push(
        `Rapid water rise detected at +${rateCmPerMin.toFixed(2)} cm/min (exceeds rapid-rise flag of ${rapidRiseThresholdCmPerMin.toFixed(2)} cm/min).`
      );
    } else if (trend === 'RISING' && rateCmPerMin != null) {
      drivers.push(`Water depth is rising at +${rateCmPerMin.toFixed(2)} cm/min.`);
    } else if (trend === 'FALLING' && rateCmPerMin != null) {
      drivers.push(`Water depth is receding at ${rateCmPerMin.toFixed(2)} cm/min, lowering immediate pooling risk.`);
    } else if (trend === 'STABLE') {
      drivers.push('Observed water depth is holding steady across the recent window.');
    }

    if (blockedDrainSuspected) {
      drivers.push('Drainage efficiency alert: sustained pooling or rapid accumulation suggests a possible blocked storm drain.');
    }
  } else if (analysis?.status === 'OUT_OF_RANGE') {
    drivers.push('Observed sensor is currently OUT OF RANGE — inspect HC-SR04 alignment; not counted as dry road.');
  } else {
    drivers.push('No live prototype sensor connected — current assessment reflects NYC weather forecast context only.');
  }

  // Evaluate forecast drivers (distinct from observed sensor)
  if (hasWeather) {
    if (forecastLevel === 'SEVERE') {
      drivers.push(
        `NYC Forecast (Open-Meteo): Heavy/severe rainfall projected (peak ${peakRateMm.toFixed(1)} mm/hr, ${next6hMm.toFixed(1)} mm in next 6h, up to ${maxProb6h}% probability).`
      );
    } else if (forecastLevel === 'MODERATE') {
      drivers.push(
        `NYC Forecast (Open-Meteo): Moderate rainfall expected (${next6hMm.toFixed(1)} mm in next 6h, peak ${peakRateMm.toFixed(1)} mm/hr, ${maxProb6h}% probability).`
      );
    } else if (forecastLevel === 'LIGHT') {
      drivers.push(
        `NYC Forecast (Open-Meteo): Light or scattered rain possible (${next6hMm.toFixed(1)} mm in next 6h, max ${maxProb6h}% probability).`
      );
    } else {
      drivers.push(
        `NYC Forecast (Open-Meteo): Dry conditions expected over the next 6 hours (${next6hMm.toFixed(1)} mm, ${maxProb6h}% probability).`
      );
    }
  }

  // Determine overall risk level
  if (status === 'CRITICAL') {
    riskLevel = 'CRITICAL';
    riskLabel = 'Critical Flood Risk';
    trajectoryLabel = trend === 'FALLING' ? 'Peak Receding' : 'Escalating / Active Flood';
  } else if (
    status === 'WARNING' ||
    rapidRiseDetected ||
    (hasObserved && blockedDrainSuspected) ||
    forecastLevel === 'SEVERE'
  ) {
    riskLevel = 'HIGH';
    riskLabel = status === 'WARNING' ? 'High Risk (Warning Active)' : 'High Early-Warning Risk';
    trajectoryLabel = trend === 'RISING' || forecastLevel === 'SEVERE' ? 'Increasing' : trend === 'FALLING' ? 'Decreasing' : 'Elevated';
  } else if (
    (hasObserved && trend === 'RISING') ||
    forecastLevel === 'MODERATE'
  ) {
    riskLevel = 'ELEVATED';
    riskLabel = 'Elevated Watch';
    trajectoryLabel = trend === 'RISING' ? 'Increasing' : 'Forecast Watch';
  } else {
    riskLevel = 'LOW';
    riskLabel = 'Low Risk';
    trajectoryLabel = trend === 'FALLING' ? 'Recovering' : 'Stable';
  }

  // Early-warning recommendations
  if (riskLevel === 'CRITICAL') {
    recommendations.push('Issue immediate local street-flood alert: avoid walking or driving through standing water.');
    if (blockedDrainSuspected) {
      recommendations.push('Check storm-drain inlet for debris blockage (on prototype: clear removable drain blockage to verify recovery).');
    }
    if (analysis?.etaCritical?.reached) {
      recommendations.push('Monitor continuously for receding trend before lifting Critical status.');
    }
  } else if (riskLevel === 'HIGH') {
    if (analysis?.etaCritical?.available && !analysis.etaCritical.reached) {
      recommendations.push(`Projected time to Critical (${critCm.toFixed(2)} cm): ${analysis.etaCritical.label} if current rise continues.`);
    }
    if (blockedDrainSuspected) {
      recommendations.push('Inspect catch basin / drain grate for obstruction preventing normal runoff.');
    }
    if (forecastLevel === 'SEVERE' || forecastLevel === 'MODERATE') {
      recommendations.push('Upcoming NYC rainfall forecast could compound street pooling — keep storm drains clear.');
    }
    recommendations.push('Alert pedestrians and ground-level property occupants to prepare for possible street ponding.');
  } else if (riskLevel === 'ELEVATED') {
    recommendations.push('Continue active monitoring of water-level trend and hourly NYC rainfall updates.');
    recommendations.push('Verify storm-drain grates are unobstructed ahead of forecasted rainfall.');
  } else {
    recommendations.push('Street drainage appears normal; maintain routine sensor and forecast monitoring.');
    if (trend === 'FALLING') {
      recommendations.push('Water level is receding toward dry-road baseline.');
    }
  }

  const observedSummary = hasObserved
    ? `${sourceMode === 'LIVE' ? 'LIVE Arduino' : 'DEMO Simulation'}: ${depthCm.toFixed(2)} cm (${status}) · Trend: ${analysis.trendLabel}${rateCmPerMin != null ? ` (${rateCmPerMin > 0 ? '+' : ''}${rateCmPerMin.toFixed(2)} cm/min)` : ''}`
    : analysis?.status === 'OUT_OF_RANGE'
    ? 'Observed Sensor: OUT OF RANGE (invalid ultrasonic echo)'
    : 'Observed Sensor: Not connected';

  const forecastSummary = hasWeather
    ? `Open-Meteo NYC: ${weather.current.condition}, ${weather.current.tempF != null ? `${weather.current.tempF}°F` : '--'} · Next 6h: ${next6hMm.toFixed(1)} mm (${maxProb6h}% max prob) · ${weather.severity.label}`
    : 'Open-Meteo NYC Forecast: Unavailable';

  return {
    riskLevel,
    riskLabel,
    trajectoryLabel,
    rapidRiseDetected,
    rapidRiseThresholdCmPerMin,
    blockedDrainSuspected,
    blockedDrainNote,
    observedSummary,
    forecastSummary,
    drivers,
    recommendations,
    disclaimer:
      'Transparent rule-based prototype analysis only. Observed tabletop measurements and Open-Meteo NYC weather forecasts are displayed separately; this prototype is not validated for official real-world NYC flood prediction.'
  };
}
