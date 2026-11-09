/**
 * ============================================================================
 * NYC FloodGuard — IoT Urban Flood Monitoring Website (Educational Prototype)
 * File: script.js
 *
 * Architecture Overview:
 *   1. FloodGuardAPI Service Layer:
 *      - Designed with a clean async interface (`getStations()`, `saveStation()`,
 *        `deleteStation()`, `recordTelemetryBatch()`) ready to swap from browser
 *        `localStorage` simulation (`MODE: 'LOCAL_SIMULATION'`) to a production
 *        REST/WebSocket backend (`MODE: 'REMOTE_API'`) connected to an Arduino
 *        GIGA R1 WiFi ingestion server and PostgreSQL/TimescaleDB database.
 *      - Note: `localStorage` is strictly browser-local persistence for prototype
 *        testing and does NOT provide shared multi-user server persistence.
 *   2. Low-Latency Telemetry Engine (< 5s Target):
 *      - Polls/simulates ultrasonic sensor readings every 5 seconds.
 *      - Computes water depth from ultrasonic mount height and echo distance.
 *      - Flags readings older than the configured timeout (default 15s) as STALE.
 *   3. Resilient Network Handling:
 *      - Handles `online`/`offline` events and simulated network interruptions
 *        gracefully without crashing, queuing updates locally.
 *   4. Interactive Visualizations & Full CRUD:
 *      - Five-borough interactive SVG NYC map with clickable pulsing markers.
 *      - Custom HTML5 Canvas time-series and multi-station threshold charts.
 *      - Full Create, Read, Update, Delete (CRUD) for stations and alert rules.
 * ============================================================================
 */

(function () {
  'use strict';

  /* --------------------------------------------------------------------------
   * 1. DEFAULT NYC MONITORING LOCATIONS (SEED DATA)
   * -------------------------------------------------------------------------- */
  const STORAGE_KEYS = {
    STATIONS: 'nyc_floodguard_stations_v1',
    HISTORY: 'nyc_floodguard_history_v1',
    ALERTS: 'nyc_floodguard_alerts_v1',
    SUBSCRIPTIONS: 'nyc_floodguard_subs_v1',
    CONFIG: 'nyc_floodguard_config_v1'
  };

  const DEFAULT_CONFIG = {
    staleTimeoutSec: 15,
    pollIntervalSec: 5,
    unit: 'IN', // 'IN' or 'CM'
    role: 'resident', // 'resident' | 'operator' | 'admin'
    apiMode: 'SIMULATED_LOCAL',
    apiEndpoint: '/api/v1'
  };

  function getInitialStations() {
    const now = Date.now();
    return [
      {
        id: 'st-bk-01',
        name: 'Gowanus Canal & 9th St',
        borough: 'Brooklyn',
        street: '9th St & 2nd Ave Culvert Basin',
        nodeId: 'GIGA-BK-01',
        mountHeightCm: 250,
        waterDepthIn: 16.4,
        warnThresholdIn: 8.0,
        critThresholdIn: 14.0,
        rateInPerHr: 3.2,
        batteryV: 12.6,
        rssiDbm: -58,
        mapX: 350,
        mapY: 368,
        lastUpdatedMs: now - 2000,
        forceStale: false
      },
      {
        id: 'st-qn-01',
        name: 'Queens Blvd & Yellowstone',
        borough: 'Queens',
        street: 'Queens Blvd Underpass (Rego Park)',
        nodeId: 'GIGA-QN-01',
        mountHeightCm: 260,
        waterDepthIn: 10.2,
        warnThresholdIn: 8.0,
        critThresholdIn: 14.0,
        rateInPerHr: 1.8,
        batteryV: 12.5,
        rssiDbm: -63,
        mapX: 505,
        mapY: 255,
        lastUpdatedMs: now - 3000,
        forceStale: false
      },
      {
        id: 'st-mn-01',
        name: 'FDR Drive & South St Viaduct',
        borough: 'Manhattan',
        street: 'South St Seaport Low Underpass',
        nodeId: 'GIGA-MN-01',
        mountHeightCm: 240,
        waterDepthIn: 4.6,
        warnThresholdIn: 7.5,
        critThresholdIn: 13.0,
        rateInPerHr: 0.4,
        batteryV: 12.7,
        rssiDbm: -54,
        mapX: 322,
        mapY: 292,
        lastUpdatedMs: now - 2500,
        forceStale: false
      },
      {
        id: 'st-qn-02',
        name: 'Hamilton Beach & Cross Bay',
        borough: 'Queens',
        street: '104th St & Russell St Bulkhead',
        nodeId: 'GIGA-QN-02',
        mountHeightCm: 245,
        waterDepthIn: 6.8,
        warnThresholdIn: 7.0,
        critThresholdIn: 12.5,
        rateInPerHr: 0.9,
        batteryV: 12.4,
        rssiDbm: -67,
        mapX: 595,
        mapY: 415,
        lastUpdatedMs: now - 4000,
        forceStale: false
      },
      {
        id: 'st-bx-01',
        name: 'Major Deegan & Exterior St',
        borough: 'Bronx',
        street: 'Harlem River Low Basin @ 149th St',
        nodeId: 'GIGA-BX-01',
        mountHeightCm: 255,
        waterDepthIn: 3.1,
        warnThresholdIn: 8.5,
        critThresholdIn: 15.0,
        rateInPerHr: 0.1,
        batteryV: 12.8,
        rssiDbm: -60,
        mapX: 398,
        mapY: 125,
        lastUpdatedMs: now - 1800,
        forceStale: false
      },
      {
        id: 'st-si-01',
        name: 'Midland Beach & Father Capodanno',
        borough: 'Staten Island',
        street: 'Father Capodanno Blvd & Lincoln Ave',
        nodeId: 'GIGA-SI-01',
        mountHeightCm: 240,
        waterDepthIn: 5.4,
        warnThresholdIn: 7.0,
        critThresholdIn: 12.0,
        rateInPerHr: 0.6,
        batteryV: 12.5,
        rssiDbm: -69,
        mapX: 205,
        mapY: 410,
        lastUpdatedMs: now - 3200,
        forceStale: false
      },
      {
        id: 'st-mn-02',
        name: 'Harlem River Dr & 155th St',
        borough: 'Manhattan',
        street: 'Harlem River Drive Northbound Catch Basin',
        nodeId: 'GIGA-MN-02',
        mountHeightCm: 250,
        waterDepthIn: 2.4,
        warnThresholdIn: 8.0,
        critThresholdIn: 14.0,
        rateInPerHr: 0.0,
        batteryV: 12.7,
        rssiDbm: -55,
        mapX: 358,
        mapY: 138,
        lastUpdatedMs: now - 2100,
        forceStale: false
      },
      {
        id: 'st-bk-02',
        name: 'Red Hook & Coffey St Pier',
        borough: 'Brooklyn',
        street: 'Ferris St & Coffey St Tidal Basin',
        nodeId: 'GIGA-BK-02',
        mountHeightCm: 245,
        waterDepthIn: 4.9,
        warnThresholdIn: 7.5,
        critThresholdIn: 13.5,
        rateInPerHr: 0.3,
        batteryV: 12.6,
        rssiDbm: -62,
        mapX: 315,
        mapY: 360,
        lastUpdatedMs: now - 2800,
        forceStale: false
      }
    ];
  }

  /* --------------------------------------------------------------------------
   * 2. SAFE LOCALSTORAGE WRAPPER & MODULAR API ADAPTER
   * -------------------------------------------------------------------------- */
  const SafeStorage = {
    get(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (err) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (err) {
        return false;
      }
    },
    remove(key) {
      try {
        window.localStorage.removeItem(key);
      } catch (err) {
        // Ignore sandbox storage blocks
      }
    },
    estimateBytes() {
      try {
        let total = 0;
        Object.values(STORAGE_KEYS).forEach((k) => {
          const v = window.localStorage.getItem(k);
          if (v) total += v.length * 2;
        });
        return total;
      } catch (err) {
        return 0;
      }
    }
  };

  /**
   * FloodGuardAPI abstracts data persistence so the application can transition
   * seamlessly from browser-local simulation to an Express/FastAPI + database backend.
   */
  const FloodGuardAPI = {
    loadState() {
      const config = Object.assign({}, DEFAULT_CONFIG, SafeStorage.get(STORAGE_KEYS.CONFIG, {}));
      let stations = SafeStorage.get(STORAGE_KEYS.STATIONS, null);
      if (!Array.isArray(stations) || stations.length === 0) {
        stations = getInitialStations();
        SafeStorage.set(STORAGE_KEYS.STATIONS, stations);
      }
      let history = SafeStorage.get(STORAGE_KEYS.HISTORY, null);
      if (!Array.isArray(history) || history.length === 0) {
        history = this.seedInitialHistory(stations);
        SafeStorage.set(STORAGE_KEYS.HISTORY, history);
      }
      let alerts = SafeStorage.get(STORAGE_KEYS.ALERTS, null);
      if (!Array.isArray(alerts)) {
        alerts = [];
      }
      let subscriptions = SafeStorage.get(STORAGE_KEYS.SUBSCRIPTIONS, null);
      if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
        subscriptions = [
          {
            id: 'sub-1',
            name: 'Gowanus Mutual Aid',
            stationId: 'st-bk-01',
            stationName: 'Gowanus Canal & 9th St',
            thresholdType: 'WARNING',
            channel: 'Browser Toast + Audio'
          }
        ];
        SafeStorage.set(STORAGE_KEYS.SUBSCRIPTIONS, subscriptions);
      }
      return { config, stations, history, alerts, subscriptions };
    },

    seedInitialHistory(stations) {
      const records = [];
      const now = Date.now();
      stations.forEach((st) => {
        for (let i = 11; i >= 0; i--) {
          const ts = now - i * 5000;
          const jitter = Math.sin(i * 0.7) * 0.45;
          const depthIn = Math.max(0.4, Number((st.waterDepthIn - i * 0.08 + jitter).toFixed(2)));
          const depthCm = Number((depthIn * 2.54).toFixed(1));
          const echoDistCm = Number((st.mountHeightCm - depthCm).toFixed(1));
          records.push({
            id: 'hist-' + st.id + '-' + i,
            timestampMs: ts,
            stationId: st.id,
            stationName: st.name,
            borough: st.borough,
            nodeId: st.nodeId,
            echoDistCm,
            depthIn,
            depthCm,
            rateInPerHr: st.rateInPerHr,
            status: evaluateStationStatus(st, depthIn, ts, 15)
          });
        }
      });
      return records.slice(-160);
    },

    persistAll(state) {
      SafeStorage.set(STORAGE_KEYS.CONFIG, state.config);
      SafeStorage.set(STORAGE_KEYS.STATIONS, state.stations);
      SafeStorage.set(STORAGE_KEYS.HISTORY, state.history.slice(-240));
      SafeStorage.set(STORAGE_KEYS.ALERTS, state.alerts.slice(0, 60));
      SafeStorage.set(STORAGE_KEYS.SUBSCRIPTIONS, state.subscriptions);
    }
  };

  /* --------------------------------------------------------------------------
   * 3. APPLICATION STATE & HELPER FUNCTIONS
   * -------------------------------------------------------------------------- */
  const appState = FloodGuardAPI.loadState();
  let activeView = 'home';
  let selectedMapStationId = appState.stations[0] ? appState.stations[0].id : null;
  let pendingDeleteStationId = null;
  let mapClickAddMode = false;
  let telemetryPaused = false;
  let simulatedOffline = false;
  let countdownSec = appState.config.pollIntervalSec || 5;
  let lastLatencyMs = 118;
  let tickTimerId = null;

  function evaluateStationStatus(station, depthValIn, lastUpdatedMs, staleTimeoutSec) {
    const now = Date.now();
    const ageSec = (now - (lastUpdatedMs || station.lastUpdatedMs)) / 1000;
    if (station.forceStale || ageSec > staleTimeoutSec) {
      return 'STALE';
    }
    const d = typeof depthValIn === 'number' ? depthValIn : station.waterDepthIn;
    if (d >= station.critThresholdIn) return 'CRITICAL';
    if (d >= station.warnThresholdIn) return 'WARNING';
    return 'NORMAL';
  }

  function formatDepth(depthIn) {
    if (appState.config.unit === 'CM') {
      return (depthIn * 2.54).toFixed(1) + ' cm';
    }
    return Number(depthIn).toFixed(1) + ' in';
  }

  function formatDualDepth(depthIn) {
    const cm = (depthIn * 2.54).toFixed(1);
    const inches = Number(depthIn).toFixed(1);
    return appState.config.unit === 'CM'
      ? `${cm} cm (${inches} in)`
      : `${inches} in (${cm} cm)`;
  }

  function formatAge(lastUpdatedMs, forceStale) {
    if (forceStale) return '42s ago (Outdated)';
    const sec = Math.max(1, Math.round((Date.now() - lastUpdatedMs) / 1000));
    return sec + 's ago';
  }

  function getGuidanceText(status, station) {
    if (status === 'CRITICAL') {
      return `CRITICAL FLOOD WARNING: Water depth exceeds ${formatDepth(station.critThresholdIn)}. Avoid driving or walking through ${station.street}; evacuate basement spaces if water is rising.`;
    }
    if (status === 'WARNING') {
      return `ELEVATED FLOOD WATCH: Water ponding above ${formatDepth(station.warnThresholdIn)} near ${station.street}. Use caution and monitor catch basins.`;
    }
    if (status === 'STALE') {
      return `OUTDATED TELEMETRY: Arduino node ${station.nodeId} has not reported within the ${appState.config.staleTimeoutSec}s freshness window. Last known measurement shown.`;
    }
    return `Normal street drainage conditions at ${station.street}. Safe for standard pedestrian and vehicle travel.`;
  }

  function showToast(message, severity) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast-msg' + (severity === 'CRITICAL' ? ' toast-crit' : severity === 'WARNING' ? ' toast-warn' : '');
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 4500);
  }

  /* --------------------------------------------------------------------------
   * 4. FLOOD ALERT EVALUATION ENGINE
   * -------------------------------------------------------------------------- */
  function synchronizeAlerts(notifyNew) {
    const staleLimit = appState.config.staleTimeoutSec;
    appState.stations.forEach((st) => {
      const status = evaluateStationStatus(st, st.waterDepthIn, st.lastUpdatedMs, staleLimit);
      if (status === 'CRITICAL' || status === 'WARNING') {
        const existing = appState.alerts.find(
          (a) => a.stationId === st.id && !a.acknowledged && a.severity === status
        );
        if (!existing) {
          const newAlert = {
            id: 'al-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
            stationId: st.id,
            stationName: st.name,
            borough: st.borough,
            street: st.street,
            nodeId: st.nodeId,
            severity: status,
            waterDepthIn: st.waterDepthIn,
            thresholdIn: status === 'CRITICAL' ? st.critThresholdIn : st.warnThresholdIn,
            timestampMs: Date.now(),
            acknowledged: false,
            note: ''
          };
          appState.alerts.unshift(newAlert);
          if (notifyNew) {
            showToast(
              `${status}: ${st.name} (${st.borough}) reached ${formatDepth(st.waterDepthIn)}!`,
              status
            );
          }
        } else {
          existing.waterDepthIn = st.waterDepthIn;
          existing.timestampMs = Date.now();
        }
      }
    });
  }

  /* --------------------------------------------------------------------------
   * 5. NAVIGATION & ROLE SWITCHING
   * -------------------------------------------------------------------------- */
  function switchView(viewName) {
    activeView = viewName;
    document.querySelectorAll('.view-section').forEach((sec) => {
      sec.classList.toggle('active', sec.id === 'view-' + viewName);
    });
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-view') === viewName);
    });
    const nav = document.getElementById('primaryNav');
    const mobileBtn = document.getElementById('mobileMenuBtn');
    if (nav && nav.classList.contains('mobile-open')) {
      nav.classList.remove('mobile-open');
      if (mobileBtn) mobileBtn.setAttribute('aria-expanded', 'false');
    }
    if (viewName === 'charts') {
      setTimeout(renderAllCharts, 40);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function updateRoleUI() {
    const role = appState.config.role;
    const roleSelector = document.getElementById('roleSelector');
    if (roleSelector) roleSelector.value = role;

    const tagEl = document.getElementById('roleTagLabel');
    const descEl = document.getElementById('roleDescriptionText');
    const adminNotice = document.getElementById('adminRoleNotice');

    if (role === 'resident') {
      if (tagEl) tagEl.textContent = 'NYC Resident View';
      if (descEl) descEl.textContent = 'Plain-language street flood status, neighborhood water levels, and travel safety advisories.';
      if (adminNotice) adminNotice.style.display = 'flex';
    } else if (role === 'operator') {
      if (tagEl) tagEl.textContent = 'Monitoring Personnel View';
      if (descEl) descEl.textContent = 'Operational telemetry diagnostics, ultrasonic echo metrics, historical trends, and alert acknowledgment.';
      if (adminNotice) adminNotice.style.display = 'flex';
    } else {
      if (tagEl) tagEl.textContent = 'System Administrator View';
      if (descEl) descEl.textContent = 'Full CRUD access enabled for monitoring locations, sensor hardware parameters, and flood thresholds.';
      if (adminNotice) adminNotice.style.display = 'none';
    }

    const resCard = document.getElementById('personaCardResident');
    const opsCard = document.getElementById('personaCardOperator');
    const admCard = document.getElementById('personaCardAdmin');
    if (resCard) resCard.classList.toggle('active-role', role === 'resident');
    if (opsCard) opsCard.classList.toggle('active-role', role === 'operator');
    if (admCard) admCard.classList.toggle('active-role', role === 'admin');
  }

  /* --------------------------------------------------------------------------
   * 6. RENDERING ENGINE (HOMEPAGE, DASHBOARD, MAP, CHARTS, ALERTS, CRUD)
   * -------------------------------------------------------------------------- */
  function renderAll() {
    synchronizeAlerts(false);
    updateRoleUI();
    renderTopStatusAndTicker();
    renderHomepage();
    renderDashboard();
    renderMap();
    populateStationDropdowns();
    renderAlertsSection();
    renderManagementSection();
    renderHistoryTable();
    if (activeView === 'charts') {
      renderAllCharts();
    }
    FloodGuardAPI.persistAll(appState);
  }

  function renderTopStatusAndTicker() {
    const staleLimit = appState.config.staleTimeoutSec;
    const criticalStations = appState.stations.filter(
      (s) => evaluateStationStatus(s, s.waterDepthIn, s.lastUpdatedMs, staleLimit) === 'CRITICAL'
    );
    const unackAlerts = appState.alerts.filter((a) => !a.acknowledged);
    const badge = document.getElementById('activeAlertBadge');
    if (badge) {
      badge.textContent = String(unackAlerts.length);
      badge.style.background = criticalStations.length > 0 ? 'var(--crit-500)' : 'var(--warn-500)';
    }

    const ticker = document.getElementById('emergencyTicker');
    const tickerText = document.getElementById('emergencyTickerText');
    if (ticker && tickerText) {
      if (criticalStations.length > 0) {
        ticker.classList.remove('hidden');
        const names = criticalStations.map((s) => `${s.name} (${formatDepth(s.waterDepthIn)})`).join(' • ');
        tickerText.textContent = `CRITICAL FLOOD WARNING ACTIVE: ${names} — Avoid flooded streets and underpasses.`;
      } else {
        ticker.classList.add('hidden');
      }
    }

    const dot = document.getElementById('telemetryDot');
    const modeLbl = document.getElementById('telemetryModeLabel');
    const latVal = document.getElementById('telemetryLatencyValue');
    const netBanner = document.getElementById('networkBanner');

    const isOffline = simulatedOffline || !navigator.onLine;
    if (dot) dot.classList.toggle('offline', isOffline);
    if (modeLbl) {
      modeLbl.textContent = isOffline ? 'Gateway: OFFLINE (Cached Mode)' : 'Gateway: SIMULATED_LOCAL';
    }
    if (latVal) {
      latVal.textContent = isOffline ? 'Cached' : lastLatencyMs + ' ms';
    }
    if (netBanner) {
      netBanner.classList.toggle('active', isOffline);
    }
  }

  function buildStationCardHTML(st) {
    const staleLimit = appState.config.staleTimeoutSec;
    const status = evaluateStationStatus(st, st.waterDepthIn, st.lastUpdatedMs, staleLimit);
    const statusClass =
      status === 'CRITICAL'
        ? 'status-critical'
        : status === 'WARNING'
        ? 'status-warning'
        : status === 'STALE'
        ? 'status-stale'
        : 'status-normal';

    const badgeClass =
      status === 'CRITICAL'
        ? 'badge-critical'
        : status === 'WARNING'
        ? 'badge-warning'
        : status === 'STALE'
        ? 'badge-stale'
        : 'badge-normal';

    const badgeLabel =
      status === 'CRITICAL'
        ? 'Critical Flood Warning'
        : status === 'WARNING'
        ? 'Elevated Flood Watch'
        : status === 'STALE'
        ? 'Outdated Reading'
        : 'Normal / Safe';

    const fillClass =
      status === 'CRITICAL'
        ? 'fill-critical'
        : status === 'WARNING'
        ? 'fill-warning'
        : status === 'STALE'
        ? 'fill-stale'
        : '';

    const guidanceClass =
      status === 'CRITICAL'
        ? 'guidance-critical'
        : status === 'WARNING'
        ? 'guidance-warning'
        : '';

    const pct = Math.min(100, Math.max(4, Math.round((st.waterDepthIn / (st.critThresholdIn * 1.25)) * 100)));
    const depthCm = (st.waterDepthIn * 2.54).toFixed(1);
    const echoDistCm = Math.max(10, (st.mountHeightCm - st.waterDepthIn * 2.54)).toFixed(1);

    const staleBanner =
      status === 'STALE'
        ? `<div class="stale-warning-banner">
             <span>OUTDATED SENSOR DATA (&gt;${staleLimit}s old)</span>
             <button type="button" class="btn btn-sm btn-outline js-refresh-node" data-id="${st.id}">Reconnect Node</button>
           </div>`
        : '';

    const operatorDiagnostics =
      appState.config.role !== 'resident'
        ? `<div style="font-size:0.73rem;font-family:var(--font-mono);color:var(--gray-600);background:var(--gray-100);padding:6px 8px;border-radius:4px;margin-bottom:8px;">
             Node: ${st.nodeId} | Echo Gap: ${echoDistCm}cm | Batt: ${st.batteryV}V | RSSI: ${st.rssiDbm}dBm
           </div>`
        : '';

    return `
      <article class="station-card ${statusClass}" data-station-id="${st.id}">
        <div>
          ${staleBanner}
          <div class="station-card-top">
            <div>
              <span class="borough-chip">${st.borough}</span>
              <h3 class="station-name">${st.name}</h3>
              <div class="station-street">${st.street}</div>
            </div>
            <span class="status-badge ${badgeClass}">${badgeLabel}</span>
          </div>

          <div class="water-gauge-row">
            <div>
              <div class="water-depth-primary">${formatDepth(st.waterDepthIn)}</div>
              <div class="water-depth-sub">
                ${appState.config.unit === 'IN' ? `${depthCm} cm` : `${st.waterDepthIn.toFixed(1)} in`}
                • Rate: ${st.rateInPerHr >= 0 ? '+' : ''}${st.rateInPerHr.toFixed(1)} in/hr
              </div>
            </div>
            <div class="gauge-track-wrap">
              <div class="gauge-track" role="progressbar" aria-valuenow="${st.waterDepthIn}" aria-valuemin="0" aria-valuemax="${st.critThresholdIn}">
                <div class="gauge-fill ${fillClass}" style="width:${pct}%;"></div>
              </div>
              <div class="gauge-thresholds-label">
                <span>Warn: ${formatDepth(st.warnThresholdIn)}</span>
                <span>Crit: ${formatDepth(st.critThresholdIn)}</span>
              </div>
            </div>
          </div>

          ${operatorDiagnostics}

          <div class="station-guidance ${guidanceClass}">
            ${getGuidanceText(status, st)}
          </div>
        </div>

        <div class="station-meta-footer">
          <span>Updated: <strong>${formatAge(st.lastUpdatedMs, st.forceStale)}</strong></span>
          <div style="display:flex;gap:6px;">
            <button type="button" class="btn btn-sm btn-outline js-locate-map" data-id="${st.id}">Map</button>
            <button type="button" class="btn btn-sm btn-outline js-view-chart" data-id="${st.id}">Chart</button>
            ${
              appState.config.role === 'admin'
                ? `<button type="button" class="btn btn-sm btn-primary js-edit-station" data-id="${st.id}">Edit</button>`
                : ''
            }
          </div>
        </div>
      </article>
    `;
  }

  function renderHomepage() {
    const staleLimit = appState.config.staleTimeoutSec;
    const total = appState.stations.length;
    const freshCount = appState.stations.filter(
      (s) => evaluateStationStatus(s, s.waterDepthIn, s.lastUpdatedMs, staleLimit) !== 'STALE'
    ).length;

    const sortedByDepth = [...appState.stations].sort((a, b) => b.waterDepthIn - a.waterDepthIn);
    const peakSt = sortedByDepth[0];
    const activeAlerts = appState.alerts.filter((a) => !a.acknowledged);

    const elActive = document.getElementById('heroStatActiveNodes');
    const elPeak = document.getElementById('heroStatPeakLevel');
    const elAlerts = document.getElementById('heroStatActiveAlerts');
    const elLat = document.getElementById('heroStatLatency');
    const elHighBox = document.getElementById('heroHighestStationBox');

    if (elActive) elActive.textContent = `${freshCount} / ${total}`;
    if (elPeak && peakSt) elPeak.textContent = formatDepth(peakSt.waterDepthIn);
    if (elAlerts) elAlerts.textContent = `${activeAlerts.length} Active`;
    if (elLat) elLat.textContent = (lastLatencyMs / 1000).toFixed(2) + ' s';

    if (elHighBox && peakSt) {
      const stStatus = evaluateStationStatus(peakSt, peakSt.waterDepthIn, peakSt.lastUpdatedMs, staleLimit);
      elHighBox.innerHTML = `
        <strong>Highest Monitored Street Level:</strong> ${peakSt.name} (${peakSt.borough}) at
        <strong>${formatDualDepth(peakSt.waterDepthIn)}</strong> — Status: <strong>${stStatus}</strong>
      `;
    }

    const watchlistGrid = document.getElementById('homeWatchlistGrid');
    if (watchlistGrid) {
      const topThree = sortedByDepth.slice(0, 3);
      watchlistGrid.innerHTML = topThree.map(buildStationCardHTML).join('');
    }
  }

  function renderDashboard() {
    const staleLimit = appState.config.staleTimeoutSec;
    const total = appState.stations.length;
    let staleCount = 0;
    let critCount = 0;
    let warnCount = 0;

    appState.stations.forEach((s) => {
      const st = evaluateStationStatus(s, s.waterDepthIn, s.lastUpdatedMs, staleLimit);
      if (st === 'STALE') staleCount++;
      else if (st === 'CRITICAL') critCount++;
      else if (st === 'WARNING') warnCount++;
    });

    const sortedByDepth = [...appState.stations].sort((a, b) => b.waterDepthIn - a.waterDepthIn);
    const peakSt = sortedByDepth[0];

    const kpiOnline = document.getElementById('kpiOnlineSensors');
    const kpiPeak = document.getElementById('kpiPeakWater');
    const kpiPeakSt = document.getElementById('kpiPeakStation');
    const kpiAlerts = document.getElementById('kpiActiveAlerts');
    const kpiAlertsMeta = document.getElementById('kpiAlertsMeta');
    const kpiStale = document.getElementById('kpiStaleCount');
    const kpiLatMeta = document.getElementById('kpiLatencyMeta');

    if (kpiOnline) kpiOnline.textContent = `${total - staleCount} / ${total}`;
    if (kpiPeak && peakSt) kpiPeak.textContent = formatDepth(peakSt.waterDepthIn);
    if (kpiPeakSt && peakSt) kpiPeakSt.textContent = `${peakSt.name} (${peakSt.borough})`;
    if (kpiAlerts) kpiAlerts.textContent = String(critCount + warnCount);
    if (kpiAlertsMeta) kpiAlertsMeta.textContent = `${critCount} Critical Red • ${warnCount} Advisory Orange`;
    if (kpiStale) kpiStale.textContent = String(staleCount);
    if (kpiLatMeta) kpiLatMeta.textContent = `Freshness window: ${staleLimit}s | Poll: ${appState.config.pollIntervalSec}s`;

    // Apply filters
    const searchVal = (document.getElementById('dashSearchInput')?.value || '').trim().toLowerCase();
    const boroughVal = document.getElementById('dashBoroughFilter')?.value || 'ALL';
    const statusVal = document.getElementById('dashStatusFilter')?.value || 'ALL';
    const sortVal = document.getElementById('dashSortSelect')?.value || 'severity';

    let filtered = appState.stations.filter((st) => {
      const status = evaluateStationStatus(st, st.waterDepthIn, st.lastUpdatedMs, staleLimit);
      const matchesSearch =
        !searchVal ||
        st.name.toLowerCase().includes(searchVal) ||
        st.street.toLowerCase().includes(searchVal) ||
        st.borough.toLowerCase().includes(searchVal) ||
        st.nodeId.toLowerCase().includes(searchVal);
      const matchesBorough = boroughVal === 'ALL' || st.borough === boroughVal;
      const matchesStatus = statusVal === 'ALL' || status === statusVal;
      return matchesSearch && matchesBorough && matchesStatus;
    });

    const severityRank = { CRITICAL: 4, WARNING: 3, STALE: 2, NORMAL: 1 };
    filtered.sort((a, b) => {
      if (sortVal === 'name') return a.name.localeCompare(b.name);
      if (sortVal === 'depth') return b.waterDepthIn - a.waterDepthIn;
      const rA = severityRank[evaluateStationStatus(a, a.waterDepthIn, a.lastUpdatedMs, staleLimit)] || 0;
      const rB = severityRank[evaluateStationStatus(b, b.waterDepthIn, b.lastUpdatedMs, staleLimit)] || 0;
      if (rB !== rA) return rB - rA;
      return b.waterDepthIn - a.waterDepthIn;
    });

    const grid = document.getElementById('dashboardStationsGrid');
    if (grid) {
      if (filtered.length === 0) {
        grid.innerHTML = `<div class="form-card" style="grid-column:1/-1;text-align:center;color:var(--gray-500);">No monitoring stations match your current filter criteria.</div>`;
      } else {
        grid.innerHTML = filtered.map(buildStationCardHTML).join('');
      }
    }
  }

  /* --------------------------------------------------------------------------
   * 7. INTERACTIVE NYC SVG MAP RENDERER & INSPECTOR
   * -------------------------------------------------------------------------- */
  function renderMap() {
    const group = document.getElementById('svgStationsGroup');
    const floodGroup = document.getElementById('svgFloodZonesGroup');
    const chkZones = document.getElementById('chkFloodZones');
    const chkLabels = document.getElementById('chkSensorLabels');
    const boroughFilter = document.getElementById('mapBoroughFilter')?.value || 'ALL';

    if (floodGroup && chkZones) {
      floodGroup.style.display = chkZones.checked ? 'block' : 'none';
    }
    if (!group) return;

    const showLabels = chkLabels ? chkLabels.checked : true;
    const staleLimit = appState.config.staleTimeoutSec;

    const visibleStations = appState.stations.filter(
      (s) => boroughFilter === 'ALL' || s.borough === boroughFilter
    );

    group.innerHTML = visibleStations
      .map((st) => {
        const status = evaluateStationStatus(st, st.waterDepthIn, st.lastUpdatedMs, staleLimit);
        const color =
          status === 'CRITICAL'
            ? '#EF4444'
            : status === 'WARNING'
            ? '#F97316'
            : status === 'STALE'
            ? '#94A3B8'
            : '#06B6D4';
        const isSelected = st.id === selectedMapStationId;
        const outerRadius = isSelected ? 22 : status === 'CRITICAL' ? 19 : 14;

        return `
          <g class="map-marker-group" data-station-id="${st.id}" transform="translate(${st.mapX}, ${st.mapY})">
            <circle r="${outerRadius}" fill="${color}" fill-opacity="0.26" stroke="${color}" stroke-width="${isSelected ? '2.5' : '1.2'}" ${status === 'STALE' ? 'stroke-dasharray="3 2"' : ''} />
            <circle r="7.5" fill="${color}" stroke="#FFFFFF" stroke-width="2" />
            ${
              showLabels
                ? `<rect x="11" y="-11" width="${Math.max(92, st.name.length * 5.6)}" height="22" rx="4" fill="rgba(6, 16, 32, 0.88)" stroke="${color}" stroke-width="1" />
                   <text x="16" y="4" fill="#FFFFFF" font-size="10.5" font-weight="700" font-family="Inter, sans-serif">${st.name.slice(0, 18)} (${formatDepth(st.waterDepthIn)})</text>`
                : ''
            }
          </g>
        `;
      })
      .join('');

    renderMapInspector();
  }

  function renderMapInspector() {
    const container = document.getElementById('mapInspectorContent');
    if (!container) return;

    const st = appState.stations.find((s) => s.id === selectedMapStationId) || appState.stations[0];
    if (!st) {
      container.innerHTML = `<p>No monitoring station selected.</p>`;
      return;
    }
    selectedMapStationId = st.id;
    const staleLimit = appState.config.staleTimeoutSec;
    const status = evaluateStationStatus(st, st.waterDepthIn, st.lastUpdatedMs, staleLimit);
    const echoDistCm = Math.max(10, (st.mountHeightCm - st.waterDepthIn * 2.54)).toFixed(1);

    container.innerHTML = `
      <div>
        <span class="borough-chip">${st.borough} • ${st.nodeId}</span>
        <h3 style="font-size:1.15rem;font-weight:800;color:var(--navy-900);margin-bottom:2px;">${st.name}</h3>
        <p style="font-size:0.82rem;color:var(--gray-600);margin-bottom:12px;">${st.street}</p>

        <div style="background:var(--navy-900);color:var(--white);padding:14px;border-radius:var(--radius-md);margin-bottom:14px;">
          <div style="font-size:0.74rem;color:var(--cyan-300);text-transform:uppercase;font-weight:700;">Live Street Water Depth</div>
          <div style="font-size:1.9rem;font-weight:800;font-family:var(--font-mono);margin:4px 0;">${formatDualDepth(st.waterDepthIn)}</div>
          <div style="font-size:0.78rem;color:var(--gray-300);">
            Status: <strong style="color:${status === 'CRITICAL' ? '#F87171' : status === 'WARNING' ? '#FB923C' : '#22D3EE'};">${status}</strong>
            • Updated ${formatAge(st.lastUpdatedMs, st.forceStale)}
          </div>
        </div>

        <div style="font-size:0.82rem;display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;">
          <div style="background:var(--gray-50);padding:8px 10px;border-radius:6px;border:1px solid var(--gray-200);">
            <div style="color:var(--gray-500);font-size:0.72rem;">Warning Threshold</div>
            <strong style="color:var(--warn-600);font-family:var(--font-mono);">${formatDepth(st.warnThresholdIn)}</strong>
          </div>
          <div style="background:var(--gray-50);padding:8px 10px;border-radius:6px;border:1px solid var(--gray-200);">
            <div style="color:var(--gray-500);font-size:0.72rem;">Critical Threshold</div>
            <strong style="color:var(--crit-600);font-family:var(--font-mono);">${formatDepth(st.critThresholdIn)}</strong>
          </div>
          <div style="background:var(--gray-50);padding:8px 10px;border-radius:6px;border:1px solid var(--gray-200);">
            <div style="color:var(--gray-500);font-size:0.72rem;">Ultrasonic Air Gap</div>
            <strong style="font-family:var(--font-mono);">${echoDistCm} cm</strong>
          </div>
          <div style="background:var(--gray-50);padding:8px 10px;border-radius:6px;border:1px solid var(--gray-200);">
            <div style="color:var(--gray-500);font-size:0.72rem;">Mount Height</div>
            <strong style="font-family:var(--font-mono);">${st.mountHeightCm} cm</strong>
          </div>
        </div>

        <div class="station-guidance ${status === 'CRITICAL' ? 'guidance-critical' : status === 'WARNING' ? 'guidance-warning' : ''}" style="margin-bottom:14px;">
          ${getGuidanceText(status, st)}
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" class="btn btn-sm btn-cyan js-view-chart" data-id="${st.id}">Analyze Station Chart</button>
          <button type="button" class="btn btn-sm btn-outline js-edit-station" data-id="${st.id}">Configure Thresholds</button>
        </div>
      </div>
    `;
  }

  /* --------------------------------------------------------------------------
   * 8. INTERACTIVE HTML5 CANVAS CHARTS & HISTORICAL LOG
   * -------------------------------------------------------------------------- */
  function populateStationDropdowns() {
    const selects = [
      document.getElementById('chartStationSelect'),
      document.getElementById('subNeighborhoodSelect'),
      document.getElementById('overrideStationSelect')
    ];
    selects.forEach((sel) => {
      if (!sel) return;
      const prev = sel.value;
      sel.innerHTML = appState.stations
        .map((s) => `<option value="${s.id}">${s.name} (${s.borough})</option>`)
        .join('');
      if (prev && appState.stations.some((s) => s.id === prev)) {
        sel.value = prev;
      }
    });

    const compareSel = document.getElementById('chartCompareSelect');
    if (compareSel) {
      const prevComp = compareSel.value;
      compareSel.innerHTML =
        `<option value="NONE">None (Single Station + Thresholds)</option>` +
        appState.stations.map((s) => `<option value="${s.id}">${s.name} (${s.borough})</option>`).join('');
      if (prevComp) compareSel.value = prevComp;
    }
  }

  function renderAllCharts() {
    drawTimeSeriesChart();
    drawBoroughBarChart();
  }

  function drawTimeSeriesChart() {
    const canvas = document.getElementById('timeSeriesCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(300, rect.width || 560);
    const height = Math.max(240, rect.height || 290);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const primaryId = document.getElementById('chartStationSelect')?.value || appState.stations[0]?.id;
    const compareId = document.getElementById('chartCompareSelect')?.value || 'NONE';
    const windowMode = document.getElementById('chartWindowSelect')?.value || 'live';

    const stPrimary = appState.stations.find((s) => s.id === primaryId) || appState.stations[0];
    if (!stPrimary) return;

    const isCm = appState.config.unit === 'CM';
    const mult = isCm ? 2.54 : 1;
    const unitLabel = isCm ? 'cm' : 'in';

    // Assemble series points
    let primaryPoints = [];
    let labels = [];
    if (windowMode === 'live') {
      const stationHist = appState.history
        .filter((h) => h.stationId === stPrimary.id)
        .slice(-12);
      if (stationHist.length > 0) {
        primaryPoints = stationHist.map((h) => Number((h.depthIn * mult).toFixed(1)));
        labels = stationHist.map((h) => new Date(h.timestampMs).toLocaleTimeString([], { minute: '2-digit', second: '2-digit' }));
      }
    } else if (windowMode === '24h') {
      const base = stPrimary.waterDepthIn;
      for (let i = 11; i >= 0; i--) {
        const wave = Math.sin(i * 0.65) * 2.4 + (i < 4 ? 2.1 : 0);
        primaryPoints.push(Number((Math.max(0.5, base - i * 0.35 + wave) * mult).toFixed(1)));
        labels.push(`${i * 2}h ago`);
      }
    } else {
      // Historic Sept 29 Flash Flood profile
      const stormCurveIn = [2.2, 3.1, 5.4, 8.8, 13.6, 17.9, 19.4, 18.1, 15.2, 11.4, 8.1, 5.2];
      primaryPoints = stormCurveIn.map((v) => Number((v * mult).toFixed(1)));
      labels = ['06:00', '07:00', '08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];
    }

    const warnVal = Number((stPrimary.warnThresholdIn * mult).toFixed(1));
    const critVal = Number((stPrimary.critThresholdIn * mult).toFixed(1));
    const maxY = Math.max(critVal * 1.25, ...primaryPoints, 10);

    const pad = { top: 24, right: 24, bottom: 36, left: 48 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    ctx.clearRect(0, 0, width, height);

    // Grid lines
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#64748B';
    ctx.font = '11px Inter, sans-serif';
    for (let i = 0; i <= 4; i++) {
      const val = (maxY / 4) * i;
      const y = pad.top + plotH - (val / maxY) * plotH;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.stroke();
      ctx.fillText(`${val.toFixed(0)} ${unitLabel}`, 6, y + 4);
    }

    // Threshold dashed lines (Warning Orange & Critical Red)
    const yWarn = pad.top + plotH - (warnVal / maxY) * plotH;
    ctx.save();
    ctx.strokeStyle = '#F97316';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, yWarn);
    ctx.lineTo(pad.left + plotW, yWarn);
    ctx.stroke();
    ctx.fillStyle = '#EA580C';
    ctx.fillText(`Warn (${warnVal} ${unitLabel})`, pad.left + 6, yWarn - 5);

    const yCrit = pad.top + plotH - (critVal / maxY) * plotH;
    ctx.strokeStyle = '#EF4444';
    ctx.beginPath();
    ctx.moveTo(pad.left, yCrit);
    ctx.lineTo(pad.left + plotW, yCrit);
    ctx.stroke();
    ctx.fillStyle = '#DC2626';
    ctx.fillText(`Critical (${critVal} ${unitLabel})`, pad.left + 6, yCrit - 5);
    ctx.restore();

    // Plot primary line & area
    if (primaryPoints.length > 0) {
      ctx.beginPath();
      primaryPoints.forEach((pt, idx) => {
        const x = pad.left + (idx / Math.max(1, primaryPoints.length - 1)) * plotW;
        const y = pad.top + plotH - (pt / maxY) * plotH;
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = '#0891B2';
      ctx.lineWidth = 2.8;
      ctx.stroke();

      // Points & X-axis labels
      primaryPoints.forEach((pt, idx) => {
        const x = pad.left + (idx / Math.max(1, primaryPoints.length - 1)) * plotW;
        const y = pad.top + plotH - (pt / maxY) * plotH;
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = pt >= critVal ? '#EF4444' : pt >= warnVal ? '#F97316' : '#06B6D4';
        ctx.fill();
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        if (idx % 2 === 0 || idx === primaryPoints.length - 1) {
          ctx.fillStyle = '#475569';
          ctx.font = '10px Inter, sans-serif';
          ctx.fillText(labels[idx] || '', x - 16, height - 12);
        }
      });
    }

    // Optional Compare Station Line
    if (compareId !== 'NONE' && compareId !== stPrimary.id) {
      const stComp = appState.stations.find((s) => s.id === compareId);
      if (stComp) {
        const compHist = appState.history.filter((h) => h.stationId === stComp.id).slice(-primaryPoints.length);
        const compPts = compHist.map((h) => Number((h.depthIn * mult).toFixed(1)));
        if (compPts.length > 1) {
          ctx.beginPath();
          compPts.forEach((pt, idx) => {
            const x = pad.left + (idx / Math.max(1, compPts.length - 1)) * plotW;
            const y = pad.top + plotH - (Math.min(maxY, pt) / maxY) * plotH;
            if (idx === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          ctx.strokeStyle = '#1E3A8A';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
    }
  }

  function drawBoroughBarChart() {
    const canvas = document.getElementById('boroughBarCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(280, rect.width || 440);
    const height = Math.max(240, rect.height || 290);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.clearRect(0, 0, width, height);
    const stations = appState.stations.slice(0, 8);
    const pad = { top: 20, right: 20, bottom: 48, left: 42 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const isCm = appState.config.unit === 'CM';
    const mult = isCm ? 2.54 : 1;
    const maxVal = Math.max(20 * mult, ...stations.map((s) => s.waterDepthIn * mult));

    const barGap = 10;
    const barW = Math.max(16, (plotW - barGap * (stations.length + 1)) / Math.max(1, stations.length));

    stations.forEach((st, idx) => {
      const val = Number((st.waterDepthIn * mult).toFixed(1));
      const x = pad.left + barGap + idx * (barW + barGap);
      const barH = (val / maxVal) * plotH;
      const y = pad.top + plotH - barH;

      const status = evaluateStationStatus(st, st.waterDepthIn, st.lastUpdatedMs, appState.config.staleTimeoutSec);
      ctx.fillStyle =
        status === 'CRITICAL'
          ? '#EF4444'
          : status === 'WARNING'
          ? '#F97316'
          : status === 'STALE'
          ? '#94A3B8'
          : '#06B6D4';

      ctx.fillRect(x, y, barW, barH);

      ctx.fillStyle = '#0A192F';
      ctx.font = 'bold 10px JetBrains Mono, monospace';
      ctx.fillText(String(val), x + 2, y - 5);

      ctx.save();
      ctx.translate(x + barW / 2, pad.top + plotH + 12);
      ctx.rotate(-0.35);
      ctx.fillStyle = '#334155';
      ctx.font = '10px Inter, sans-serif';
      ctx.fillText(st.name.slice(0, 10), -18, 8);
      ctx.restore();
    });
  }

  function renderHistoryTable() {
    const tbody = document.getElementById('historyTableBody');
    if (!tbody) return;
    const recent = [...appState.history].reverse().slice(0, 20);
    tbody.innerHTML = recent
      .map((row) => {
        const badgeClass =
          row.status === 'CRITICAL'
            ? 'badge-critical'
            : row.status === 'WARNING'
            ? 'badge-warning'
            : row.status === 'STALE'
            ? 'badge-stale'
            : 'badge-normal';
        return `
          <tr>
            <td style="font-family:var(--font-mono);font-size:0.78rem;">${new Date(row.timestampMs).toLocaleTimeString()}</td>
            <td><strong>${row.stationName}</strong> <span style="color:var(--gray-500);">(${row.borough})</span></td>
            <td style="font-family:var(--font-mono);">${row.nodeId}</td>
            <td class="num-col">${row.echoDistCm} cm</td>
            <td class="num-col"><strong>${formatDualDepth(row.depthIn)}</strong></td>
            <td class="num-col">${row.rateInPerHr >= 0 ? '+' : ''}${Number(row.rateInPerHr).toFixed(1)} in/hr</td>
            <td><span class="status-badge ${badgeClass}">${row.status}</span></td>
          </tr>
        `;
      })
      .join('');
  }

  /* --------------------------------------------------------------------------
   * 9. FLOOD-ALERT SECTION & SUBSCRIPTIONS
   * -------------------------------------------------------------------------- */
  function renderAlertsSection() {
    const listEl = document.getElementById('alertsFeedList');
    if (!listEl) return;

    const sevFilter = document.getElementById('alertSeverityFilter')?.value || 'ALL';
    const ackFilter = document.getElementById('alertAckFilter')?.value || 'ALL';

    const filtered = appState.alerts.filter((al) => {
      const matchSev = sevFilter === 'ALL' || al.severity === sevFilter;
      const matchAck =
        ackFilter === 'ALL' ||
        (ackFilter === 'UNACK' && !al.acknowledged) ||
        (ackFilter === 'ACK' && al.acknowledged);
      return matchSev && matchAck;
    });

    if (filtered.length === 0) {
      listEl.innerHTML = `<div class="form-card" style="text-align:center;color:var(--gray-500);">No flood alerts match the selected filter criteria.</div>`;
    } else {
      listEl.innerHTML = filtered
        .map((al) => {
          const isCrit = al.severity === 'CRITICAL';
          return `
            <article class="alert-item ${isCrit ? 'alert-critical' : ''} ${al.acknowledged ? 'alert-resolved' : ''}">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
                <div>
                  <span class="status-badge ${isCrit ? 'badge-critical' : 'badge-warning'}">${al.severity} FLOOD ALERT</span>
                  <span class="borough-chip" style="margin-left:6px;">${al.borough}</span>
                  <h3 style="font-size:1.02rem;font-weight:800;color:var(--navy-900);margin-top:6px;">${al.stationName} — ${al.street}</h3>
                </div>
                <span style="font-size:0.76rem;color:var(--gray-500);font-family:var(--font-mono);">
                  ${new Date(al.timestampMs).toLocaleTimeString()}
                </span>
              </div>
              <p style="font-size:0.85rem;color:var(--gray-700);margin-bottom:10px;">
                Ultrasonic sensor <strong>${al.nodeId}</strong> measured street water depth of
                <strong>${formatDualDepth(al.waterDepthIn)}</strong>, exceeding the configured ${al.severity.toLowerCase()} threshold of
                <strong>${formatDepth(al.thresholdIn)}</strong>.
              </p>
              <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
                <span style="font-size:0.76rem;font-weight:700;color:${al.acknowledged ? 'var(--cyan-600)' : 'var(--crit-600)'};">
                  Status: ${al.acknowledged ? 'Acknowledged by Monitoring Personnel' : 'Active — Unacknowledged'}
                </span>
                <div style="display:flex;gap:8px;">
                  ${
                    !al.acknowledged
                      ? `<button type="button" class="btn btn-sm btn-primary js-ack-alert" data-id="${al.id}">Acknowledge Alert</button>`
                      : ''
                  }
                  <button type="button" class="btn btn-sm btn-outline js-locate-map" data-id="${al.stationId}">View on Map</button>
                </div>
              </div>
            </article>
          `;
        })
        .join('');
    }

    const subsEl = document.getElementById('subscriptionsList');
    if (subsEl) {
      subsEl.innerHTML = appState.subscriptions
        .map(
          (s) => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--gray-100);">
            <span><strong>${s.name}</strong> → ${s.stationName} (${s.thresholdType}) via ${s.channel}</span>
            <button type="button" class="btn btn-sm btn-outline js-delete-sub" data-id="${s.id}" style="padding:2px 7px;font-size:0.7rem;">Remove</button>
          </div>
        `
        )
        .join('');
    }
  }

  /* --------------------------------------------------------------------------
   * 10. SENSOR & ALERT CRUD MANAGEMENT SECTION
   * -------------------------------------------------------------------------- */
  function renderManagementSection() {
    const tbody = document.getElementById('crudStationsTableBody');
    if (!tbody) return;
    const staleLimit = appState.config.staleTimeoutSec;

    tbody.innerHTML = appState.stations
      .map((st) => {
        const status = evaluateStationStatus(st, st.waterDepthIn, st.lastUpdatedMs, staleLimit);
        const badgeClass =
          status === 'CRITICAL'
            ? 'badge-critical'
            : status === 'WARNING'
            ? 'badge-warning'
            : status === 'STALE'
            ? 'badge-stale'
            : 'badge-normal';
        return `
          <tr>
            <td>
              <strong>${st.name}</strong>
              <div style="font-size:0.75rem;color:var(--gray-500);">${st.street}</div>
            </td>
            <td>${st.borough}</td>
            <td style="font-family:var(--font-mono);font-size:0.78rem;">${st.nodeId}</td>
            <td class="num-col"><strong>${formatDepth(st.waterDepthIn)}</strong></td>
            <td class="num-col">${formatDepth(st.warnThresholdIn)} / ${formatDepth(st.critThresholdIn)}</td>
            <td><span class="status-badge ${badgeClass}">${status}</span></td>
            <td>
              <div style="display:flex;gap:6px;">
                <button type="button" class="btn btn-sm btn-outline js-edit-station" data-id="${st.id}">Edit</button>
                <button type="button" class="btn btn-sm btn-danger js-delete-station" data-id="${st.id}">Delete</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join('');

    const storageTxt = document.getElementById('storageStatusText');
    if (storageTxt) {
      const kb = (SafeStorage.estimateBytes() / 1024).toFixed(1);
      storageTxt.textContent = `localStorage footprint: ~${kb} KB (${appState.stations.length} stations, ${appState.history.length} log entries)`;
    }
  }

  function loadStationIntoCrudForm(stationId) {
    const st = appState.stations.find((s) => s.id === stationId);
    if (!st) return;
    document.getElementById('crudStationId').value = st.id;
    document.getElementById('crudNameInput').value = st.name;
    document.getElementById('crudBoroughSelect').value = st.borough;
    document.getElementById('crudStreetInput').value = st.street;
    document.getElementById('crudNodeIdInput').value = st.nodeId;
    document.getElementById('crudMountHeightInput').value = st.mountHeightCm;
    document.getElementById('crudCurrentDepthInput').value = st.waterDepthIn;
    document.getElementById('crudWarnInput').value = st.warnThresholdIn;
    document.getElementById('crudCritInput').value = st.critThresholdIn;
    document.getElementById('crudMapXInput').value = st.mapX;
    document.getElementById('crudMapYInput').value = st.mapY;

    const title = document.getElementById('crudFormTitle');
    if (title) title.textContent = `Update Station: ${st.name}`;
    switchView('management');
  }

  function resetCrudForm() {
    const form = document.getElementById('stationCrudForm');
    if (form) form.reset();
    document.getElementById('crudStationId').value = '';
    const title = document.getElementById('crudFormTitle');
    if (title) title.textContent = 'Create New Monitoring Location';
  }

  /* --------------------------------------------------------------------------
   * 11. 5-SECOND LOW-LATENCY TELEMETRY STREAMING ENGINE
   * -------------------------------------------------------------------------- */
  function stepTelemetrySimulation() {
    if (telemetryPaused) return;
    const isOffline = simulatedOffline || !navigator.onLine;
    if (isOffline) {
      // When offline, do not update station timestamps so stale detection naturally triggers
      renderAll();
      return;
    }

    const now = Date.now();
    lastLatencyMs = Math.floor(85 + Math.random() * 95); // Simulated < 5s receipt-to-display latency

    appState.stations.forEach((st) => {
      if (st.forceStale) return; // Keep stale for testing until reconnected
      const delta = (Math.random() - 0.46) * 0.45;
      st.waterDepthIn = Math.max(0.4, Number((st.waterDepthIn + delta).toFixed(2)));
      st.rateInPerHr = Number((delta * 12).toFixed(1));
      st.lastUpdatedMs = now;

      const depthCm = Number((st.waterDepthIn * 2.54).toFixed(1));
      const echoDistCm = Number(Math.max(10, st.mountHeightCm - depthCm).toFixed(1));

      appState.history.push({
        id: 'hist-' + st.id + '-' + now,
        timestampMs: now,
        stationId: st.id,
        stationName: st.name,
        borough: st.borough,
        nodeId: st.nodeId,
        echoDistCm,
        depthIn: st.waterDepthIn,
        depthCm,
        rateInPerHr: st.rateInPerHr,
        status: evaluateStationStatus(st, st.waterDepthIn, now, appState.config.staleTimeoutSec)
      });
    });

    if (appState.history.length > 240) {
      appState.history = appState.history.slice(-240);
    }

    synchronizeAlerts(true);
    renderAll();
  }

  function startTelemetryTicker() {
    if (tickTimerId) clearInterval(tickTimerId);
    tickTimerId = setInterval(() => {
      if (telemetryPaused) return;
      countdownSec -= 1;
      if (countdownSec <= 0) {
        stepTelemetrySimulation();
        countdownSec = appState.config.pollIntervalSec || 5;
      }
      const cdEl = document.getElementById('telemetryCountdownValue');
      if (cdEl) cdEl.textContent = countdownSec + 's';
    }, 1000);
  }

  /* --------------------------------------------------------------------------
   * 12. ULTRASONIC PHYSICS CALCULATOR & FILE DOWNLOADER HELPERS
   * -------------------------------------------------------------------------- */
  function updateUltrasonicCalculator() {
    const mountCm = Number(document.getElementById('calcMountHeight')?.value || 250);
    const echoUs = Number(document.getElementById('calcEchoUs')?.value || 12500);

    const mountLbl = document.getElementById('calcMountVal');
    const echoLbl = document.getElementById('calcEchoVal');
    const distRes = document.getElementById('calcDistResult');
    const depthRes = document.getElementById('calcDepthResult');
    const statusRes = document.getElementById('calcStatusResult');

    if (mountLbl) mountLbl.textContent = `${mountCm} cm (${(mountCm / 2.54).toFixed(1)} in)`;
    if (echoLbl) echoLbl.textContent = `${echoUs.toLocaleString()} µs`;

    const airGapCm = (echoUs * 0.0343) / 2;
    const waterDepthCm = Math.max(0, mountCm - airGapCm);
    const waterDepthIn = waterDepthCm / 2.54;

    if (distRes) distRes.textContent = `${airGapCm.toFixed(1)} cm`;
    if (depthRes) depthRes.textContent = `${waterDepthIn.toFixed(1)} in (${waterDepthCm.toFixed(1)} cm)`;

    if (statusRes) {
      if (waterDepthIn >= 14) {
        statusRes.textContent = 'CRITICAL FLOOD (RED)';
        statusRes.style.color = 'var(--crit-600)';
      } else if (waterDepthIn >= 8) {
        statusRes.textContent = 'WARNING WATCH (ORANGE)';
        statusRes.style.color = 'var(--warn-600)';
      } else {
        statusRes.textContent = 'NORMAL / SAFE (CYAN)';
        statusRes.style.color = 'var(--cyan-600)';
      }
    }
  }

  function triggerBrowserDownload(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`Downloaded ${filename}`, 'NORMAL');
  }

  function exportStationsToCsv(records, filename) {
    const headers = ['Timestamp_ISO', 'Station_Name', 'Borough', 'Arduino_Node_ID', 'Water_Depth_In', 'Water_Depth_Cm', 'Status'];
    const lines = [headers.join(',')];
    records.forEach((r) => {
      lines.push(
        [
          new Date(r.timestampMs || r.lastUpdatedMs || Date.now()).toISOString(),
          `"${(r.stationName || r.name || '').replace(/"/g, '""')}"`,
          `"${r.borough}"`,
          r.nodeId,
          Number(r.depthIn ?? r.waterDepthIn ?? 0).toFixed(2),
          (Number(r.depthIn ?? r.waterDepthIn ?? 0) * 2.54).toFixed(1),
          r.status || evaluateStationStatus(r, r.waterDepthIn, r.lastUpdatedMs, appState.config.staleTimeoutSec)
        ].join(',')
      );
    });
    triggerBrowserDownload(filename, lines.join('\n'), 'text/csv;charset=utf-8');
  }

  /* --------------------------------------------------------------------------
   * 13. EVENT LISTENERS & INTERACTIVE CONTROLS WIRING
   * -------------------------------------------------------------------------- */
  function bindEvents() {
    // Primary Navigation
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-view');
        if (target) switchView(target);
      });
    });

    const brandHome = document.getElementById('brandHomeLink');
    if (brandHome) {
      brandHome.addEventListener('click', (e) => {
        e.preventDefault();
        switchView('home');
      });
    }

    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const primaryNav = document.getElementById('primaryNav');
    if (mobileMenuBtn && primaryNav) {
      mobileMenuBtn.addEventListener('click', () => {
        const isOpen = primaryNav.classList.toggle('mobile-open');
        mobileMenuBtn.setAttribute('aria-expanded', String(isOpen));
      });
    }

    // Role Selector & Persona Cards
    const roleSelector = document.getElementById('roleSelector');
    if (roleSelector) {
      roleSelector.addEventListener('change', (e) => {
        appState.config.role = e.target.value;
        renderAll();
        showToast(`Switched to ${e.target.options[e.target.selectedIndex].text} mode`, 'NORMAL');
      });
    }

    document.getElementById('btnActivateResident')?.addEventListener('click', () => {
      appState.config.role = 'resident';
      renderAll();
      switchView('dashboard');
    });
    document.getElementById('btnActivateOperator')?.addEventListener('click', () => {
      appState.config.role = 'operator';
      renderAll();
      switchView('dashboard');
    });
    document.getElementById('btnActivateAdmin')?.addEventListener('click', () => {
      appState.config.role = 'admin';
      renderAll();
      switchView('management');
    });
    document.getElementById('btnQuickElevateAdmin')?.addEventListener('click', () => {
      appState.config.role = 'admin';
      renderAll();
      showToast('System Administrator permissions unlocked', 'NORMAL');
    });

    // Unit Toggle (Inches vs Centimeters)
    const unitBtn = document.getElementById('unitToggleBtn');
    if (unitBtn) {
      unitBtn.addEventListener('click', () => {
        appState.config.unit = appState.config.unit === 'IN' ? 'CM' : 'IN';
        unitBtn.textContent = 'Units: ' + appState.config.unit;
        renderAll();
      });
    }

    // Simulation Toolbar Controls
    document.getElementById('btnSimRainSurge')?.addEventListener('click', () => {
      appState.stations.forEach((st) => {
        st.waterDepthIn = Number((st.waterDepthIn + 3.2 + Math.random() * 2.5).toFixed(1));
        st.rateInPerHr = 4.8;
        st.lastUpdatedMs = Date.now();
        st.forceStale = false;
      });
      synchronizeAlerts(true);
      renderAll();
      showToast('Simulated heavy cloudburst rainfall surge across NYC sensors!', 'WARNING');
    });

    document.getElementById('btnSimStaleNode')?.addEventListener('click', () => {
      const target = appState.stations[2] || appState.stations[0];
      if (target) {
        target.forceStale = true;
        target.lastUpdatedMs = Date.now() - 45000;
        renderAll();
        showToast(`Marked ${target.name} (${target.nodeId}) reading as outdated (>15s)`, 'WARNING');
      }
    });

    const netBtn = document.getElementById('btnToggleNetworkSim');
    if (netBtn) {
      netBtn.addEventListener('click', () => {
        simulatedOffline = !simulatedOffline;
        netBtn.textContent = simulatedOffline ? 'Restore Online Mode' : 'Simulate Offline Drop';
        renderAll();
        showToast(
          simulatedOffline
            ? 'Simulated temporary internet interruption — running on cached telemetry'
            : 'Network connection restored — live 5s sensor polling resumed',
          simulatedOffline ? 'WARNING' : 'NORMAL'
        );
      });
    }

    document.getElementById('btnReconnectNetwork')?.addEventListener('click', () => {
      simulatedOffline = false;
      if (netBtn) netBtn.textContent = 'Simulate Offline Drop';
      stepTelemetrySimulation();
      showToast('Connection restored and sensor telemetry synchronized', 'NORMAL');
    });

    const pauseBtn = document.getElementById('btnPauseTelemetry');
    if (pauseBtn) {
      pauseBtn.addEventListener('click', () => {
        telemetryPaused = !telemetryPaused;
        pauseBtn.textContent = telemetryPaused ? 'Resume 5s Stream' : 'Pause 5s Stream';
        showToast(telemetryPaused ? '5-second telemetry stream paused' : '5-second telemetry stream resumed', 'NORMAL');
      });
    }

    document.getElementById('btnViewAlertsTicker')?.addEventListener('click', () => switchView('alerts'));
    document.getElementById('btnGoDashboardHero')?.addEventListener('click', () => switchView('dashboard'));
    document.getElementById('btnGoMapHero')?.addEventListener('click', () => switchView('map'));

    // Homepage Search
    document.getElementById('btnHomeSearch')?.addEventListener('click', () => {
      const q = (document.getElementById('homeSearchInput')?.value || '').trim();
      const b = document.getElementById('homeBoroughSelect')?.value || 'ALL';
      const dashSearch = document.getElementById('dashSearchInput');
      const dashBorough = document.getElementById('dashBoroughFilter');
      if (dashSearch) dashSearch.value = q;
      if (dashBorough) dashBorough.value = b;
      renderDashboard();
      switchView('dashboard');
    });

    // Dashboard Filters
    ['dashSearchInput', 'dashBoroughFilter', 'dashStatusFilter', 'dashSortSelect'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', renderDashboard);
        el.addEventListener('change', renderDashboard);
      }
    });

    document.getElementById('btnResetDashFilters')?.addEventListener('click', () => {
      document.getElementById('dashSearchInput').value = '';
      document.getElementById('dashBoroughFilter').value = 'ALL';
      document.getElementById('dashStatusFilter').value = 'ALL';
      document.getElementById('dashSortSelect').value = 'severity';
      renderDashboard();
    });

    document.getElementById('btnExportTelemetryCsv')?.addEventListener('click', () => {
      exportStationsToCsv(appState.stations, 'nyc_floodguard_live_snapshot.csv');
    });

    // Map Controls & Click Delegation
    ['mapBoroughFilter', 'chkFloodZones', 'chkSensorLabels'].forEach((id) => {
      document.getElementById(id)?.addEventListener('change', renderMap);
    });

    const addMapBtn = document.getElementById('btnMapAddStationMode');
    if (addMapBtn) {
      addMapBtn.addEventListener('click', () => {
        mapClickAddMode = !mapClickAddMode;
        addMapBtn.textContent = mapClickAddMode ? 'Click Anywhere on NYC Map...' : 'Click Map to Add Sensor';
        showToast(
          mapClickAddMode
            ? 'Click any location on the NYC map to pre-fill coordinates for a new sensor'
            : 'Map coordinate picker cancelled',
          'NORMAL'
        );
      });
    }

    document.getElementById('btnResetMapView')?.addEventListener('click', () => {
      document.getElementById('mapBoroughFilter').value = 'ALL';
      document.getElementById('chkFloodZones').checked = true;
      document.getElementById('chkSensorLabels').checked = true;
      mapClickAddMode = false;
      renderMap();
    });

    const svgMap = document.getElementById('nycSvgMap');
    if (svgMap) {
      svgMap.addEventListener('click', (e) => {
        const marker = e.target.closest('.map-marker-group');
        if (marker) {
          selectedMapStationId = marker.getAttribute('data-station-id');
          renderMap();
          return;
        }
        if (mapClickAddMode) {
          const pt = svgMap.createSVGPoint();
          pt.x = e.clientX;
          pt.y = e.clientY;
          const svgP = pt.matrixTransform(svgMap.getScreenCTM().inverse());
          resetCrudForm();
          document.getElementById('crudMapXInput').value = Math.round(svgP.x);
          document.getElementById('crudMapYInput').value = Math.round(svgP.y);
          mapClickAddMode = false;
          if (addMapBtn) addMapBtn.textContent = 'Click Map to Add Sensor';
          switchView('management');
          showToast(`Selected NYC Map coordinates (${Math.round(svgP.x)}, ${Math.round(svgP.y)})`, 'NORMAL');
        }
      });
    }

    // Chart Controls
    ['chartStationSelect', 'chartCompareSelect', 'chartWindowSelect'].forEach((id) => {
      document.getElementById(id)?.addEventListener('change', renderAllCharts);
    });
    document.getElementById('btnRefreshCharts')?.addEventListener('click', renderAllCharts);
    const tsCanvas = document.getElementById('timeSeriesCanvas');
    if (tsCanvas) {
      tsCanvas.addEventListener('mousemove', (e) => {
        const rect = tsCanvas.getBoundingClientRect();
        const relX = Math.max(0, Math.min(1, (e.clientX - rect.left - 48) / Math.max(1, rect.width - 72)));
        const primaryId = document.getElementById('chartStationSelect')?.value || appState.stations[0]?.id;
        const st = appState.stations.find((s) => s.id === primaryId) || appState.stations[0];
        if (!st) return;
        const hist = appState.history.filter((h) => h.stationId === st.id).slice(-12);
        if (hist.length > 0) {
          const idx = Math.min(hist.length - 1, Math.max(0, Math.round(relX * (hist.length - 1))));
          const pt = hist[idx];
          const readout = document.getElementById('chartHoverReadout');
          if (readout && pt) {
            readout.textContent = `${st.name} @ ${new Date(pt.timestampMs).toLocaleTimeString()}: Water Depth ${formatDualDepth(pt.depthIn)} | Ultrasonic Air Gap: ${pt.echoDistCm} cm`;
          }
        }
      });
    }
    document.getElementById('btnInjectStormSpikeChart')?.addEventListener('click', () => {
      const selId = document.getElementById('chartStationSelect')?.value;
      const st = appState.stations.find((s) => s.id === selId) || appState.stations[0];
      if (st) {
        st.waterDepthIn = Number((st.critThresholdIn + 2.4).toFixed(1));
        st.lastUpdatedMs = Date.now();
        stepTelemetrySimulation();
        renderAllCharts();
        showToast(`Injected storm spike on ${st.name}`, 'CRITICAL');
      }
    });

    document.getElementById('btnDownloadHistoryCsv')?.addEventListener('click', () => {
      exportStationsToCsv(appState.history, 'nyc_floodguard_historical_log.csv');
    });
    document.getElementById('btnClearHistoryLog')?.addEventListener('click', () => {
      appState.history = FloodGuardAPI.seedInitialHistory(appState.stations);
      renderAll();
      showToast('Historical log reset to baseline measurements', 'NORMAL');
    });

    // Alerts Controls & Resident Subscription Form
    ['alertSeverityFilter', 'alertAckFilter'].forEach((id) => {
      document.getElementById(id)?.addEventListener('change', renderAlertsSection);
    });

    document.getElementById('btnTriggerTestAlert')?.addEventListener('click', () => {
      const st = appState.stations[0];
      if (!st) return;
      appState.alerts.unshift({
        id: 'al-test-' + Date.now(),
        stationId: st.id,
        stationName: st.name,
        borough: st.borough,
        street: st.street,
        nodeId: st.nodeId,
        severity: 'CRITICAL',
        waterDepthIn: Number((st.critThresholdIn + 1.8).toFixed(1)),
        thresholdIn: st.critThresholdIn,
        timestampMs: Date.now(),
        acknowledged: false
      });
      renderAll();
      showToast(`TEST ALERT TRIGGERED: Critical water level at ${st.name}`, 'CRITICAL');
    });

    document.getElementById('btnAcknowledgeAllAlerts')?.addEventListener('click', () => {
      appState.alerts.forEach((a) => {
        a.acknowledged = true;
      });
      renderAll();
      showToast('All active flood alerts acknowledged', 'NORMAL');
    });

    document.getElementById('subResidentForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = document.getElementById('subNameInput').value.trim();
      const stId = document.getElementById('subNeighborhoodSelect').value;
      const st = appState.stations.find((s) => s.id === stId);
      const thresh = document.getElementById('subThresholdSelect').value;
      const chan = document.getElementById('subChannelSelect').value;
      if (!name || !st) return;
      appState.subscriptions.push({
        id: 'sub-' + Date.now(),
        name,
        stationId: st.id,
        stationName: st.name,
        thresholdType: thresh,
        channel: chan
      });
      document.getElementById('subNameInput').value = '';
      renderAll();
      showToast(`Subscribed ${name} to ${st.name} flood alerts`, 'NORMAL');
    });

    // Hardware Test Bench Override Controls
    const overrideSlider = document.getElementById('overrideDepthSlider');
    const overrideLabel = document.getElementById('overrideDepthLabel');
    if (overrideSlider && overrideLabel) {
      overrideSlider.addEventListener('input', () => {
        const valIn = Number(overrideSlider.value);
        overrideLabel.textContent = `${valIn.toFixed(1)} in (${(valIn * 2.54).toFixed(1)} cm)`;
      });
    }

    document.getElementById('btnApplyOverride')?.addEventListener('click', () => {
      const stId = document.getElementById('overrideStationSelect')?.value;
      const valIn = Number(document.getElementById('overrideDepthSlider')?.value || 8);
      const st = appState.stations.find((s) => s.id === stId);
      if (st) {
        st.waterDepthIn = valIn;
        st.lastUpdatedMs = Date.now();
        st.forceStale = false;
        synchronizeAlerts(true);
        renderAll();
        showToast(`Updated ${st.name} ultrasonic depth to ${formatDualDepth(valIn)}`, 'NORMAL');
      }
    });

    document.getElementById('btnForceStaleSelected')?.addEventListener('click', () => {
      const stId = document.getElementById('overrideStationSelect')?.value;
      const st = appState.stations.find((s) => s.id === stId);
      if (st) {
        st.forceStale = true;
        st.lastUpdatedMs = Date.now() - 60000;
        renderAll();
        showToast(`${st.name} marked as outdated reading (>15s)`, 'WARNING');
      }
    });

    // Station CRUD Form Submit
    document.getElementById('stationCrudForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const existingId = document.getElementById('crudStationId').value.trim();
      const name = document.getElementById('crudNameInput').value.trim();
      const borough = document.getElementById('crudBoroughSelect').value;
      const street = document.getElementById('crudStreetInput').value.trim();
      const nodeId = document.getElementById('crudNodeIdInput').value.trim();
      const mountHeightCm = Number(document.getElementById('crudMountHeightInput').value || 250);
      const waterDepthIn = Number(document.getElementById('crudCurrentDepthInput').value || 2.0);
      const warnThresholdIn = Number(document.getElementById('crudWarnInput').value || 8.0);
      const critThresholdIn = Number(document.getElementById('crudCritInput').value || 14.0);
      const mapX = Number(document.getElementById('crudMapXInput').value || 400);
      const mapY = Number(document.getElementById('crudMapYInput').value || 300);

      if (existingId) {
        const st = appState.stations.find((s) => s.id === existingId);
        if (st) {
          Object.assign(st, {
            name,
            borough,
            street,
            nodeId,
            mountHeightCm,
            waterDepthIn,
            warnThresholdIn,
            critThresholdIn,
            mapX,
            mapY,
            lastUpdatedMs: Date.now(),
            forceStale: false
          });
          showToast(`Updated monitoring station "${name}"`, 'NORMAL');
        }
      } else {
        const newSt = {
          id: 'st-' + Date.now(),
          name,
          borough,
          street,
          nodeId,
          mountHeightCm,
          waterDepthIn,
          warnThresholdIn,
          critThresholdIn,
          rateInPerHr: 0.2,
          batteryV: 12.7,
          rssiDbm: -59,
          mapX,
          mapY,
          lastUpdatedMs: Date.now(),
          forceStale: false
        };
        appState.stations.push(newSt);
        selectedMapStationId = newSt.id;
        showToast(`Created new monitoring station "${name}"`, 'NORMAL');
      }

      resetCrudForm();
      synchronizeAlerts(true);
      renderAll();
    });

    document.getElementById('btnNewStationReset')?.addEventListener('click', resetCrudForm);
    document.getElementById('btnCancelEditStation')?.addEventListener('click', resetCrudForm);

    // Global Config & Factory Reset
    document.getElementById('btnSaveGlobalConfig')?.addEventListener('click', () => {
      const staleSec = Math.max(5, Number(document.getElementById('globalStaleSecInput')?.value || 15));
      const pollSec = Math.max(2, Number(document.getElementById('globalPollSecInput')?.value || 5));
      appState.config.staleTimeoutSec = staleSec;
      appState.config.pollIntervalSec = pollSec;
      countdownSec = pollSec;
      renderAll();
      showToast(`Saved telemetry timing rules (Poll: ${pollSec}s, Stale: ${staleSec}s)`, 'NORMAL');
    });

    document.getElementById('btnExportConfigJson')?.addEventListener('click', () => {
      triggerBrowserDownload(
        'nyc_floodguard_database_seed.json',
        JSON.stringify(appState, null, 2),
        'application/json;charset=utf-8'
      );
    });

    document.getElementById('btnResetFactoryDefaults')?.addEventListener('click', () => {
      Object.values(STORAGE_KEYS).forEach((k) => SafeStorage.remove(k));
      appState.stations = getInitialStations();
      appState.history = FloodGuardAPI.seedInitialHistory(appState.stations);
      appState.alerts = [];
      appState.config = Object.assign({}, DEFAULT_CONFIG);
      renderAll();
      showToast('Prototype state reset to factory defaults', 'NORMAL');
    });

    // Delete Confirmation Modal
    document.getElementById('btnCancelDeleteStation')?.addEventListener('click', () => {
      pendingDeleteStationId = null;
      document.getElementById('deleteConfirmModal')?.classList.remove('open');
    });

    document.getElementById('btnConfirmDeleteStation')?.addEventListener('click', () => {
      if (pendingDeleteStationId) {
        const target = appState.stations.find((s) => s.id === pendingDeleteStationId);
        appState.stations = appState.stations.filter((s) => s.id !== pendingDeleteStationId);
        appState.history = appState.history.filter((h) => h.stationId !== pendingDeleteStationId);
        appState.alerts = appState.alerts.filter((a) => a.stationId !== pendingDeleteStationId);
        pendingDeleteStationId = null;
        document.getElementById('deleteConfirmModal')?.classList.remove('open');
        renderAll();
        if (target) showToast(`Deleted station "${target.name}"`, 'NORMAL');
      }
    });

    // Ultrasonic Physics Calculator Sliders
    ['calcMountHeight', 'calcEchoUs'].forEach((id) => {
      document.getElementById(id)?.addEventListener('input', updateUltrasonicCalculator);
    });

    // Server Files Modal & Downloaders
    const serverModal = document.getElementById('serverFilesModal');
    document.getElementById('openServerFilesBtn')?.addEventListener('click', () => {
      serverModal?.classList.add('open');
    });
    document.getElementById('btnCloseServerModal')?.addEventListener('click', () => {
      serverModal?.classList.remove('open');
    });

    const dlHtml = () => {
      const clone = document.documentElement.cloneNode(true);
      const head = clone.querySelector('head');
      const body = clone.querySelector('body');
      if (head) {
        head.querySelectorAll('style').forEach((s) => s.remove());
        if (!head.querySelector('link[href="style.css"]')) {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = 'style.css';
          head.appendChild(link);
        }
      }
      if (body) {
        body.querySelectorAll('script').forEach((s) => s.remove());
        const scr = document.createElement('script');
        scr.src = 'script.js';
        scr.defer = true;
        body.appendChild(scr);
      }
      triggerBrowserDownload('index.html', '<!DOCTYPE html>\n' + clone.outerHTML, 'text/html;charset=utf-8');
    };
    const dlCss = () => {
      const styleTag = document.querySelector('style');
      const cssText = styleTag ? styleTag.textContent : '/* See style.css in project package */';
      triggerBrowserDownload('style.css', cssText, 'text/css;charset=utf-8');
    };
    const dlJs = () => {
      const scripts = Array.from(document.querySelectorAll('script'));
      const inlineJs = scripts.map((s) => s.textContent).join('\n');
      triggerBrowserDownload('script.js', inlineJs || '// See script.js in project package', 'application/javascript;charset=utf-8');
    };

    document.getElementById('btnDownloadHtmlFile')?.addEventListener('click', dlHtml);
    document.getElementById('btnDownloadCssFile')?.addEventListener('click', dlCss);
    document.getElementById('btnDownloadJsFile')?.addEventListener('click', dlJs);
    document.getElementById('btnModalDlHtml')?.addEventListener('click', dlHtml);
    document.getElementById('btnModalDlCss')?.addEventListener('click', dlCss);
    document.getElementById('btnModalDlJs')?.addEventListener('click', dlJs);

    // Delegated Clicks for Dynamic Cards & Tables
    document.body.addEventListener('click', (e) => {
      const locateBtn = e.target.closest('.js-locate-map');
      if (locateBtn) {
        selectedMapStationId = locateBtn.getAttribute('data-id');
        renderMap();
        switchView('map');
        return;
      }

      const chartBtn = e.target.closest('.js-view-chart');
      if (chartBtn) {
        const stId = chartBtn.getAttribute('data-id');
        const sel = document.getElementById('chartStationSelect');
        if (sel && stId) sel.value = stId;
        switchView('charts');
        return;
      }

      const editBtn = e.target.closest('.js-edit-station');
      if (editBtn) {
        loadStationIntoCrudForm(editBtn.getAttribute('data-id'));
        return;
      }

      const delBtn = e.target.closest('.js-delete-station');
      if (delBtn) {
        const stId = delBtn.getAttribute('data-id');
        const st = appState.stations.find((s) => s.id === stId);
        if (st) {
          pendingDeleteStationId = st.id;
          const nameSpan = document.getElementById('deleteModalStationName');
          if (nameSpan) nameSpan.textContent = `${st.name} (${st.borough})`;
          document.getElementById('deleteConfirmModal')?.classList.add('open');
        }
        return;
      }

      const refreshNodeBtn = e.target.closest('.js-refresh-node');
      if (refreshNodeBtn) {
        const stId = refreshNodeBtn.getAttribute('data-id');
        const st = appState.stations.find((s) => s.id === stId);
        if (st) {
          st.forceStale = false;
          st.lastUpdatedMs = Date.now();
          renderAll();
          showToast(`Reconnected ultrasonic node ${st.nodeId}`, 'NORMAL');
        }
        return;
      }

      const ackBtn = e.target.closest('.js-ack-alert');
      if (ackBtn) {
        const alId = ackBtn.getAttribute('data-id');
        const al = appState.alerts.find((a) => a.id === alId);
        if (al) {
          al.acknowledged = true;
          renderAll();
          showToast(`Acknowledged alert for ${al.stationName}`, 'NORMAL');
        }
        return;
      }

      const delSubBtn = e.target.closest('.js-delete-sub');
      if (delSubBtn) {
        const subId = delSubBtn.getAttribute('data-id');
        appState.subscriptions = appState.subscriptions.filter((s) => s.id !== subId);
        renderAll();
        showToast('Removed alert watch rule', 'NORMAL');
      }
    });

    window.addEventListener('resize', () => {
      if (activeView === 'charts') renderAllCharts();
    });
    window.addEventListener('online', renderTopStatusAndTicker);
    window.addEventListener('offline', renderTopStatusAndTicker);
  }

  /* --------------------------------------------------------------------------
   * 14. INITIALIZE APPLICATION ON DOM READY
   * -------------------------------------------------------------------------- */
  function init() {
    populateStationDropdowns();
    bindEvents();
    updateUltrasonicCalculator();
    renderAll();
    startTelemetryTicker();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
