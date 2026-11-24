/**
 * ============================================================================
 * NYC FloodGuard — Main Application Controller
 * File: script.js
 *
 * Sections:
 *   1. Home / Login (Supabase Auth + Verified Regular User / Administrator Role)
 *   2. Dashboard (Arduino GIGA R1 WiFi Web Serial LIVE + Simulation Backup +
 *      UNAVAILABLE state, cm depth math, noise-filtered rate of change,
 *      drainage tracking, conservative ETA projection, single history chart,
 *      and RLS-protected Administrator threshold settings)
 *   3. NYC FloodNet Historical Data (Official NYC Open Data API + per-user
 *      Supabase saved_flood_events bookmarks)
 *   4. About Project (Hardware architecture, 3.3V GPIO safety, Serial JSON,
 *      and downloadable Arduino GIGA R1 WiFi sketch)
 * ============================================================================
 */
import {
  fetchSupabaseFloodData,
  getAuthSession,
  subscribeToAuthState,
  signUpWithEmail,
  signInWithEmail,
  resendVerificationEmail,
  sendPasswordResetEmail,
  updateUserPassword,
  signOutUser,
  buildFloodEventKey,
  fetchSavedFloodEvents,
  saveFloodEventBookmark,
  deleteSavedFloodEvent,
  fetchUserProfileRole,
  fetchMonitoringSettings,
  updateMonitoringSettings
} from './supabaseClient.js';
import {
  fetchFloodNetSensorMetadata,
  fetchFloodNetEvents
} from './nycOpenData.js';
import {
  DEFAULT_PROTOTYPE_SETTINGS,
  PROTOTYPE_PRESETS,
  analyzeWaterTelemetry
} from './floodAnalytics.js';
import {
  ArduinoSerialClient,
  isWebSerialSupported
} from './arduinoSerial.js';
import { fetchLiveNycWeather } from './nycWeather.js';
import { evaluateFloodRiskIntelligence } from './riskIntelligence.js';
import {
  TestSessionRecorder,
  formatClockTimer,
  formatDurationSeconds
} from './sessionRecorder.js';
import {
  createInitialFloatSwitchState,
  recordFloatSwitchReading,
  evaluateFloatAgreement
} from './floatSensor.js';
import {
  createInitialValidationState,
  addValidationComparison,
  summarizeValidationResults
} from './measurementValidation.js';
import { renderAssistantMarkdown } from './markdownRenderer.js';
import {
  createIcons,
  Usb,
  RotateCcw,
  Unplug,
  PlayCircle,
  Monitor,
  Minimize2,
  Maximize2,
  AlertOctagon,
  Waves,
  ShieldCheck,
  Activity,
  Gauge,
  Timer,
  ShieldAlert,
  Trash2,
  Info,
  TrendingUp,
  AlertTriangle,
  CloudRain,
  Send,
  Copy,
  Check,
  User
} from 'lucide';
import arduinoSketchSource from './arduino/nyc_floodguard_giga.ino?raw';

const LUCIDE_ICONS = {
  Usb,
  RotateCcw,
  Unplug,
  PlayCircle,
  Monitor,
  Minimize2,
  Maximize2,
  AlertOctagon,
  Waves,
  ShieldCheck,
  Activity,
  Gauge,
  Timer,
  ShieldAlert,
  Trash2,
  Info,
  TrendingUp,
  AlertTriangle,
  CloudRain,
  Send,
  Copy,
  Check,
  User
};

function refreshLucideIcons() {
  try {
    createIcons({ icons: LUCIDE_ICONS });
  } catch {
    // Non-fatal if icons cannot render in non-DOM test environment
  }
}

(function () {
  'use strict';

  const PROTECTED_VIEWS = new Set(['dashboard']);
  const LAST_VIEW_KEY = 'nyc_floodguard_last_view_v2';
  const FLOAT_CONFIG_KEY = 'nyc_floodguard_float_config_v1';
  const VALIDATION_LOG_KEY = 'nyc_floodguard_ruler_validation_v1';
  const MAX_RAW_PACKETS = 60;

  /* --------------------------------------------------------------------------
   * 1. APPLICATION STATE (STRICTLY SEPARATED DATASETS)
   * -------------------------------------------------------------------------- */
  const authState = {
    loading: true,
    session: null,
    user: null,
    role: 'user', // Verified from Supabase user_profiles ('user' | 'admin')
    roleStatus: 'idle', // 'idle' | 'ok' | 'migration_required' | 'error'
    roleMessage: '',
    mode: 'login', // 'login' | 'signup' | 'forgot' | 'verify' | 'recovery'
    pendingEmailForVerify: '',
    pendingProtectedView: null,
    recoveryActive: false
  };

  /**
   * Prototype calibration & threshold settings (cm).
   * Loaded from Supabase `monitoring_settings` when migrated; editable ONLY
   * by database-verified Administrators via Supabase RLS.
   */
  const prototypeSettingsState = {
    source: 'defaults', // 'defaults' | 'supabase'
    status: 'idle', // 'idle' | 'ok' | 'migration_required' | 'error'
    message: '',
    legacyDeepBasinBlocked: false,
    explicitAdminSave: false,
    values: { ...DEFAULT_PROTOTYPE_SETTINGS }
  };

  const MAX_ALERT_HISTORY = 30;

  /**
   * 6-stage guided classroom Demo Mode sequence (strictly isolated from LIVE Arduino).
   * Uses the tested 14.39 cm dry-road baseline and 0.50 / 1.25 cm thresholds.
   */
  const DEMO_STAGES = [
    {
      name: '1. Normal Drainage',
      description: 'Stage 1 of 6: Normal Drainage — clear storm drain with minimal surface moisture (< 0.50 cm).',
      targetDepthCm: 0.10,
      stepPerTickCm: 0.015,
      autoTicks: 6
    },
    {
      name: '2. Gradually Rising Water',
      description: 'Stage 2 of 6: Gradually Rising Water — inflow increases while drain begins obstructing.',
      targetDepthCm: 0.54,
      stepPerTickCm: 0.065,
      autoTicks: 7
    },
    {
      name: '3. Warning',
      description: 'Stage 3 of 6: Warning (0.50–1.24 cm) — amber flood warning triggered with Critical ETA projection.',
      targetDepthCm: 1.22,
      stepPerTickCm: 0.095,
      autoTicks: 8
    },
    {
      name: '4. Critical Flooding',
      description: 'Stage 4 of 6: Critical Flooding (≥ 1.25 cm) — blocked storm drain prevents runoff; critical alert active.',
      targetDepthCm: 1.78,
      stepPerTickCm: 0.085,
      autoTicks: 9
    },
    {
      name: '5. Water Receding',
      description: 'Stage 5 of 6: Water Receding — drain blockage cleared; street water depth falls steadily.',
      targetDepthCm: 0.42,
      stepPerTickCm: -0.15,
      autoTicks: 10
    },
    {
      name: '6. Recovery',
      description: 'Stage 6 of 6: Recovery — water drains back to NORMAL dry-road baseline.',
      targetDepthCm: 0.04,
      stepPerTickCm: -0.065,
      autoTicks: 8
    }
  ];

  /**
   * Live / Simulated / Unavailable FloodGuard prototype telemetry state.
   * Strictly isolated from NYC FloodNet historical data.
   */
  const telemetryState = {
    mode: 'UNAVAILABLE', // 'LIVE' | 'SIMULATED' | 'UNAVAILABLE'
    streamHealth: 'IDLE', // 'IDLE' | 'OK' | 'STALE' | 'CONNECTION_LOST'
    lastLivePacketMs: null,
    suspiciousTotalCount: 0,
    connectionText: 'Connect your Arduino GIGA R1 WiFi over USB (115200 baud) for live street-model measurements, or launch Demo Mode for a guided walkthrough.',
    noticeText: '',
    noticeType: 'info', // 'info' | 'warn' | 'error' | 'success'
    samples: [],
    latestAnalysis: null,
    latestRiskIntel: null,
    lastAlertStatus: null,
    alertHistory: [],
    latestHardware: {
      device: '',
      format: null,
      lastRawLine: '',
      floatLow: null,
      floatHigh: null,
      barrierState: 'not_installed',
      lastPacketMs: null
    },
    // Locked dry-road baseline calibration state (NEVER auto-overwritten during flooding)
    calibration: {
      status: 'UNSET', // 'UNSET' | 'CALIBRATING' | 'LOCKED_ARDUINO' | 'LOCKED_DRY_MEDIAN' | 'LOCKED_INFERRED' | 'DEMO'
      baselineCm: null,
      calibratedAtMs: null,
      dryBuffer: [],
      driftNote: ''
    },
    // Guided 6-stage Demo Mode state (never mixed with LIVE hardware readings)
    simTimerId: null,
    demoStageIndex: 0,
    demoAutoAdvance: true,
    demoStageTickCount: 0,
    simCurrentDepthCm: 0.06
  };

  // Presentation Test Session Recorder
  const sessionRecorder = new TestSessionRecorder();
  const sessionUiState = {
    showSummary: false,
    timerId: null
  };

  // Independent Backup Float Sensor state (Liyafy XSL-3508-P — never alters ultrasonic alerts)
  const floatSwitchState = createInitialFloatSwitchState();
  try {
    const savedFloatCfg = JSON.parse(localStorage.getItem(FLOAT_CONFIG_KEY) || 'null');
    if (savedFloatCfg && typeof savedFloatCfg === 'object') {
      const h = Number(savedFloatCfg.activationHeightCm);
      if (Number.isFinite(h) && h > 0 && h <= 50) {
        floatSwitchState.activationHeightCm = Number(h.toFixed(2));
      }
      if (typeof savedFloatCfg.closedMeansWater === 'boolean') {
        floatSwitchState.closedMeansWater = savedFloatCfg.closedMeansWater;
      }
    }
  } catch {
    // Ignore localStorage parse errors
  }

  function persistFloatSwitchConfig() {
    try {
      localStorage.setItem(
        FLOAT_CONFIG_KEY,
        JSON.stringify({
          activationHeightCm: floatSwitchState.activationHeightCm,
          closedMeansWater: floatSwitchState.closedMeansWater
        })
      );
    } catch {
      // Ignore storage quota errors
    }
  }

  // Independent Ruler vs. Ultrasonic Measurement Validation state
  const validationState = createInitialValidationState();
  try {
    const savedVal = JSON.parse(localStorage.getItem(VALIDATION_LOG_KEY) || 'null');
    if (savedVal && Array.isArray(savedVal.entries)) {
      validationState.entries = savedVal.entries
        .filter((e) => e && Number.isFinite(Number(e.rulerCm)) && Number.isFinite(Number(e.sensorCm)))
        .slice(0, 100);
    }
  } catch {
    // Ignore localStorage parse errors
  }

  function persistValidationLog() {
    try {
      localStorage.setItem(
        VALIDATION_LOG_KEY,
        JSON.stringify({ entries: validationState.entries.slice(0, 100) })
      );
    } catch {
      // Ignore storage quota errors
    }
  }

  // 9-Step Live Presentation Walkthrough state (auto-tracks LIVE Arduino milestones + manual checkboxes)
  const walkthroughState = {
    manualDone: new Set(),
    autoDone: new Set(),
    sawFloodInLive: false
  };

  /**
   * Live NYC Weather state (Open-Meteo public Forecast API).
   */
  const weatherState = {
    loading: false,
    error: '',
    data: null,
    refreshTimerId: null,
    abortController: null
  };

  /**
   * Optional Server-Side AI FloodGuard Assistant state (Gemini via /api/assistant).
   */
  const aiAssistantState = {
    statusChecked: false,
    available: false,
    statusState: 'connecting', // 'connecting' | 'ready' | 'processing' | 'offline'
    statusLabel: 'Connecting',
    statusNote: '',
    loading: false,
    pendingQuestion: '',
    pendingAt: '',
    expanded: false,
    copiedId: null,
    error: '',
    messages: [] // chronological: oldest -> newest
  };

  /**
   * Optional Fullscreen Presentation Mode state (UI-only emphasis of live telemetry, predictions & alerts).
   */
  const presentationState = {
    active: false,
    clockTimerId: null
  };
  let lastDisplayedDepthText = '--';

  /**
   * Existing Supabase demo tables (`sensors` & `water_readings`, read-only).
   */
  const supabaseDemoState = {
    status: 'connecting',
    summaryText: 'Checking…'
  };

  /**
   * Authentic historical NYC FloodNet data (from data.cityofnewyork.us).
   * Strictly separate from FloodGuard prototype readings.
   */
  const realFloodState = {
    initialized: false,
    loading: false,
    error: '',
    metadataLoaded: false,
    sensorsList: [],
    sensorById: new Map(),
    boroughs: [],
    records: [],
    totalCount: 0,
    totalPages: 1,
    page: 1,
    pageSize: 25,
    search: '',
    borough: 'ALL',
    sensorId: 'ALL',
    startDate: '',
    endDate: '',
    apiUpdatedAtIso: '',
    latestRecordedEventIso: '',
    lastFetchedMs: null,
    latencyMs: null,
    abortController: null
  };

  /**
   * Per-user bookmarked historical flood events in Supabase (`saved_flood_events`).
   */
  const savedEventsState = {
    status: 'idle',
    loading: false,
    errorMessage: '',
    events: [],
    savingKeys: new Set()
  };

  let activeView = 'home';
  let staleWatchTimerId = null;
  let lastChartPoints = [];

  /* --------------------------------------------------------------------------
   * 2. UTILITIES
   * -------------------------------------------------------------------------- */
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function isAuthenticated() {
    return Boolean(authState.session && authState.user && !authState.recoveryActive);
  }

  function isVerifiedAdmin() {
    return isAuthenticated() && authState.role === 'admin' && authState.roleStatus === 'ok';
  }

  function getUserDisplayName(user) {
    if (!user) return '';
    const fullName = user.user_metadata?.full_name || user.user_metadata?.name || '';
    if (String(fullName).trim()) return String(fullName).trim();
    return user.email ? user.email.split('@')[0] : 'FloodGuard User';
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function setButtonBusy(btn, busyText, isBusy) {
    if (!btn) return;
    if (isBusy) {
      if (!btn.dataset.originalText) btn.dataset.originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = busyText;
    } else {
      btn.disabled = false;
      if (btn.dataset.originalText) btn.textContent = btn.dataset.originalText;
    }
  }

  function showToast(message, severity = 'NORMAL') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className =
      'toast-msg' +
      (severity === 'CRITICAL' ? ' toast-crit' : severity === 'WARNING' ? ' toast-warn' : '');
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 4200);
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

  function mapAuthError(err) {
    const raw = (err && (err.message || err.error_description)) || 'Authentication request failed.';
    const lower = raw.toLowerCase();
    if (lower.includes('invalid login credentials')) {
      return 'Incorrect email or password. Please check your credentials or use Reset Password.';
    }
    if (lower.includes('email not confirmed')) {
      return 'Your email address has not been verified yet. Click the confirmation link sent to your inbox.';
    }
    if (lower.includes('user already registered') || lower.includes('already been registered')) {
      return 'An account with this email already exists. Please sign in or reset your password.';
    }
    if (lower.includes('password should be at least')) {
      return 'Password must be at least 6 characters long.';
    }
    if (lower.includes('rate limit') || lower.includes('security purposes')) {
      return 'Too many requests in a short time. Please wait a minute before trying again.';
    }
    if (lower.includes('expired') || lower.includes('otp_expired') || lower.includes('invalid token')) {
      return 'This verification or reset link has expired or is invalid. Please request a new one.';
    }
    return raw;
  }

  function cleanAuthRedirectUrl() {
    try {
      const cleanUrl = new URL(window.location.href);
      const authParams = ['code', 'token_hash', 'type', 'error', 'error_code', 'error_description'];
      let modified = false;
      authParams.forEach((p) => {
        if (cleanUrl.searchParams.has(p)) {
          cleanUrl.searchParams.delete(p);
          modified = true;
        }
      });
      if (cleanUrl.hash && /(access_token|refresh_token|type=|error=)/i.test(cleanUrl.hash)) {
        cleanUrl.hash = '';
        modified = true;
      }
      if (modified) {
        window.history.replaceState({}, document.title, cleanUrl.toString());
      }
    } catch {
      // Ignore restricted history context
    }
  }

  /* --------------------------------------------------------------------------
   * 3. NAVIGATION & AUTHENTICATION UI
   * -------------------------------------------------------------------------- */
  function showAuthFeedback(message, type) {
    const banner = document.getElementById('authFeedbackBanner');
    if (!banner) return;
    if (!message) {
      banner.textContent = '';
      banner.className = 'inline-notice hidden';
      return;
    }
    const kind =
      type === 'success'
        ? 'notice-success'
        : type === 'info'
        ? 'notice-info'
        : 'notice-error';
    banner.textContent = message;
    banner.className = `inline-notice ${kind}`;
  }

  function setAuthMode(mode, preserveFeedback) {
    authState.mode = mode;
    if (!preserveFeedback) {
      showAuthFeedback('', 'info');
    }

    const tabsWrap = document.getElementById('authModeTabs');
    if (tabsWrap) {
      tabsWrap.classList.toggle('hidden', mode === 'recovery');
    }

    document.querySelectorAll('.seg-tab').forEach((tab) => {
      const tabMode = tab.getAttribute('data-auth-mode');
      const active = tabMode === mode || (mode === 'verify' && tabMode === 'signup');
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });

    document.getElementById('authLoginForm')?.classList.toggle('hidden', mode !== 'login');
    document.getElementById('authSignUpForm')?.classList.toggle('hidden', mode !== 'signup');
    document.getElementById('authVerifyBox')?.classList.toggle('hidden', mode !== 'verify');
    document.getElementById('authForgotForm')?.classList.toggle('hidden', mode !== 'forgot');
    document.getElementById('authRecoveryForm')?.classList.toggle('hidden', mode !== 'recovery');
  }

  function updateAuthUI() {
    const authed = isAuthenticated();
    const admin = isVerifiedAdmin();
    const roleLabel = admin ? 'Administrator' : 'Regular User';

    const signInBtn = document.getElementById('btnHeaderSignIn');
    const userSummary = document.getElementById('authUserSummary');
    const userNameEl = document.getElementById('authHeaderUserName');
    const userMetaEl = document.getElementById('authHeaderUserMeta');

    if (signInBtn) signInBtn.classList.toggle('hidden', authed);
    if (userSummary) userSummary.classList.toggle('hidden', !authed);

    const signedInBox = document.getElementById('homeSignedInBox');
    const authFormsWrap = document.getElementById('homeAuthFormsWrap');
    if (signedInBox) signedInBox.classList.toggle('hidden', !authed || authState.recoveryActive);
    if (authFormsWrap) authFormsWrap.classList.toggle('hidden', authed && !authState.recoveryActive);

    if (authed && authState.user) {
      const displayName = getUserDisplayName(authState.user);
      const email = authState.user.email || '';
      if (userNameEl) userNameEl.textContent = displayName;
      if (userMetaEl) userMetaEl.textContent = `${roleLabel} · ${email}`;

      const homeName = document.getElementById('homeAccountName');
      const homeEmail = document.getElementById('homeAccountEmail');
      const homeRoleBadge = document.getElementById('homeAccountRoleBadge');
      const homeAccessDesc = document.getElementById('homeAccountAccessDesc');
      const homeMigrationHint = document.getElementById('homeRoleMigrationHint');

      if (homeName) homeName.textContent = displayName;
      if (homeEmail) homeEmail.textContent = email;
      if (homeRoleBadge) {
        homeRoleBadge.textContent = roleLabel;
        homeRoleBadge.className = `status-tag ${admin ? 'tag-admin' : 'tag-normal'}`;
      }
      if (homeAccessDesc) {
        homeAccessDesc.textContent = admin
          ? 'Monitoring dashboard, saved flood events, and Supabase threshold configuration'
          : 'Monitoring dashboard and personal historical flood event bookmarks';
      }
      if (homeMigrationHint) {
        if (authState.roleStatus === 'migration_required') {
          homeMigrationHint.textContent = authState.roleMessage;
          homeMigrationHint.classList.remove('hidden');
        } else {
          homeMigrationHint.classList.add('hidden');
        }
      }
    }

    document.querySelectorAll('.nav-btn[data-protected="true"]').forEach((btn) => {
      btn.classList.toggle('nav-locked', !authed);
    });

    renderAdminSettingsPanel();
  }

  function applyActiveViewDOM(viewName) {
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

    try {
      window.sessionStorage.setItem(LAST_VIEW_KEY, viewName);
    } catch {
      // Ignore storage blocks
    }

    if (viewName === 'dashboard') {
      renderDashboard();
      setTimeout(() => {
        drawWaterHistoryChart();
        drawWeatherRainChart();
      }, 30);
      if (!weatherState.data && !weatherState.loading) {
        loadLiveNycWeather();
      }
      if (!aiAssistantState.statusChecked) {
        checkAiAssistantStatus();
      }
    } else if (viewName === 'realdata') {
      if (!realFloodState.initialized && !realFloodState.loading) {
        loadRealFloodData({ refreshMetadata: !realFloodState.metadataLoaded });
      } else {
        renderRealFloodDataView();
      }
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function switchView(viewName, options = {}) {
    if (PROTECTED_VIEWS.has(viewName) && !isAuthenticated()) {
      authState.pendingProtectedView = viewName;
      if (authState.recoveryActive) {
        setAuthMode('recovery', true);
        showAuthFeedback('Please complete setting your new password before accessing the dashboard.', 'info');
      } else {
        setAuthMode('login', false);
        showAuthFeedback(
          options.gateMessage || 'Please sign in or create an account to open the FloodGuard Dashboard.',
          'info'
        );
      }
      applyActiveViewDOM('home');
      document.getElementById('homeAuthCard')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    applyActiveViewDOM(viewName);
  }

  /* --------------------------------------------------------------------------
   * 4. VERIFIED SUPABASE ROLE & RLS-PROTECTED SETTINGS
   * -------------------------------------------------------------------------- */
  async function loadUserRoleAndSettings() {
    if (!isAuthenticated()) {
      authState.role = 'user';
      authState.roleStatus = 'idle';
      authState.roleMessage = '';
      prototypeSettingsState.source = 'defaults';
      prototypeSettingsState.status = 'idle';
      prototypeSettingsState.message = '';
      prototypeSettingsState.values = { ...DEFAULT_PROTOTYPE_SETTINGS };
      updateAuthUI();
      renderDashboard();
      return;
    }

    const [roleRes, settingsRes] = await Promise.all([
      fetchUserProfileRole(),
      fetchMonitoringSettings()
    ]);

    authState.role = roleRes.role === 'admin' ? 'admin' : 'user';
    authState.roleStatus = roleRes.status;
    authState.roleMessage = roleRes.errorMessage || '';

    if (settingsRes.status === 'ok' && settingsRes.settings) {
      const incoming = settingsRes.settings;
      const isLegacyDeepBasin =
        Number(incoming.warnThresholdCm) >= 4.0 || Number(incoming.critThresholdCm) >= 5.0;

      prototypeSettingsState.source = 'supabase';
      prototypeSettingsState.status = 'ok';
      prototypeSettingsState.message = '';
      prototypeSettingsState.legacyDeepBasinBlocked = isLegacyDeepBasin;

      if (isLegacyDeepBasin) {
        // NEVER automatically switch to 5.00 / 12.00 cm (or 6.00 / 12.00 cm) deep-basin thresholds.
        // Preserve experimental street-model thresholds: WARNING >= 0.50 cm, CRITICAL >= 1.25 cm.
        prototypeSettingsState.values = {
          ...DEFAULT_PROTOTYPE_SETTINGS,
          ...incoming,
          mountHeightCm:
            Number(incoming.mountHeightCm) >= 24.0
              ? PROTOTYPE_PRESETS.EXPERIMENTAL_STREET_MODEL.mountHeightCm
              : incoming.mountHeightCm,
          warnThresholdCm: PROTOTYPE_PRESETS.EXPERIMENTAL_STREET_MODEL.warnThresholdCm,
          critThresholdCm: PROTOTYPE_PRESETS.EXPERIMENTAL_STREET_MODEL.critThresholdCm
        };
      } else {
        prototypeSettingsState.values = {
          ...DEFAULT_PROTOTYPE_SETTINGS,
          ...incoming
        };
      }
    } else {
      prototypeSettingsState.source = 'defaults';
      prototypeSettingsState.status = settingsRes.status;
      prototypeSettingsState.message = settingsRes.errorMessage || '';
      prototypeSettingsState.legacyDeepBasinBlocked = false;
      prototypeSettingsState.values = { ...DEFAULT_PROTOTYPE_SETTINGS };
    }

    updateAuthUI();
    recalculateTelemetryAndRender();
  }

  function renderAdminSettingsPanel() {
    const admin = isVerifiedAdmin();
    const cfg = prototypeSettingsState.values;

    const mountInput = document.getElementById('cfgMountHeightCm');
    const warnInput = document.getElementById('cfgWarnThresholdCm');
    const critInput = document.getElementById('cfgCritThresholdCm');
    const riseInput = document.getElementById('cfgMinRiseRate');
    const barrierInput = document.getElementById('cfgBarrierThresholdCm');
    const roleTag = document.getElementById('settingsRoleTag');
    const saveControls = document.getElementById('adminSaveControls');
    const regularNote = document.getElementById('regularUserSettingsNote');
    const statusNotice = document.getElementById('settingsStatusNotice');

    if (mountInput) {
      mountInput.value = Number(cfg.mountHeightCm).toFixed(2);
      mountInput.disabled = !admin;
    }
    if (warnInput) {
      warnInput.value = Number(cfg.warnThresholdCm).toFixed(2);
      warnInput.disabled = !admin;
    }
    if (critInput) {
      critInput.value = Number(cfg.critThresholdCm).toFixed(2);
      critInput.disabled = !admin;
    }
    if (riseInput) {
      riseInput.value = Number(cfg.minRiseRateCmPerMin).toFixed(2);
      riseInput.disabled = !admin;
    }
    if (barrierInput) {
      barrierInput.value = Number(cfg.barrierThresholdCm).toFixed(2);
      barrierInput.disabled = !admin;
    }

    if (roleTag) {
      if (admin) {
        roleTag.textContent = 'Admin (RLS Editable)';
        roleTag.className = 'status-tag tag-admin';
      } else {
        roleTag.textContent = 'Read-Only';
        roleTag.className = 'status-tag tag-neutral';
      }
    }

    if (saveControls) saveControls.classList.toggle('hidden', !admin);
    if (regularNote) regularNote.classList.toggle('hidden', admin);

    if (statusNotice) {
      if (prototypeSettingsState.status === 'migration_required') {
        statusNotice.textContent =
          'Using default prototype calibration. Run supabase_roles_and_settings.sql in Supabase SQL Editor to enable database-enforced Administrator settings.';
        statusNotice.className = 'inline-notice notice-info';
      } else if (prototypeSettingsState.status === 'error' && prototypeSettingsState.message) {
        statusNotice.textContent = prototypeSettingsState.message;
        statusNotice.className = 'inline-notice notice-warn';
      } else if (prototypeSettingsState.legacyDeepBasinBlocked) {
        statusNotice.textContent =
          'Experimental street-model thresholds (WARNING ≥ 0.50 cm, CRITICAL ≥ 1.25 cm) are preserved. Legacy deep-basin thresholds in Supabase were not auto-applied.';
        statusNotice.className = 'inline-notice notice-info';
      } else if (prototypeSettingsState.source === 'supabase' && cfg.updatedAt) {
        statusNotice.textContent = `Loaded from Supabase monitoring_settings (last updated ${new Date(cfg.updatedAt).toLocaleString()}).`;
        statusNotice.className = 'inline-notice notice-success';
      } else {
        statusNotice.className = 'inline-notice hidden';
      }
    }
  }

  /* --------------------------------------------------------------------------
   * 5. ARDUINO GIGA R1 WiFi WEB SERIAL + SIMULATION BACKUP TELEMETRY ENGINE
   * -------------------------------------------------------------------------- */
  function setDashboardNotice(message, type = 'info') {
    telemetryState.noticeText = message || '';
    telemetryState.noticeType = type;
    const el = document.getElementById('dashConnectionNotice');
    if (!el) return;
    if (!message) {
      el.textContent = '';
      el.className = 'inline-notice hidden';
      return;
    }
    const cls =
      type === 'error'
        ? 'notice-error'
        : type === 'warn'
        ? 'notice-warn'
        : type === 'success'
        ? 'notice-success'
        : 'notice-info';
    el.textContent = message;
    el.className = `inline-notice ${cls}`;
  }

  function pushTelemetrySample({
    distanceCm = null,
    mountHeightCm = null,
    reportedDepthCm = null,
    timestampMs = Date.now(),
    errorCode = null,
    firmwareQuality = null,
    burstSpreadCm = null,
    validPings = null,
    reportedStatus = null,
    format = 'json'
  }) {
    const mount = Number.isFinite(mountHeightCm)
      ? mountHeightCm
      : prototypeSettingsState.values.mountHeightCm;

    telemetryState.samples.push({
      timestampMs: timestampMs || Date.now(),
      distanceCm: Number.isFinite(distanceCm) ? Number(distanceCm.toFixed(2)) : null,
      mountHeightCm: Number(mount.toFixed(2)),
      reportedDepthCm: Number.isFinite(reportedDepthCm) ? Number(reportedDepthCm.toFixed(2)) : null,
      errorCode: errorCode || null,
      firmwareQuality: firmwareQuality || null,
      burstSpreadCm: Number.isFinite(burstSpreadCm) ? Number(burstSpreadCm.toFixed(2)) : null,
      validPings: Number.isFinite(validPings) ? validPings : null,
      reportedStatus: reportedStatus || null,
      format: format || 'json'
    });

    if (telemetryState.samples.length > MAX_RAW_PACKETS) {
      telemetryState.samples = telemetryState.samples.slice(-MAX_RAW_PACKETS);
    }

    recalculateTelemetryAndRender(true);
  }

  function appendSystemAlertEvent(nextStatus, noteText = '') {
    const nowMs = Date.now();
    const prevStatus = telemetryState.lastAlertStatus || 'LIVE';
    telemetryState.lastAlertStatus = nextStatus;

    telemetryState.alertHistory.unshift({
      timestampMs: nowMs,
      sourceMode: telemetryState.mode === 'SIMULATED' ? 'DEMO' : 'LIVE',
      prevStatus,
      nextStatus,
      depthCm: null,
      distanceCm: null,
      note: noteText
    });

    if (telemetryState.alertHistory.length > MAX_ALERT_HISTORY) {
      telemetryState.alertHistory = telemetryState.alertHistory.slice(0, MAX_ALERT_HISTORY);
    }

    if (sessionRecorder.recording) {
      sessionRecorder.recordEvent({
        timestampMs: nowMs,
        eventType: nextStatus === 'RECALIBRATED' ? 'RECALIBRATION' : 'STATUS_CHANGE',
        fromStatus: prevStatus,
        toStatus: nextStatus,
        depthCm: null,
        note: noteText
      });
    }
  }

  function recordStatusTransitionIfNeeded(analysis) {
    if (telemetryState.mode === 'UNAVAILABLE' || !analysis || analysis.status === 'UNAVAILABLE') {
      return;
    }
    const nextStatus = analysis.status;
    const prevStatus = telemetryState.lastAlertStatus;
    if (nextStatus === prevStatus) return;

    telemetryState.lastAlertStatus = nextStatus;

    telemetryState.alertHistory.unshift({
      timestampMs: analysis.lastUpdatedMs || Date.now(),
      sourceMode: telemetryState.mode === 'LIVE' ? 'LIVE' : 'DEMO',
      prevStatus: prevStatus || 'START',
      nextStatus,
      depthCm: analysis.filteredDepthCm,
      distanceCm: analysis.filteredDistanceCm ?? analysis.rawDistanceCm
    });

    if (telemetryState.alertHistory.length > MAX_ALERT_HISTORY) {
      telemetryState.alertHistory = telemetryState.alertHistory.slice(0, MAX_ALERT_HISTORY);
    }

    const srcPrefix = telemetryState.mode === 'LIVE' ? 'LIVE Arduino' : 'DEMO MODE';
    const depthStr = analysis.filteredDepthCm != null ? `${analysis.filteredDepthCm.toFixed(2)} cm` : 'Out of Range';

    if (nextStatus === 'CRITICAL') {
      showToast(`${srcPrefix} CRITICAL FLOOD ALERT: Water depth reached ${depthStr}.`, 'CRITICAL');
    } else if (nextStatus === 'WARNING') {
      showToast(`${srcPrefix} FLOOD WARNING: Water depth reached ${depthStr}.`, 'WARNING');
    } else if (nextStatus === 'OUT_OF_RANGE') {
      showToast(`${srcPrefix}: Ultrasonic reading out of range.`, 'WARNING');
    } else if (nextStatus === 'NORMAL' && prevStatus && prevStatus !== 'NORMAL') {
      showToast(`${srcPrefix}: Water level returned to NORMAL (${depthStr}).`, 'NORMAL');
    }
  }

  function recalculateTelemetryAndRender(fromNewSample = false) {
    const activeSettings = getEffectiveThresholds();
    const analysis = analyzeWaterTelemetry(
      telemetryState.samples,
      activeSettings,
      telemetryState.mode
    );
    telemetryState.latestAnalysis = analysis;

    if (fromNewSample && analysis.suspiciousReading) {
      telemetryState.suspiciousTotalCount += 1;
    }

    recordStatusTransitionIfNeeded(analysis);

    if (fromNewSample && sessionRecorder.recording && telemetryState.mode !== 'UNAVAILABLE') {
      sessionRecorder.recordSample({
        timestampMs: analysis.lastUpdatedMs || Date.now(),
        sourceMode: telemetryState.mode === 'LIVE' ? 'LIVE' : 'DEMO',
        status: analysis.status,
        depthCm: analysis.filteredDepthCm,
        distanceCm: analysis.filteredDistanceCm ?? analysis.rawDistanceCm,
        baselineCm: telemetryState.calibration.baselineCm ?? analysis.mountHeightCm,
        trend: analysis.trend,
        rateCmPerMin: analysis.rateCmPerMin,
        sensorQuality: analysis.sensorQuality,
        suspicious: Boolean(analysis.suspiciousReading),
        suspiciousReason: analysis.suspiciousReason || '',
        rawLine: telemetryState.latestHardware.lastRawLine || ''
      });
    }

    telemetryState.latestRiskIntel = evaluateFloodRiskIntelligence({
      analysis,
      settings: activeSettings,
      weather: weatherState.data,
      sourceMode: telemetryState.mode
    });

    renderDashboard();
  }

  /**
   * Returns active threshold configuration.
   * Preserves experimental street-model thresholds (WARNING >= 0.50 cm, CRITICAL >= 1.25 cm)
   * and NEVER automatically switches to deep-basin (5.00 / 12.00 cm or 6.00 / 12.00 cm) thresholds.
   */
  function getEffectiveThresholds() {
    const base = { ...prototypeSettingsState.values };
    if (
      !prototypeSettingsState.explicitAdminSave &&
      (Number(base.warnThresholdCm) >= 4.0 || Number(base.critThresholdCm) >= 5.0)
    ) {
      return {
        ...base,
        warnThresholdCm: PROTOTYPE_PRESETS.EXPERIMENTAL_STREET_MODEL.warnThresholdCm,
        critThresholdCm: PROTOTYPE_PRESETS.EXPERIMENTAL_STREET_MODEL.critThresholdCm
      };
    }
    return base;
  }

  function resetCalibrationState(status = 'UNSET') {
    telemetryState.calibration = {
      status,
      baselineCm: null,
      calibratedAtMs: null,
      dryBuffer: [],
      driftNote: ''
    };
  }

  function closeRecalibratePanel() {
    const strip = document.getElementById('recalibrateConfirmStrip');
    const chk = document.getElementById('chkConfirmDryRoad');
    const confirmBtn = document.getElementById('btnConfirmRecalibrate');
    if (strip) strip.classList.add('hidden');
    if (chk) chk.checked = false;
    if (confirmBtn) confirmBtn.disabled = true;
  }

  function medianNumeric(arr) {
    if (!arr || arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // Real USB Web Serial Client for Arduino GIGA R1 WiFi (115200 baud)
  const arduinoClient = new ArduinoSerialClient({
    baudRate: 115200,
    onStatusChange(status, msg, meta = {}) {
      if (status === 'connecting') {
        setDashboardNotice(msg, 'info');
      } else if (status === 'connected') {
        // Strictly separate LIVE Arduino from DEMO MODE
        stopSimulationBackup(false);
        closeRecalibratePanel();
        telemetryState.mode = 'UNAVAILABLE'; // Stays UNAVAILABLE until first valid serial line arrives
        telemetryState.streamHealth = 'IDLE';
        telemetryState.samples = [];
        telemetryState.lastAlertStatus = null;
        telemetryState.suspiciousTotalCount = 0;
        resetCalibrationState('UNSET');
        telemetryState.connectionText = msg;
        telemetryState.latestHardware.lastPacketMs = null;
        telemetryState.latestHardware.lastRawLine = '';
        telemetryState.latestHardware.format = null;
        floatSwitchState.state = null;
        floatSwitchState.lastUpdatedMs = null;
        setDashboardNotice(msg, 'info');
        recalculateTelemetryAndRender(false);
      } else if (status === 'disconnected') {
        closeRecalibratePanel();
        const wasLiveOrUnexpected =
          telemetryState.mode === 'LIVE' ||
          meta.reason === 'unplugged' ||
          (meta.reason === 'error' && telemetryState.lastLivePacketMs != null);

        if (telemetryState.mode === 'LIVE' || !telemetryState.simTimerId) {
          telemetryState.mode = 'UNAVAILABLE';
          telemetryState.samples = []; // Never display stale readings as if they are live
          telemetryState.streamHealth =
            meta.reason === 'unplugged' || (wasLiveOrUnexpected && meta.reason !== 'manual')
              ? 'CONNECTION_LOST'
              : 'IDLE';
          telemetryState.connectionText =
            telemetryState.streamHealth === 'CONNECTION_LOST'
              ? msg || 'Arduino USB connection lost — live readings paused'
              : msg || 'Arduino USB disconnected';

          if (telemetryState.streamHealth === 'CONNECTION_LOST') {
            appendSystemAlertEvent('CONNECTION_LOST', msg || 'Arduino USB disconnected unexpectedly');
          } else {
            telemetryState.lastAlertStatus = null;
          }

          resetCalibrationState('UNSET');
          telemetryState.latestHardware.floatLow = null;
          telemetryState.latestHardware.floatHigh = null;
          telemetryState.latestHardware.barrierState = 'not_installed';
          telemetryState.latestHardware.lastPacketMs = null;
          telemetryState.latestHardware.format = null;
          floatSwitchState.state = null;
          floatSwitchState.lastUpdatedMs = null;
        }
        setDashboardNotice(
          msg || 'Arduino USB disconnected.',
          telemetryState.streamHealth === 'CONNECTION_LOST' ? 'error' : 'info'
        );
        recalculateTelemetryAndRender(false);
      }
    },
    onReading(packet) {
      if (telemetryState.simTimerId) {
        stopSimulationBackup(false);
      }

      // 1. Handle standalone Backup Float Sensor lines ("Float Switch: OPEN" / "Float Switch: CLOSED")
      // Completely independent from ultrasonic telemetry — NEVER disrupts ultrasonic depth or triggers CRITICAL.
      if (packet.format === 'float_switch') {
        telemetryState.latestHardware.lastPacketMs = packet.receivedAtMs;
        telemetryState.lastLivePacketMs = packet.receivedAtMs;
        if (telemetryState.mode === 'LIVE') {
          telemetryState.streamHealth = 'OK';
        }
        const currentUltrasonicDepth =
          telemetryState.mode === 'LIVE' &&
          telemetryState.latestAnalysis?.available &&
          telemetryState.latestAnalysis?.filteredDepthCm != null
            ? telemetryState.latestAnalysis.filteredDepthCm
            : null;
        recordFloatSwitchReading(floatSwitchState, packet.floatSwitchState, {
          timestampMs: packet.receivedAtMs,
          rawLine: packet.rawLine,
          ultrasonicDepthCm: currentUltrasonicDepth
        });
        renderBackupFloatPanel();
        renderDashboard();
        return;
      }

      // 2. Handle explicit Arduino calibration status lines (boot or after 'c' command)
      if (packet.format === 'calibration') {
        telemetryState.latestHardware.lastRawLine = packet.rawLine || '';
        telemetryState.latestHardware.lastPacketMs = packet.receivedAtMs;
        telemetryState.lastLivePacketMs = packet.receivedAtMs;
        telemetryState.streamHealth = 'OK';

        if (packet.calibrationState === 'calibrating') {
          telemetryState.calibration.status = 'CALIBRATING';
          telemetryState.calibration.dryBuffer = [];
          telemetryState.calibration.driftNote = '';
          setDashboardNotice('Arduino is recalibrating dry-road baseline… Keep roadway dry.', 'info');
        } else if (Number.isFinite(packet.baselineCm)) {
          telemetryState.calibration.status = 'LOCKED_ARDUINO';
          telemetryState.calibration.baselineCm = packet.baselineCm;
          telemetryState.calibration.calibratedAtMs = packet.receivedAtMs;
          telemetryState.calibration.dryBuffer = [];
          telemetryState.calibration.driftNote = '';
          setDashboardNotice(
            `Dry-road baseline calibrated and locked at ${packet.baselineCm.toFixed(2)} cm by Arduino.`,
            'success'
          );
          appendSystemAlertEvent('RECALIBRATED', `Locked dry baseline at ${packet.baselineCm.toFixed(2)} cm`);
          showToast(`Arduino dry baseline locked at ${packet.baselineCm.toFixed(2)} cm.`, 'NORMAL');
        }
        renderDashboard();
        return;
      }

      // If an ultrasonic packet also carries an inline Float Switch state, update backup float independently
      if (packet.floatSwitchState) {
        recordFloatSwitchReading(floatSwitchState, packet.floatSwitchState, {
          timestampMs: packet.receivedAtMs,
          rawLine: `Float Switch: ${packet.floatSwitchState}`,
          ultrasonicDepthCm: Number.isFinite(packet.reportedDepthCm) ? packet.reportedDepthCm : null
        });
      }

      const switchedToLive = telemetryState.mode !== 'LIVE';
      telemetryState.mode = 'LIVE';
      telemetryState.streamHealth = 'OK';
      telemetryState.lastLivePacketMs = packet.receivedAtMs;
      if (switchedToLive) {
        telemetryState.samples = [];
        if (telemetryState.lastAlertStatus === 'CONNECTION_LOST' || telemetryState.lastAlertStatus === 'STALE_DATA') {
          // Keep transition chain visible when recovering from connection loss / stale data
        } else {
          telemetryState.lastAlertStatus = null;
        }
      }

      telemetryState.latestHardware = {
        device: packet.device,
        format: packet.format || 'json',
        lastRawLine: packet.rawLine || '',
        floatLow: packet.floatLow,
        floatHigh: packet.floatHigh,
        barrierState: packet.barrierState || 'not_installed',
        lastPacketMs: packet.receivedAtMs
      };
      telemetryState.connectionText = `${packet.device} · USB Serial 115200 baud (${packet.format === 'text' ? 'Authoritative Text Stream' : 'JSON Stream'}) · Last packet ${new Date(packet.receivedAtMs).toLocaleTimeString()}`;
      setDashboardNotice('', 'info');

      // 2. Stable Baseline Lock Logic (NEVER auto-overwrite during flooding or clamped-zero noise!)
      const activeThresh = getEffectiveThresholds();
      const isFloodingNow =
        (Number.isFinite(packet.reportedDepthCm) && packet.reportedDepthCm >= activeThresh.warnThresholdCm) ||
        packet.reportedStatus === 'WARNING' ||
        packet.reportedStatus === 'CRITICAL';

      const cal = telemetryState.calibration;

      if (packet.format === 'text') {
        const isLocked =
          cal.baselineCm != null &&
          (cal.status === 'LOCKED_ARDUINO' ||
            cal.status === 'LOCKED_DRY_MEDIAN' ||
            cal.status === 'LOCKED_INFERRED');

        if (!isLocked) {
          // Case A: Unclamped positive reading while not flooding -> exact Arduino internal baseline
          if (Number.isFinite(packet.inferredBaselineCm) && !isFloodingNow) {
            cal.baselineCm = packet.inferredBaselineCm;
            cal.status = 'LOCKED_INFERRED';
            cal.calibratedAtMs = packet.receivedAtMs;
            cal.dryBuffer = [];
            cal.driftNote = '';
          } else if (
            !packet.errorCode &&
            packet.reportedDepthCm === 0 &&
            (packet.reportedStatus === 'NORMAL' || !packet.reportedStatus) &&
            Number.isFinite(packet.distanceCm) &&
            packet.distanceCm >= 4.0 &&
            packet.distanceCm <= 35.0
          ) {
            // Case B: Dry roadway (Depth = 0.00 cm) -> lock median of first 3 dry readings
            // so a single noisy ultrasonic bounce (e.g. 15.78 cm) never sets the baseline!
            cal.dryBuffer.push(packet.distanceCm);
            if (cal.dryBuffer.length >= 3) {
              const med = medianNumeric(cal.dryBuffer.slice(-3));
              cal.baselineCm = Number(med.toFixed(2));
              cal.status = 'LOCKED_DRY_MEDIAN';
              cal.calibratedAtMs = packet.receivedAtMs;
              cal.driftNote = '';
            }
          } else if (Number.isFinite(packet.inferredBaselineCm) && cal.baselineCm == null) {
            // Connected mid-flood before seeing dry road: lock once from first unclamped packet,
            // and NEVER update again during flooding.
            cal.baselineCm = packet.inferredBaselineCm;
            cal.status = 'LOCKED_INFERRED';
            cal.calibratedAtMs = packet.receivedAtMs;
            cal.driftNote = 'Connected during active water — recalibrate with "c" once roadway is dry.';
          }
        } else {
          // Baseline is ALREADY LOCKED: NEVER overwrite during flooding or dry scatter!
          // If an unclamped reading differs from the locked baseline by > 0.75 cm, surface a warning only.
          if (Number.isFinite(packet.inferredBaselineCm)) {
            const diff = Math.abs(packet.inferredBaselineCm - cal.baselineCm);
            if (diff > 0.75) {
              cal.driftNote = `Arduino distance+depth (${packet.inferredBaselineCm.toFixed(2)} cm) differs from locked baseline (${cal.baselineCm.toFixed(2)} cm) — verify riser or recalibrate when dry.`;
            } else {
              cal.driftNote = '';
            }
          }
        }
      }

      let mountHeightCm;
      if (packet.format === 'text') {
        mountHeightCm =
          cal.baselineCm ??
          (cal.dryBuffer.length > 0 ? Number(medianNumeric(cal.dryBuffer).toFixed(2)) : null) ??
          prototypeSettingsState.values.mountHeightCm;
      } else if (prototypeSettingsState.source === 'supabase') {
        mountHeightCm = prototypeSettingsState.values.mountHeightCm;
      } else {
        mountHeightCm = packet.mountHeightCm ?? prototypeSettingsState.values.mountHeightCm;
      }

      let distanceCm = packet.distanceCm;
      if (distanceCm == null && !packet.errorCode && Number.isFinite(packet.reportedDepthCm)) {
        distanceCm = mountHeightCm - packet.reportedDepthCm;
      }

      pushTelemetrySample({
        distanceCm,
        mountHeightCm,
        reportedDepthCm: packet.reportedDepthCm,
        timestampMs: packet.receivedAtMs,
        errorCode: packet.errorCode,
        firmwareQuality: packet.firmwareQuality,
        burstSpreadCm: packet.burstSpreadCm,
        validPings: packet.validPings,
        reportedStatus: packet.reportedStatus,
        format: packet.format
      });
    },
    onError(errMsg) {
      setDashboardNotice(errMsg, 'error');
      showToast(errMsg, 'WARNING');
      renderDashboard();
    }
  });

  function setDemoStage(stageIndex, announce = false) {
    const idx = Math.max(0, Math.min(DEMO_STAGES.length - 1, stageIndex));
    telemetryState.demoStageIndex = idx;
    telemetryState.demoStageTickCount = 0;

    // Position starting depth cleanly when manually jumping stages
    const stageStartDepths = [0.08, 0.22, 0.56, 1.32, 1.65, 0.40];
    if (announce) {
      telemetryState.simCurrentDepthCm = stageStartDepths[idx];
      showToast(`DEMO MODE: ${DEMO_STAGES[idx].name}`, idx === 3 ? 'CRITICAL' : idx === 2 ? 'WARNING' : 'NORMAL');
    }
    renderDemoStageBar();
  }

  function renderDemoStageBar() {
    const descEl = document.getElementById('demoStageDescription');
    const autoBtn = document.getElementById('btnDemoAutoToggle');
    const stage = DEMO_STAGES[telemetryState.demoStageIndex] || DEMO_STAGES[0];
    if (descEl) descEl.textContent = stage.description;
    if (autoBtn) {
      autoBtn.textContent = telemetryState.demoAutoAdvance ? 'Pause Auto-Sequence' : 'Resume Auto-Sequence';
    }
    document.querySelectorAll('.demo-stage-btn').forEach((btn) => {
      const sIdx = Number(btn.getAttribute('data-demo-stage'));
      btn.classList.toggle('active', sIdx === telemetryState.demoStageIndex);
    });
  }

  function startSimulationBackup() {
    if (arduinoClient.connected) {
      showToast('Disconnect live Arduino USB before launching Demo Mode.', 'WARNING');
      return;
    }

    stopSimulationBackup(false);
    telemetryState.mode = 'SIMULATED';
    telemetryState.streamHealth = 'OK';
    telemetryState.suspiciousTotalCount = 0;
    telemetryState.calibration = {
      status: 'DEMO',
      baselineCm: PROTOTYPE_PRESETS.EXPERIMENTAL_STREET_MODEL.mountHeightCm,
      calibratedAtMs: Date.now(),
      dryBuffer: [],
      driftNote: ''
    };
    telemetryState.demoStageIndex = 0;
    telemetryState.demoAutoAdvance = true;
    telemetryState.demoStageTickCount = 0;
    telemetryState.simCurrentDepthCm = 0.06;
    telemetryState.samples = [];
    telemetryState.lastAlertStatus = null;
    telemetryState.connectionText =
      'DEMO MODE active (1s simulated classroom sequence · Strictly separated from live Arduino hardware)';
    telemetryState.latestHardware = {
      device: 'DEMO_MODE_SIMULATOR',
      format: 'demo',
      lastRawLine: '',
      floatLow: false,
      floatHigh: false,
      barrierState: 'not_installed',
      lastPacketMs: Date.now()
    };
    setDashboardNotice(
      'DEMO MODE active — simulating the 6-stage NYC street flood scenario (Normal → Rising → Warning → Critical → Receding → Recovery). No Arduino hardware connected.',
      'warn'
    );

    const stepDemo = () => {
      if (telemetryState.mode !== 'SIMULATED') return;
      const stage = DEMO_STAGES[telemetryState.demoStageIndex] || DEMO_STAGES[0];
      const mount = PROTOTYPE_PRESETS.EXPERIMENTAL_STREET_MODEL.mountHeightCm; // 14.39 cm dry baseline
      const maxDepth = 2.40;

      // Move smoothly toward the active stage target depth
      const diff = stage.targetDepthCm - telemetryState.simCurrentDepthCm;
      if (Math.abs(diff) <= Math.abs(stage.stepPerTickCm)) {
        telemetryState.simCurrentDepthCm = stage.targetDepthCm + (Math.random() - 0.5) * 0.02;
      } else {
        const dir = diff > 0 ? 1 : -1;
        const step = Math.abs(stage.stepPerTickCm) + (Math.random() - 0.5) * 0.012;
        telemetryState.simCurrentDepthCm = Math.max(
          0,
          Math.min(maxDepth, telemetryState.simCurrentDepthCm + dir * step)
        );
      }

      // Small realistic ultrasonic ripple (±0.015 cm)
      const ripple = (Math.random() - 0.5) * 0.03;
      const simulatedDepth = Math.max(0, Number((telemetryState.simCurrentDepthCm + ripple).toFixed(2)));
      const simulatedDistance = Number(Math.max(2.2, mount - simulatedDepth).toFixed(2));
      const simStatus =
        simulatedDepth >= PROTOTYPE_PRESETS.EXPERIMENTAL_STREET_MODEL.critThresholdCm
          ? 'CRITICAL'
          : simulatedDepth >= PROTOTYPE_PRESETS.EXPERIMENTAL_STREET_MODEL.warnThresholdCm
          ? 'WARNING'
          : 'NORMAL';

      telemetryState.latestHardware.floatLow = simulatedDepth >= 0.5;
      telemetryState.latestHardware.floatHigh = simulatedDepth >= 1.25;
      telemetryState.latestHardware.lastPacketMs = Date.now();
      telemetryState.latestHardware.lastRawLine =
        `[DEMO] Distance: ${simulatedDistance.toFixed(2)} cm | Water Depth: ${simulatedDepth.toFixed(2)} cm | Status: ${simStatus}`;

      pushTelemetrySample({
        distanceCm: simulatedDistance,
        mountHeightCm: mount,
        reportedDepthCm: simulatedDepth,
        timestampMs: Date.now(),
        format: 'demo'
      });

      telemetryState.demoStageTickCount += 1;
      if (telemetryState.demoAutoAdvance && telemetryState.demoStageTickCount >= stage.autoTicks) {
        const nextStage = (telemetryState.demoStageIndex + 1) % DEMO_STAGES.length;
        telemetryState.demoStageIndex = nextStage;
        telemetryState.demoStageTickCount = 0;
        renderDemoStageBar();
      }
    };

    renderDemoStageBar();
    stepDemo();
    telemetryState.simTimerId = setInterval(stepDemo, 1000);
    renderDashboard();
  }

  function stopSimulationBackup(resetToUnavailable = true) {
    if (telemetryState.simTimerId) {
      clearInterval(telemetryState.simTimerId);
      telemetryState.simTimerId = null;
    }
    if (resetToUnavailable && telemetryState.mode === 'SIMULATED') {
      telemetryState.mode = 'UNAVAILABLE';
      telemetryState.streamHealth = 'IDLE';
      telemetryState.samples = [];
      telemetryState.lastAlertStatus = null;
      resetCalibrationState('UNSET');
      telemetryState.connectionText =
        'Demo Mode stopped · Connect Arduino GIGA R1 WiFi over USB or launch Demo Mode.';
      telemetryState.latestHardware.floatLow = null;
      telemetryState.latestHardware.floatHigh = null;
      telemetryState.latestHardware.lastPacketMs = null;
      telemetryState.latestHardware.lastRawLine = '';
      setDashboardNotice('', 'info');
      recalculateTelemetryAndRender(false);
    }
  }

  function startLiveStaleWatchdog() {
    if (staleWatchTimerId) clearInterval(staleWatchTimerId);
    const STALE_TIMEOUT_MS = 6000; // Flag stale data promptly (>6s without a reading)
    staleWatchTimerId = setInterval(() => {
      if (telemetryState.mode === 'LIVE' && telemetryState.latestHardware.lastPacketMs) {
        const elapsed = Date.now() - telemetryState.latestHardware.lastPacketMs;
        if (elapsed > STALE_TIMEOUT_MS) {
          const secs = Math.round(elapsed / 1000);
          telemetryState.mode = 'UNAVAILABLE';
          telemetryState.streamHealth = 'STALE';
          telemetryState.samples = []; // Clear live buffer so stale readings are NEVER shown as live
          telemetryState.connectionText = `Stale Data Warning: No Arduino readings received for ${secs}s (last packet ${new Date(telemetryState.latestHardware.lastPacketMs).toLocaleTimeString()}).`;
          appendSystemAlertEvent('STALE_DATA', `No Arduino serial packets received for ${secs}s`);
          setDashboardNotice(
            `Stale Data Warning — Arduino readings stopped arriving (${secs}s elapsed). Live depth paused until fresh serial packets arrive.`,
            'warn'
          );
          showToast('Stale Data Warning: Arduino readings stopped arriving.', 'WARNING');
          recalculateTelemetryAndRender(false);
        }
      }
    }, 1000);
  }

  /* --------------------------------------------------------------------------
   * 6. DASHBOARD RENDERING, ALERT HISTORY, WEATHER, RISK INTEL & AI ASSISTANT
   * -------------------------------------------------------------------------- */
  function renderDashboard() {
    const cfg = getEffectiveThresholds();
    const analysis =
      telemetryState.latestAnalysis ||
      analyzeWaterTelemetry(telemetryState.samples, cfg, telemetryState.mode);

    // 1. Source indicator, Sensor Quality, Calibration Status, Timestamp & Connection Controls
    const sourceBadge = document.getElementById('dashSourceBadge');
    const qualityBadge = document.getElementById('dashQualityBadge');
    const calibBadge = document.getElementById('dashCalibrationBadge');
    const lastTsEl = document.getElementById('dashLastTimestamp');
    const sourceDetail = document.getElementById('dashSourceDetail');
    const btnConnect = document.getElementById('btnConnectArduino');
    const btnRecalib = document.getElementById('btnOpenRecalibrate');
    const btnDisconnect = document.getElementById('btnDisconnectArduino');
    const btnSimToggle = document.getElementById('btnToggleSimBackup');
    const simStrip = document.getElementById('simControlStrip');

    const isConnLost = telemetryState.streamHealth === 'CONNECTION_LOST';
    const isStale = telemetryState.streamHealth === 'STALE';

    const presMirror = document.getElementById('presSourceMirror');
    if (sourceBadge) {
      if (telemetryState.mode === 'LIVE') {
        sourceBadge.textContent = 'LIVE MODE · ARDUINO USB';
        sourceBadge.className = 'source-indicator source-live';
        if (presMirror) {
          presMirror.textContent = 'LIVE ARDUINO USB';
          presMirror.className = 'status-tag tag-normal';
        }
      } else if (telemetryState.mode === 'SIMULATED') {
        sourceBadge.textContent = 'DEMO MODE · SIMULATED';
        sourceBadge.className = 'source-indicator source-simulated';
        if (presMirror) {
          presMirror.textContent = 'DEMO MODE (SIMULATED)';
          presMirror.className = 'status-tag tag-warn';
        }
      } else if (isConnLost) {
        sourceBadge.textContent = 'CONNECTION LOST';
        sourceBadge.className = 'source-indicator source-disconnected';
        if (presMirror) {
          presMirror.textContent = 'CONNECTION LOST';
          presMirror.className = 'status-tag tag-critical';
        }
      } else if (isStale) {
        sourceBadge.textContent = 'STALE DATA · NO SIGNAL';
        sourceBadge.className = 'source-indicator source-stale';
        if (presMirror) {
          presMirror.textContent = 'STALE DATA';
          presMirror.className = 'status-tag tag-warn';
        }
      } else if (arduinoClient.connected) {
        sourceBadge.textContent = 'USB CONNECTED · WAITING';
        sourceBadge.className = 'source-indicator source-unavailable';
        if (presMirror) {
          presMirror.textContent = 'USB WAITING';
          presMirror.className = 'status-tag tag-neutral';
        }
      } else {
        sourceBadge.textContent = 'OFFLINE / UNAVAILABLE';
        sourceBadge.className = 'source-indicator source-unavailable';
        if (presMirror) {
          presMirror.textContent = 'OFFLINE';
          presMirror.className = 'status-tag tag-neutral';
        }
      }
    }

    if (qualityBadge) {
      qualityBadge.textContent = `Sensor Quality: ${analysis.sensorQualityLabel}`;
      qualityBadge.title = analysis.sensorQualityReason || '';
      if (analysis.sensorQuality === 'GOOD') {
        qualityBadge.className = 'meta-status-text quality-text-good';
      } else if (analysis.sensorQuality === 'UNSTABLE') {
        qualityBadge.className = 'meta-status-text quality-text-unstable';
      } else if (analysis.sensorQuality === 'OUT_OF_RANGE') {
        qualityBadge.className = 'meta-status-text quality-text-out-of-range';
      } else {
        qualityBadge.className = 'meta-status-text quality-text-unavailable';
      }
    }

    const cal = telemetryState.calibration;
    let calibStatusShort = 'Not Connected';
    let calibStatusLong = 'Not connected';
    let calibCls = 'quality-text-unavailable';
    if (telemetryState.mode === 'SIMULATED') {
      calibStatusShort = `Demo (${Number(cal.baselineCm || 14.39).toFixed(2)} cm)`;
      calibStatusLong = `Demo baseline (${Number(cal.baselineCm || 14.39).toFixed(2)} cm)`;
      calibCls = 'quality-text-good';
    } else if (cal.status === 'CALIBRATING') {
      calibStatusShort = 'Recalibrating…';
      calibStatusLong = 'Recalibrating dry-road baseline ("c" sent)…';
      calibCls = 'quality-text-unstable';
    } else if (cal.status === 'LOCKED_ARDUINO' && cal.baselineCm != null) {
      calibStatusShort = `Locked (${cal.baselineCm.toFixed(2)} cm)`;
      calibStatusLong = `Calibrated & locked by Arduino (${cal.baselineCm.toFixed(2)} cm)`;
      calibCls = cal.driftNote ? 'quality-text-unstable' : 'quality-text-good';
    } else if (cal.status === 'LOCKED_DRY_MEDIAN' && cal.baselineCm != null) {
      calibStatusShort = `Locked Dry (${cal.baselineCm.toFixed(2)} cm)`;
      calibStatusLong = `Locked from dry-road median (${cal.baselineCm.toFixed(2)} cm)`;
      calibCls = cal.driftNote ? 'quality-text-unstable' : 'quality-text-good';
    } else if (cal.status === 'LOCKED_INFERRED' && cal.baselineCm != null) {
      calibStatusShort = `Locked (${cal.baselineCm.toFixed(2)} cm)`;
      calibStatusLong = `Locked from Arduino telemetry (${cal.baselineCm.toFixed(2)} cm)`;
      calibCls = cal.driftNote ? 'quality-text-unstable' : 'quality-text-good';
    } else if (arduinoClient.connected && cal.dryBuffer.length > 0) {
      calibStatusShort = `Locking dry (${cal.dryBuffer.length}/3)…`;
      calibStatusLong = `Collecting dry-road reference (${cal.dryBuffer.length}/3 readings)…`;
      calibCls = 'quality-text-unstable';
    } else if (arduinoClient.connected) {
      calibStatusShort = 'Awaiting dry reading';
      calibStatusLong = 'Connected — awaiting dry reading or manual "c" calibration';
      calibCls = 'quality-text-unavailable';
    }

    if (calibBadge) {
      calibBadge.textContent = `Calibration: ${calibStatusShort}`;
      calibBadge.className = `meta-status-text ${calibCls}`;
      calibBadge.title = cal.driftNote || calibStatusLong;
    }

    const lastReadingTimeStr = analysis.lastUpdatedMs
      ? new Date(analysis.lastUpdatedMs).toLocaleTimeString()
      : telemetryState.lastLivePacketMs && (isConnLost || isStale)
      ? `${new Date(telemetryState.lastLivePacketMs).toLocaleTimeString()} (stale)`
      : '--';
    if (lastTsEl) {
      lastTsEl.textContent = `Last reading: ${lastReadingTimeStr}`;
    }

    if (sourceDetail) {
      sourceDetail.textContent = telemetryState.connectionText;
    }

    if (btnConnect) btnConnect.classList.toggle('hidden', arduinoClient.connected);
    if (btnRecalib) btnRecalib.classList.toggle('hidden', !arduinoClient.connected);
    if (btnDisconnect) btnDisconnect.classList.toggle('hidden', !arduinoClient.connected);

    if (btnSimToggle) {
      btnSimToggle.disabled = arduinoClient.connected;
      const simLabel = telemetryState.mode === 'SIMULATED' ? 'Stop Demo Mode' : 'Start Demo Mode';
      const span = btnSimToggle.querySelector('span');
      if (span) {
        span.textContent = simLabel;
      } else {
        btnSimToggle.textContent = simLabel;
      }
    }

    if (simStrip) {
      simStrip.classList.toggle('hidden', telemetryState.mode !== 'SIMULATED');
      if (telemetryState.mode === 'SIMULATED') renderDemoStageBar();
    }

    // 2. Active Flood / Connection Lost / Stale Data Banner
    const alertBanner = document.getElementById('dashAlertBanner');
    const alertTitle = document.getElementById('dashAlertBannerTitle');
    const alertBody = document.getElementById('dashAlertBannerBody');
    const alertTime = document.getElementById('dashAlertBannerTime');
    if (alertBanner && alertTitle && alertBody && alertTime) {
      if (isConnLost) {
        alertBanner.className = 'alert-banner alert-banner-critical';
        alertTitle.textContent = 'ARDUINO DISCONNECTED — CONNECTION LOST';
        alertBody.textContent =
          'USB serial link to the Arduino GIGA R1 WiFi was lost. Live depth readouts have been cleared so stale values are not shown as live. Reconnect USB to resume.';
        alertTime.textContent = telemetryState.lastLivePacketMs
          ? `Last: ${new Date(telemetryState.lastLivePacketMs).toLocaleTimeString()}`
          : '--:--:--';
      } else if (isStale) {
        alertBanner.className = 'alert-banner alert-banner-warning';
        alertTitle.textContent = 'STALE DATA WARNING — NO ARDUINO READINGS';
        alertBody.textContent =
          'No new serial packets have arrived from the Arduino for over 6 seconds. Live display is paused until fresh readings resume.';
        alertTime.textContent = telemetryState.lastLivePacketMs
          ? `Last: ${new Date(telemetryState.lastLivePacketMs).toLocaleTimeString()}`
          : '--:--:--';
      } else if (analysis.status === 'CRITICAL') {
        alertBanner.className = 'alert-banner alert-banner-critical';
        alertTitle.textContent = `${telemetryState.mode === 'SIMULATED' ? '[DEMO] ' : ''}CRITICAL FLOOD ALERT`;
        const trendNote =
          analysis.trend === 'UNCERTAIN'
            ? 'Short-term trend is uncertain, but CRITICAL flood status is confirmed.'
            : `${analysis.trendLabel}.`;
        alertBody.textContent = `Water depth is ${analysis.filteredDepthCm.toFixed(2)} cm (≥ ${cfg.critThresholdCm.toFixed(2)} cm Critical threshold). ${trendNote} Inspect storm drain blockage.`;
        alertTime.textContent = lastReadingTimeStr;
      } else if (analysis.status === 'WARNING') {
        alertBanner.className = 'alert-banner alert-banner-warning';
        alertTitle.textContent = `${telemetryState.mode === 'SIMULATED' ? '[DEMO] ' : ''}FLOOD WARNING ACTIVE`;
        const trendNote =
          analysis.trend === 'UNCERTAIN'
            ? 'Short-term trend is uncertain, but WARNING flood status is confirmed.'
            : `${analysis.trendLabel}.`;
        alertBody.textContent = `Water depth is ${analysis.filteredDepthCm.toFixed(2)} cm (Warning range ${cfg.warnThresholdCm.toFixed(2)}–${(cfg.critThresholdCm - 0.01).toFixed(2)} cm). ${trendNote}`;
        alertTime.textContent = lastReadingTimeStr;
      } else {
        alertBanner.className = 'alert-banner hidden';
      }
    }

    // 3. Flood status card (Green NORMAL, Amber WARNING, Red CRITICAL, plus Connection Lost / Stale)
    const statusCard = document.getElementById('cardFloodStatus');
    const statusVal = document.getElementById('dashStatusValue');
    const statusMeta = document.getElementById('dashStatusMeta');
    const etaWarnThresh = document.getElementById('dashEtaWarnThresh');
    const etaCritThresh = document.getElementById('dashEtaCritThresh');

    if (etaWarnThresh) etaWarnThresh.textContent = Number(cfg.warnThresholdCm).toFixed(2);
    if (etaCritThresh) etaCritThresh.textContent = Number(cfg.critThresholdCm).toFixed(2);

    if (statusCard && statusVal) {
      statusCard.className = 'metric-card';
      if (isConnLost) {
        statusCard.classList.add('status-card-critical');
        statusVal.textContent = 'CONNECTION LOST';
      } else if (isStale) {
        statusCard.classList.add('status-card-warning');
        statusVal.textContent = 'STALE DATA';
      } else if (analysis.status === 'NORMAL') {
        statusCard.classList.add('status-card-normal');
        statusVal.textContent = 'NORMAL';
      } else if (analysis.status === 'WARNING') {
        statusCard.classList.add('status-card-warning');
        statusVal.textContent = 'WARNING';
      } else if (analysis.status === 'CRITICAL') {
        statusCard.classList.add('status-card-critical');
        statusVal.textContent = 'CRITICAL';
      } else if (analysis.status === 'OUT_OF_RANGE') {
        statusCard.classList.add('status-card-out-of-range');
        statusVal.textContent = 'OUT OF RANGE';
      } else {
        statusCard.classList.add('status-card-unavailable');
        statusVal.textContent = 'UNAVAILABLE';
      }
    }

    if (statusMeta) {
      if (isConnLost) {
        statusMeta.textContent = 'Arduino USB disconnected — reconnect port to resume live monitoring.';
      } else if (isStale) {
        statusMeta.textContent = 'No recent packets (>6s) — stale readings are never displayed as live.';
      } else if (analysis.status === 'OUT_OF_RANGE') {
        statusMeta.textContent =
          analysis.sensorQualityReason || 'Ultrasonic echoes out of range — not interpreted as 0.00 cm';
      } else if (analysis.statusSource === 'arduino_confirmed') {
        statusMeta.textContent = `Authoritative Arduino status (3-reading confirmed) · Warn ≥ ${Number(cfg.warnThresholdCm).toFixed(2)} cm · Crit ≥ ${Number(cfg.critThresholdCm).toFixed(2)} cm`;
      } else {
        statusMeta.innerHTML =
          `Normal &lt; <span id="dashWarnValLabel">${Number(cfg.warnThresholdCm).toFixed(2)}</span> cm &middot; ` +
          `Warn &ge; ${Number(cfg.warnThresholdCm).toFixed(2)} cm &middot; ` +
          `Crit &ge; <span id="dashCritValLabel">${Number(cfg.critThresholdCm).toFixed(2)}</span> cm`;
      }
    }

    // 4. Live Water Depth Hero Display (cm) — Clearly separating Locked Baseline vs Current Distance
    const depthEl = document.getElementById('dashDepthCm');
    const depthFormulaEl = document.getElementById('dashDepthFormula');
    const rawLineEl = document.getElementById('dashRawReadingLine');

    if (depthEl) {
      const nextDepthText =
        analysis.available && analysis.filteredDepthCm != null
          ? analysis.filteredDepthCm.toFixed(2)
          : '--';
      const valueChanged = nextDepthText !== lastDisplayedDepthText && nextDepthText !== '--';
      depthEl.textContent = nextDepthText;
      if (valueChanged) {
        depthEl.classList.remove('telemetry-tick-pulse');
        void depthEl.offsetWidth;
        depthEl.classList.add('telemetry-tick-pulse');
      }
      lastDisplayedDepthText = nextDepthText;
    }

    if (depthFormulaEl) {
      if (analysis.available && analysis.filteredDistanceCm != null && analysis.filteredDepthCm != null) {
        const baselineVal = cal.baselineCm ?? analysis.mountHeightCm;
        const baselineTag =
          cal.status === 'LOCKED_ARDUINO' || cal.status === 'LOCKED_DRY_MEDIAN' || cal.status === 'LOCKED_INFERRED'
            ? `Locked Baseline: ${Number(baselineVal).toFixed(2)} cm`
            : `Baseline Ref: ${Number(baselineVal).toFixed(2)} cm`;
        depthFormulaEl.textContent = `${baselineTag} · Current Distance: ${analysis.filteredDistanceCm.toFixed(2)} cm`;
      } else if (isConnLost) {
        depthFormulaEl.textContent = 'Connection Lost — live depth cleared';
      } else if (isStale) {
        depthFormulaEl.textContent = 'Stale Data — awaiting fresh Arduino reading';
      } else if (analysis.status === 'OUT_OF_RANGE') {
        depthFormulaEl.textContent = 'Invalid ultrasonic distance — not shown as 0.00 cm';
      } else {
        depthFormulaEl.textContent = 'Calibrated Baseline: -- · Current Distance: --';
      }
    }

    if (rawLineEl) {
      rawLineEl.className = 'metric-subtext mono-text raw-reading-subtext';
      if (analysis.rawReadingStatus === 'OUT_OF_RANGE') {
        rawLineEl.classList.add('raw-reading-flagged');
        rawLineEl.textContent =
          analysis.rawDistanceCm != null
            ? `Flagged: Raw distance ${analysis.rawDistanceCm.toFixed(2)} cm (Out of Range)`
            : 'Flagged: Ultrasonic timeout (Out of Range)';
      } else if (analysis.rawReadingStatus === 'SUSPICIOUS') {
        rawLineEl.classList.add('raw-reading-spike');
        rawLineEl.textContent = `Suspicious reading flagged: ${analysis.suspiciousReason}`;
      } else if (analysis.rawReadingStatus === 'SPIKE_REJECTED') {
        rawLineEl.classList.add('raw-reading-spike');
        rawLineEl.textContent =
          analysis.rawDistanceCm != null
            ? `Suspicious jump rejected: ${analysis.rawDistanceCm.toFixed(2)} cm`
            : 'Suspicious reading rejected';
      } else if (cal.driftNote && telemetryState.mode === 'LIVE') {
        rawLineEl.classList.add('raw-reading-spike');
        rawLineEl.textContent = cal.driftNote;
      } else if (analysis.authoritativeArduino && analysis.rawDistanceCm != null) {
        rawLineEl.textContent = `Authoritative Arduino depth: ${analysis.filteredDepthCm.toFixed(2)} cm · Status: ${analysis.status}`;
      } else if (analysis.rawDistanceCm != null && analysis.rawDepthCm != null) {
        rawLineEl.textContent = `Current distance: ${analysis.rawDistanceCm.toFixed(2)} cm · Raw depth: ${analysis.rawDepthCm.toFixed(2)} cm`;
      } else {
        rawLineEl.textContent = 'Sensor distance: -- · Calibration: --';
      }
    }

    // 5. Water-Level Trend (explicitly distinguished from confirmed flood alerts)
    const trendValEl = document.getElementById('dashTrendValue');
    const trendMetaEl = document.getElementById('dashTrendMeta');
    const trendAlertNoteEl = document.getElementById('dashTrendAlertNote');
    if (trendValEl) {
      trendValEl.className = 'metric-trend-text';
      if (analysis.trend === 'UNAVAILABLE') {
        trendValEl.classList.add('trend-unavailable');
        trendValEl.textContent = isConnLost ? 'Disconnected' : isStale ? 'Paused (Stale)' : 'Unavailable';
      } else if (analysis.trend === 'RISING') {
        trendValEl.classList.add('trend-rising');
        trendValEl.textContent = '▲ Rising Water';
      } else if (analysis.trend === 'FALLING') {
        trendValEl.classList.add('trend-falling');
        trendValEl.textContent = '▼ Falling Water';
      } else if (analysis.trend === 'STABLE') {
        trendValEl.classList.add('trend-stable');
        trendValEl.textContent = '● Stable';
      } else {
        trendValEl.classList.add('trend-uncertain');
        trendValEl.textContent =
          analysis.trendLabel === 'Collecting baseline…' ? 'Collecting baseline…' : '? Trend Uncertain';
      }
    }
    if (trendMetaEl) {
      trendMetaEl.textContent = analysis.trendDetail || 'Waiting for timestamped measurements';
    }
    if (trendAlertNoteEl) {
      if (analysis.alertConfidenceNote && analysis.available) {
        trendAlertNoteEl.textContent = analysis.alertConfidenceNote;
        trendAlertNoteEl.classList.remove('hidden');
      } else {
        trendAlertNoteEl.textContent = '';
        trendAlertNoteEl.classList.add('hidden');
      }
    }

    // 6. Rate of Change (cm/min)
    const rateEl = document.getElementById('dashRateValue');
    const rateMetaEl = document.getElementById('dashRateMeta');
    if (rateEl) {
      if (!analysis.available || analysis.rateCmPerMin == null) {
        rateEl.textContent = '--';
      } else {
        const sign = analysis.rateCmPerMin > 0 ? '+' : '';
        rateEl.textContent = `${sign}${analysis.rateCmPerMin.toFixed(2)}`;
      }
    }
    if (rateMetaEl) {
      if (isConnLost) {
        rateMetaEl.textContent = 'Connection lost — rate paused';
      } else if (isStale) {
        rateMetaEl.textContent = 'Stale stream — rate paused';
      } else if (telemetryState.mode === 'UNAVAILABLE') {
        rateMetaEl.textContent = 'Median filtering & spike checks active';
      } else if (analysis.sensorQuality === 'OUT_OF_RANGE') {
        rateMetaEl.textContent = 'Rate paused — ultrasonic reading out of range';
      } else if (analysis.sensorQuality === 'UNSTABLE') {
        rateMetaEl.textContent = analysis.sensorQualityReason || 'Rate paused — signal unstable';
      } else if (analysis.rateCmPerMin == null) {
        rateMetaEl.textContent = `Collecting trend window (${Math.min(4, analysis.sampleCount)}/4 clean samples)`;
      } else {
        rateMetaEl.textContent = `Window: ${Math.min(10, analysis.sampleCount)} clean · R² = ${analysis.rSquared.toFixed(2)}`;
      }
    }

    // 7. Early-Warning Threshold ETA & Prediction Confidence
    const etaWarnEl = document.getElementById('dashEtaWarnVal');
    const etaCritEl = document.getElementById('dashEtaCritVal');
    const etaConfEl = document.getElementById('dashEtaConfidence');
    const etaNoteEl = document.getElementById('dashEtaNote');
    if (etaWarnEl) {
      etaWarnEl.textContent = analysis.etaWarning?.label || 'Insufficient Data';
      etaWarnEl.className =
        'eta-val' +
        (analysis.etaWarning?.reached
          ? ' eta-reached'
          : analysis.etaWarning?.available
          ? ' eta-active'
          : '');
    }
    if (etaCritEl) {
      etaCritEl.textContent = analysis.etaCritical?.label || 'Insufficient Data';
      etaCritEl.className =
        'eta-val' +
        (analysis.etaCritical?.reached
          ? ' eta-reached'
          : analysis.etaCritical?.available
          ? ' eta-active'
          : '');
    }
    if (etaConfEl) {
      const confLabel = isConnLost
        ? 'Insufficient Data (Disconnected)'
        : isStale
        ? 'Insufficient Data (Stale Stream)'
        : analysis.predictionConfidenceLabel || 'Insufficient Data';
      etaConfEl.textContent = `Confidence: ${confLabel}`;
    }
    if (etaNoteEl) {
      if (isConnLost) {
        etaNoteEl.textContent = 'ETA suppressed — USB connection lost.';
      } else if (isStale) {
        etaNoteEl.textContent = 'ETA suppressed — awaiting fresh Arduino reading.';
      } else if (analysis.sensorQuality === 'OUT_OF_RANGE' || analysis.sensorQuality === 'UNSTABLE') {
        etaNoteEl.textContent = `ETA suppressed while sensor quality is ${analysis.sensorQualityLabel}.`;
      } else {
        etaNoteEl.textContent =
          analysis.predictionLimitation ||
          'Trend-based linear extrapolation only (not a validated weather forecast).';
      }
    }

    // 8. Hardware Diagnostics Strip
    const hwConn = document.getElementById('hwSerialConnVal');
    const hwLastTs = document.getElementById('hwLastTimestampVal');
    const hwQuality = document.getElementById('hwSensorQualityVal');
    const hwCalibStatus = document.getElementById('hwCalibStatusVal');
    const hwFilteredDist = document.getElementById('hwFilteredDistanceVal');
    const hwDist = document.getElementById('hwDistanceVal');
    const hwMount = document.getElementById('hwMountHeightVal');
    const hwSuspicious = document.getElementById('hwSuspiciousCountVal');
    const hwRawLine = document.getElementById('hwRawSerialLine');
    const hwFloatStatus = document.getElementById('hwFloatStatusVal');
    const hwSupabase = document.getElementById('hwSupabaseDemoStatus');

    if (hwConn) {
      if (arduinoClient.connected && telemetryState.mode === 'LIVE') {
        hwConn.textContent = `Connected (${telemetryState.latestHardware.format === 'text' ? '115200 Authoritative Text' : '115200 JSON'})`;
      } else if (isConnLost) {
        hwConn.textContent = 'Connection Lost (USB Disconnected)';
      } else if (isStale) {
        hwConn.textContent = 'USB Open — Stale (>6s without packet)';
      } else if (arduinoClient.connected) {
        hwConn.textContent = 'USB Open (Awaiting data)';
      } else if (telemetryState.mode === 'SIMULATED') {
        hwConn.textContent = 'Demo Mode (No USB port open)';
      } else {
        hwConn.textContent = isWebSerialSupported() ? 'Disconnected' : 'Web Serial unsupported in this browser';
      }
    }
    if (hwLastTs) hwLastTs.textContent = lastReadingTimeStr;
    if (hwQuality) hwQuality.textContent = analysis.sensorQualityLabel;
    if (hwCalibStatus) hwCalibStatus.textContent = calibStatusLong;
    if (hwFilteredDist) {
      hwFilteredDist.textContent =
        analysis.available && analysis.filteredDistanceCm != null
          ? `${analysis.filteredDistanceCm.toFixed(2)} cm`
          : '--';
    }
    if (hwDist) {
      if (analysis.rawDistanceCm != null) {
        const flag =
          analysis.rawReadingStatus === 'OUT_OF_RANGE'
            ? ' (Out of Range)'
            : analysis.rawReadingStatus === 'SUSPICIOUS'
            ? ' (Suspicious — flagged)'
            : analysis.rawReadingStatus === 'SPIKE_REJECTED'
            ? ' (Spike rejected)'
            : '';
        hwDist.textContent = `${analysis.rawDistanceCm.toFixed(2)} cm${flag}`;
      } else if (analysis.rawReadingStatus === 'OUT_OF_RANGE') {
        hwDist.textContent = 'Timeout (Out of Range)';
      } else {
        hwDist.textContent = '--';
      }
    }
    if (hwMount) {
      if (cal.baselineCm != null) {
        hwMount.textContent = `${cal.baselineCm.toFixed(2)} cm (locked)`;
      } else {
        hwMount.textContent = `${Number(cfg.mountHeightCm).toFixed(2)} cm (default)`;
      }
    }
    if (hwSuspicious) {
      hwSuspicious.textContent =
        telemetryState.suspiciousTotalCount > 0
          ? `${telemetryState.suspiciousTotalCount} flagged (no data invented)`
          : '0';
    }
    if (hwRawLine) {
      hwRawLine.textContent = telemetryState.latestHardware.lastRawLine || '--';
    }
    if (hwFloatStatus) {
      if (floatSwitchState.state) {
        const tsStr = floatSwitchState.lastUpdatedMs
          ? ` · ${new Date(floatSwitchState.lastUpdatedMs).toLocaleTimeString()}`
          : '';
        hwFloatStatus.textContent = `Liyafy XSL-3508-P: ${floatSwitchState.state}${tsStr}`;
      } else {
        const fl = telemetryState.latestHardware.floatLow;
        const fh = telemetryState.latestHardware.floatHigh;
        if (telemetryState.mode === 'UNAVAILABLE' || (fl === null && fh === null)) {
          hwFloatStatus.textContent = 'Awaiting Float Switch: OPEN / CLOSED';
        } else {
          const suffix = telemetryState.mode === 'SIMULATED' ? ' (Demo)' : '';
          hwFloatStatus.textContent = `Low: ${fl ? 'Triggered' : 'Dry'} · High: ${fh ? 'Triggered' : 'Dry'}${suffix}`;
        }
      }
    }
    if (hwSupabase) {
      hwSupabase.textContent = supabaseDemoState.summaryText;
    }

    renderActionableGuidance(analysis, isStale, isConnLost);
    renderLiveWalkthroughPanel(analysis);
    renderMeasurementValidationPanel(analysis);
    renderBackupFloatPanel();
    renderTestSessionPanel();
    renderRiskIntelligencePanel();
    renderAlertHistoryPanel();
    drawWaterHistoryChart();
  }

  function renderActionableGuidance(analysis, isStale, isConnLost) {
    const card = document.getElementById('actionableGuidanceCard');
    const tag = document.getElementById('actionableGuidanceTag');
    const sub = document.getElementById('actionableGuidanceSubtitle');
    const list = document.getElementById('actionableGuidanceList');
    if (!card || !tag || !sub || !list) return;

    const status = isConnLost || isStale ? 'UNAVAILABLE' : (analysis?.status || 'UNAVAILABLE');
    const depthStr = analysis?.available && analysis?.filteredDepthCm != null
      ? `${analysis.filteredDepthCm.toFixed(2)} cm`
      : null;

    card.className = 'surface-card actionable-guidance-card dash-panel-gap';
    let items = [];

    if (status === 'CRITICAL') {
      card.classList.add('guidance-critical');
      tag.className = 'status-tag tag-critical';
      tag.textContent = 'CRITICAL ACTION';
      sub.textContent = depthStr
        ? `Critical standing water detected (${depthStr} >= ${prototypeSettingsState.values.critThresholdCm.toFixed(2)} cm) — immediate safety precautions recommended.`
        : 'Critical standing water detected — immediate safety precautions recommended.';
      items = [
        'Avoid walking, cycling, or driving through flooded roadways and underpasses — never cross moving or standing street water.',
        'Move out of basement apartments or below-grade spaces to higher ground immediately if water begins entering.',
        'Keep clear of downed power lines, submerged electrical outlets, and open or overflowing manhole covers.',
        'Follow official NYC Emergency Management (Notify NYC) and National Weather Service Flash Flood alerts.'
      ];
    } else if (status === 'WARNING') {
      card.classList.add('guidance-warning');
      tag.className = 'status-tag tag-warn';
      tag.textContent = 'WARNING — PREPARE';
      const etaText =
        analysis?.etaCritical?.available && !analysis?.etaCritical?.reached
          ? ` (linear trend ETA to Critical: ${analysis.etaCritical.label})`
          : '';
      sub.textContent = depthStr
        ? `Elevated water detected (${depthStr})${etaText} — monitor closely and take precautionary steps.`
        : 'Elevated water detected — monitor closely and take precautionary steps.';
      items = [
        'Monitor rising water levels closely and inspect nearby storm-drain grates safely from dry ground for leaf or trash blockages.',
        'Move valuables, electronics, and vehicles out of low-lying streets, driveways, or basement entrances before water climbs further.',
        'Check basement sump pumps, door barriers, and backup flashlights; prepare an evacuation route to higher floors if needed.',
        'Monitor live Open-Meteo rainfall rates and official NWS / Notify NYC advisories for intensifying storms.'
      ];
    } else if (status === 'NORMAL') {
      card.classList.add('guidance-normal');
      tag.className = 'status-tag tag-normal';
      tag.textContent = 'NORMAL — ROUTINE';
      sub.textContent = depthStr
        ? `Street depth is within normal range (${depthStr} < ${prototypeSettingsState.values.warnThresholdCm.toFixed(2)} cm).`
        : 'Street depth is within normal range.';
      items = [
        'Normal drainage conditions on the monitored street surface — continue routine monitoring.',
        'Before forecasted rain, clear leaves and litter off neighborhood catch-basin grates so runoff can enter sewers freely.',
        'Review NYC Emergency Management flood readiness plans and sign up for official Notify NYC alerts.'
      ];
    } else if (status === 'OUT_OF_RANGE') {
      tag.className = 'status-tag tag-warn';
      tag.textContent = 'SENSOR CHECK';
      sub.textContent = 'Ultrasonic sensor reading is out of range — flood status cannot be confirmed.';
      items = [
        'Do not assume the street is dry while the sensor reports Out of Range — inspect the physical roadway or water basin directly.',
        'Check HC-SR04 wiring (TRIG D9, ECHO voltage divider to D10), sensor alignment, and water proximity to the ~2 cm blind zone.',
        'Rely on visual observation and official NYC Emergency Management / NWS alerts whenever sensor telemetry is invalid.'
      ];
    } else {
      tag.className = 'status-tag tag-neutral';
      tag.textContent = isConnLost ? 'DISCONNECTED' : isStale ? 'STALE DATA' : 'UNAVAILABLE';
      sub.textContent = isConnLost
        ? 'Arduino USB connection was lost — reconnect hardware to resume live status guidance.'
        : isStale
        ? 'No fresh sensor packet received in > 6 seconds — status guidance paused.'
        : 'Connect your Arduino GIGA R1 WiFi over USB to receive live status-based guidance, or start Demo Mode for a simulated walkthrough.';
      items = [
        'Connect your Arduino GIGA R1 WiFi over USB (115200 baud) to activate real-time status-based flood guidance.',
        'Check live NYC Weather & Rainfall Forecast below for upcoming heavy precipitation before street ponding starts.',
        'Keep nearby storm-drain grates free of debris and always follow official NYCEM / NWS alerts during real storms.'
      ];
    }

    list.innerHTML = items.map((txt) => `<li>${escapeHtml(txt)}</li>`).join('');
  }

  function renderLiveWalkthroughPanel(analysis) {
    const badge = document.getElementById('walkthroughModeBadge');
    const grid = document.getElementById('walkthroughStepsGrid');
    if (!badge || !grid) return;

    const isLive = telemetryState.mode === 'LIVE' && telemetryState.streamHealth === 'OK';
    const isSim = telemetryState.mode === 'SIMULATED';

    if (isLive) {
      badge.className = 'status-tag tag-normal';
      badge.textContent = 'LIVE Arduino Mode';
    } else if (isSim) {
      badge.className = 'status-tag tag-info';
      badge.textContent = 'SIMULATED Demo Mode (Separate)';
    } else {
      badge.className = 'status-tag tag-neutral';
      badge.textContent = 'Awaiting LIVE Arduino';
    }

    // Auto-highlight milestones ONLY from authentic LIVE Arduino readings
    if (isLive && analysis && analysis.available) {
      if (analysis.status === 'NORMAL') {
        walkthroughState.autoDone.add(1);
      }
      if (analysis.trend === 'RISING') {
        walkthroughState.autoDone.add(5);
      }
      if (analysis.status === 'WARNING' || analysis.status === 'CRITICAL') {
        walkthroughState.autoDone.add(6);
        walkthroughState.autoDone.add(8);
        walkthroughState.sawFloodInLive = true;
      }
      if (
        (analysis.etaWarning?.available && !analysis.etaWarning?.reached) ||
        (analysis.etaCritical?.available && !analysis.etaCritical?.reached)
      ) {
        walkthroughState.autoDone.add(7);
      }
      if (walkthroughState.sawFloodInLive && (analysis.trend === 'FALLING' || analysis.status === 'NORMAL')) {
        walkthroughState.autoDone.add(9);
      }
    }

    // Determine active highlighted step
    let activeStep = null;
    if (isLive && analysis && analysis.available) {
      if (analysis.status === 'CRITICAL') activeStep = 6;
      else if (analysis.etaCritical?.available && !analysis.etaCritical?.reached) activeStep = 7;
      else if (analysis.status === 'WARNING') activeStep = 6;
      else if (analysis.trend === 'RISING') activeStep = 5;
      else if (walkthroughState.sawFloodInLive && analysis.trend === 'FALLING') activeStep = 9;
      else if (analysis.status === 'NORMAL') activeStep = 1;
    }

    grid.querySelectorAll('.walkthrough-step').forEach((btn) => {
      const stepNum = Number(btn.getAttribute('data-step'));
      const done = walkthroughState.manualDone.has(stepNum) || walkthroughState.autoDone.has(stepNum);
      btn.classList.toggle('step-done', done);
      btn.classList.toggle('step-active', activeStep === stepNum);
      btn.setAttribute('aria-pressed', done ? 'true' : 'false');
    });
  }

  function renderMeasurementValidationPanel(analysis) {
    const sensorPreview = document.getElementById('valSensorReadoutPreview');
    const logBtn = document.getElementById('btnLogRulerComparison');
    const statusBadge = document.getElementById('validationStatusBadge');
    const liveCountEl = document.getElementById('valLiveCount');
    const maeEl = document.getElementById('valMaeCm');
    const maxErrEl = document.getElementById('valMaxErrCm');
    const biasEl = document.getElementById('valBiasCm');
    const summaryNoteEl = document.getElementById('validationSummaryNote');
    const tableWrap = document.getElementById('validationTableWrap');
    const tbody = document.getElementById('validationTableBody');

    const activeAnalysis = analysis || telemetryState.latestAnalysis;
    const hasValidReading =
      (telemetryState.mode === 'LIVE' || telemetryState.mode === 'SIMULATED') &&
      telemetryState.streamHealth !== 'STALE' &&
      telemetryState.streamHealth !== 'CONNECTION_LOST' &&
      activeAnalysis &&
      activeAnalysis.available &&
      activeAnalysis.filteredDepthCm != null;

    if (sensorPreview) {
      if (hasValidReading) {
        const modeTag = telemetryState.mode === 'LIVE' ? 'LIVE' : 'SIM';
        sensorPreview.value = `${activeAnalysis.filteredDepthCm.toFixed(2)} cm (${modeTag})`;
      } else {
        sensorPreview.value = 'No valid sensor reading';
      }
    }
    if (logBtn) {
      logBtn.disabled = !hasValidReading;
    }

    const summary = summarizeValidationResults(validationState.entries);

    if (statusBadge) {
      statusBadge.className = `status-tag ${summary.statusTagClass}`;
      statusBadge.textContent = summary.statusLabel;
    }
    if (liveCountEl) liveCountEl.textContent = String(summary.liveCount);
    if (maeEl) maeEl.textContent = summary.maeCm != null ? `±${summary.maeCm.toFixed(2)} cm` : '-- cm';
    if (maxErrEl) maxErrEl.textContent = summary.maxAbsErrorCm != null ? `${summary.maxAbsErrorCm.toFixed(2)} cm` : '-- cm';
    if (biasEl) {
      biasEl.textContent =
        summary.meanBiasCm != null
          ? `${summary.meanBiasCm >= 0 ? '+' : ''}${summary.meanBiasCm.toFixed(2)} cm`
          : '-- cm';
    }
    if (summaryNoteEl) summaryNoteEl.textContent = summary.summaryNote;

    if (tableWrap && tbody) {
      if (validationState.entries.length === 0) {
        tableWrap.classList.add('hidden');
        tbody.innerHTML = '';
      } else {
        tableWrap.classList.remove('hidden');
        tbody.innerHTML = validationState.entries
          .slice(0, 25)
          .map((e) => {
            const sign = e.signedErrorCm >= 0 ? '+' : '';
            const srcClass = e.sourceMode === 'LIVE' ? 'tag-normal' : 'tag-info';
            return `<tr>
              <td class="mono-text">${escapeHtml(new Date(e.timestampMs).toLocaleTimeString())}</td>
              <td><span class="status-tag ${srcClass}">${escapeHtml(e.sourceMode)}</span></td>
              <td class="num-col mono-text">${e.rulerCm.toFixed(2)}</td>
              <td class="num-col mono-text">${e.sensorCm.toFixed(2)}</td>
              <td class="num-col mono-text">${sign}${e.signedErrorCm.toFixed(2)} cm</td>
              <td class="num-col mono-text"><strong>${e.absErrorCm.toFixed(2)} cm</strong></td>
              <td>${escapeHtml(e.note || '—')}</td>
            </tr>`;
          })
          .join('');
      }
    }
  }

  function renderBackupFloatPanel() {
    const stateCard = document.getElementById('floatStateCard');
    const stateVal = document.getElementById('floatSwitchStateVal');
    const metaLine = document.getElementById('floatSwitchMetaLine');
    const validBadge = document.getElementById('floatValidationBadge');
    const agreeTag = document.getElementById('floatAgreementTag');
    const agreeDetail = document.getElementById('floatAgreementDetail');
    const heightInput = document.getElementById('floatActivationHeightInput');
    const polaritySel = document.getElementById('floatClosedPolaritySelect');
    const clearHeightBtn = document.getElementById('btnClearFloatHeight');
    const transCountEl = document.getElementById('floatTransitionCountVal');
    const emptyEl = document.getElementById('floatHistoryEmpty');
    const wrapEl = document.getElementById('floatHistoryWrap');
    const tbody = document.getElementById('floatHistoryTableBody');

    const fs = floatSwitchState;

    if (stateCard && stateVal) {
      if (fs.state === 'OPEN') {
        stateCard.className = 'float-state-box float-state-open';
        stateVal.textContent = 'OPEN';
      } else if (fs.state === 'CLOSED') {
        stateCard.className = 'float-state-box float-state-closed';
        stateVal.textContent = 'CLOSED';
      } else {
        stateCard.className = 'float-state-box float-state-awaiting';
        stateVal.textContent = 'AWAITING DATA';
      }
    }

    if (metaLine) {
      if (fs.state && fs.lastUpdatedMs) {
        metaLine.textContent = `Last update: ${new Date(fs.lastUpdatedMs).toLocaleTimeString()} · ${fs.lastRawLine || `Float Switch: ${fs.state}`}`;
      } else {
        metaLine.innerHTML = 'Waiting for <code>Float Switch: OPEN</code> or <code>Float Switch: CLOSED</code> over USB Serial';
      }
    }

    const hasHeight = fs.activationHeightCm != null && Number.isFinite(fs.activationHeightCm) && fs.activationHeightCm > 0;
    if (validBadge) {
      if (hasHeight) {
        validBadge.textContent = `Height Configured (${fs.activationHeightCm.toFixed(2)} cm)`;
        validBadge.className = 'status-tag tag-info';
      } else {
        validBadge.textContent = 'Electrical Test Only (Not Mounted)';
        validBadge.className = 'status-tag tag-neutral';
      }
    }

    if (heightInput && document.activeElement !== heightInput) {
      heightInput.value = hasHeight ? fs.activationHeightCm.toFixed(2) : '';
    }
    if (polaritySel && document.activeElement !== polaritySel) {
      polaritySel.value = fs.closedMeansWater ? 'water' : 'dry';
    }
    if (clearHeightBtn) {
      clearHeightBtn.disabled = !hasHeight;
    }

    const agreement = evaluateFloatAgreement(
      fs,
      telemetryState.mode === 'LIVE' ? telemetryState.latestAnalysis : null
    );
    if (agreeTag) {
      agreeTag.textContent = agreement.label;
      agreeTag.className = `status-tag ${agreement.tagClass}`;
    }
    if (agreeDetail) {
      agreeDetail.textContent = agreement.detail;
    }

    if (transCountEl) {
      transCountEl.textContent = String(fs.transitionCount);
    }

    if (emptyEl && wrapEl && tbody) {
      if (fs.history.length === 0) {
        emptyEl.classList.remove('hidden');
        wrapEl.classList.add('hidden');
      } else {
        emptyEl.classList.add('hidden');
        wrapEl.classList.remove('hidden');
        tbody.innerHTML = fs.history
          .map((item) => {
            const tagCls = item.newState === 'CLOSED' ? 'tag-warn' : 'tag-info';
            const depthText =
              item.ultrasonicDepthCm != null ? `${item.ultrasonicDepthCm.toFixed(2)} cm` : '--';
            return `
              <tr>
                <td class="mono-text">${escapeHtml(new Date(item.timestampMs).toLocaleTimeString())}</td>
                <td><span class="status-tag ${tagCls}">${escapeHtml(item.transitionLabel)}</span></td>
                <td class="num-col">${escapeHtml(depthText)}</td>
              </tr>
            `;
          })
          .join('');
      }
    }
  }

  function renderTestSessionPanel() {
    const summary = sessionRecorder.getSummary();
    const statusTag = document.getElementById('sessionStatusTag');
    const timerEl = document.getElementById('sessionTimerVal');
    const btnToggle = document.getElementById('btnToggleRecording');
    const btnPumpStop = document.getElementById('btnMarkPumpStopped');
    const btnCsv = document.getElementById('btnDownloadSessionCsv');
    const btnSummary = document.getElementById('btnToggleSessionSummary');
    const btnReset = document.getElementById('btnResetSession');

    const countEl = document.getElementById('sessionSampleCountVal');
    const minMaxEl = document.getElementById('sessionMinMaxVal');
    const timesEl = document.getElementById('sessionStatusTimesVal');
    const transEl = document.getElementById('sessionTransitionsVal');
    const recEl = document.getElementById('sessionRecoveryVal');
    const summaryCard = document.getElementById('sessionSummaryCard');
    const summaryList = document.getElementById('sessionSummaryList');

    if (statusTag) {
      if (summary.recording) {
        statusTag.textContent = `Recording (${summary.sourceMode})`;
        statusTag.className = 'status-tag tag-crit';
      } else if (summary.hasData) {
        statusTag.textContent = 'Completed';
        statusTag.className = 'status-tag tag-normal';
      } else {
        statusTag.textContent = 'Ready';
        statusTag.className = 'status-tag tag-neutral';
      }
    }

    if (timerEl) timerEl.textContent = formatClockTimer(summary.durationMs);
    if (btnToggle) {
      btnToggle.textContent = summary.recording ? 'Stop Recording' : 'Record Test Session';
      btnToggle.className = summary.recording ? 'btn btn-sm btn-danger' : 'btn btn-sm btn-cyan';
    }
    if (btnPumpStop) {
      btnPumpStop.classList.toggle('hidden', !summary.recording);
      btnPumpStop.disabled = !summary.recording;
      btnPumpStop.textContent = summary.pumpStoppedAtMs ? 'Pump 2 Stopped ✓' : 'Mark Pump 2 Stopped';
    }
    if (btnCsv) btnCsv.disabled = !summary.hasData;
    if (btnSummary) btnSummary.disabled = !summary.hasData;
    if (btnReset) btnReset.disabled = !summary.hasData && !summary.recording;

    if (countEl) countEl.textContent = String(summary.sampleCount);
    if (minMaxEl) {
      minMaxEl.textContent =
        summary.minDepthCm != null && summary.maxDepthCm != null
          ? `${summary.minDepthCm.toFixed(2)} / ${summary.maxDepthCm.toFixed(2)} cm`
          : '-- / -- cm';
    }
    if (timesEl) {
      timesEl.textContent = `${formatDurationSeconds(summary.statusSeconds.NORMAL)} / ${formatDurationSeconds(summary.statusSeconds.WARNING)} / ${formatDurationSeconds(summary.statusSeconds.CRITICAL)}`;
    }
    if (transEl) transEl.textContent = String(summary.statusTransitionCount);
    if (recEl) recEl.textContent = summary.hasData ? summary.recoverySummaryText : 'Not recorded yet';

    if (summaryCard && summaryList) {
      const shouldShow = sessionUiState.showSummary && summary.hasData;
      summaryCard.classList.toggle('hidden', !shouldShow);
      if (shouldShow) {
        summaryList.innerHTML = summary.classroomHighlights
          .map((item) => `<li>${escapeHtml(item)}</li>`)
          .join('');
      }
    }
  }

  function renderRiskIntelligencePanel() {
    const intel =
      telemetryState.latestRiskIntel ||
      evaluateFloodRiskIntelligence({
        analysis: telemetryState.latestAnalysis,
        settings: getEffectiveThresholds(),
        weather: weatherState.data,
        sourceMode: telemetryState.mode
      });

    const tag = document.getElementById('riskLevelTag');
    const obsEl = document.getElementById('riskObservedSummary');
    const fcastEl = document.getElementById('riskForecastSummary');
    const rapidBox = document.getElementById('riskRapidRiseBox');
    const rapidVal = document.getElementById('riskRapidRiseVal');
    const drainBox = document.getElementById('riskBlockedDrainBox');
    const drainVal = document.getElementById('riskBlockedDrainVal');
    const drainNote = document.getElementById('riskBlockedDrainNote');
    const driversList = document.getElementById('riskDriversList');
    const recList = document.getElementById('riskRecommendationsList');

    if (tag) {
      tag.textContent = intel.riskLabel;
      if (intel.riskLevel === 'CRITICAL') tag.className = 'status-tag tag-crit';
      else if (intel.riskLevel === 'HIGH' || intel.riskLevel === 'ELEVATED') tag.className = 'status-tag tag-warn';
      else if (intel.riskLevel === 'LOW') tag.className = 'status-tag tag-normal';
      else tag.className = 'status-tag tag-neutral';
    }

    if (obsEl) obsEl.textContent = intel.observedSummary;
    if (fcastEl) fcastEl.textContent = intel.forecastSummary;

    if (rapidBox && rapidVal) {
      if (intel.rapidRiseDetected) {
        rapidBox.className = 'intel-flag-box flag-active-warn';
        rapidVal.textContent = `Rapid Rise Active (≥ ${intel.rapidRiseThresholdCmPerMin.toFixed(2)} cm/min)`;
      } else {
        rapidBox.className = 'intel-flag-box flag-ok';
        rapidVal.textContent = 'Not detected';
      }
    }

    if (drainBox && drainVal) {
      if (intel.blockedDrainSuspected) {
        drainBox.className =
          intel.riskLevel === 'CRITICAL'
            ? 'intel-flag-box flag-active-crit'
            : 'intel-flag-box flag-active-warn';
        drainVal.textContent = 'Blocked Drain Suspected';
      } else if (telemetryState.mode === 'UNAVAILABLE') {
        drainBox.className = 'intel-flag-box';
        drainVal.textContent = 'Awaiting sensor data';
      } else {
        drainBox.className = 'intel-flag-box flag-ok';
        drainVal.textContent = 'Drainage Normal / Receding';
      }
    }

    if (drainNote) drainNote.textContent = intel.blockedDrainNote;

    if (driversList) {
      driversList.innerHTML = intel.drivers.map((d) => `<li>${escapeHtml(d)}</li>`).join('');
    }
    if (recList) {
      recList.innerHTML = intel.recommendations.map((r) => `<li>${escapeHtml(r)}</li>`).join('');
    }
  }

  function renderAlertHistoryPanel() {
    const emptyEl = document.getElementById('alertHistoryEmpty');
    const wrapEl = document.getElementById('alertHistoryTableWrap');
    const tbody = document.getElementById('alertHistoryTableBody');
    if (!tbody) return;

    const events = telemetryState.alertHistory || [];
    if (events.length === 0) {
      emptyEl?.classList.remove('hidden');
      wrapEl?.classList.add('hidden');
      tbody.innerHTML = '';
      return;
    }

    emptyEl?.classList.add('hidden');
    wrapEl?.classList.remove('hidden');

    const statusCls = (st) =>
      st === 'CRITICAL' || st === 'CONNECTION_LOST'
        ? 'event-status-critical'
        : st === 'WARNING' || st === 'STALE_DATA' || st === 'OUT_OF_RANGE'
        ? 'event-status-warning'
        : st === 'NORMAL' || st === 'RECALIBRATED'
        ? 'event-status-normal'
        : 'event-status-other';

    tbody.innerHTML = events
      .map((ev) => {
        const timeStr = new Date(ev.timestampMs).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        });
        const transitionText =
          ev.prevStatus && ev.prevStatus !== 'START'
            ? `${ev.prevStatus} → ${ev.nextStatus}`
            : ev.nextStatus;
        const depthStr = ev.depthCm != null ? `${Number(ev.depthCm).toFixed(2)} cm` : '--';
        const distStr = ev.distanceCm != null ? `${Number(ev.distanceCm).toFixed(2)} cm` : '--';
        return `
          <tr>
            <td class="mono-text">${escapeHtml(timeStr)}</td>
            <td class="mono-text">${escapeHtml(ev.sourceMode)}</td>
            <td><span class="${statusCls(ev.nextStatus)}">${escapeHtml(transitionText)}</span></td>
            <td class="num-col">${escapeHtml(depthStr)}</td>
            <td class="num-col">${escapeHtml(distStr)}</td>
          </tr>
        `;
      })
      .join('');
  }

  function drawWaterHistoryChart() {
    const canvas = document.getElementById('floodHistoryCanvas');
    const emptyOverlay = document.getElementById('dashChartEmptyOverlay');
    if (!canvas) return;

    const cfg = getEffectiveThresholds();
    const analysis =
      telemetryState.latestAnalysis ||
      analyzeWaterTelemetry(telemetryState.samples, cfg, telemetryState.mode);
    const points = analysis.filteredSamples || [];
    lastChartPoints = points;

    const hasData = points.length > 0 && telemetryState.mode !== 'UNAVAILABLE';
    if (emptyOverlay) {
      emptyOverlay.classList.toggle('hidden', hasData);
    }

    const ctx = canvas.getContext('2d');
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(300, rect.width || 680);
    const height = Math.max(240, rect.height || 300);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const pad = { top: 24, right: 24, bottom: 34, left: 56 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const maxPoint = points.length > 0 ? Math.max(...points.map((p) => p.filteredDepthCm)) : 0;
    const maxY = Math.max(cfg.critThresholdCm * 1.5, maxPoint * 1.25, 2.0);
    const yDecimals = maxY <= 5 ? 2 : maxY <= 15 ? 1 : 0;

    // Soft risk-zone shading above Warning and Critical thresholds
    const yWarn = pad.top + plotH - (cfg.warnThresholdCm / maxY) * plotH;
    const yCrit = pad.top + plotH - (cfg.critThresholdCm / maxY) * plotH;

    ctx.save();
    if (yCrit > pad.top) {
      ctx.fillStyle = 'rgba(220, 38, 38, 0.045)';
      ctx.fillRect(pad.left, pad.top, plotW, Math.max(0, yCrit - pad.top));
    }
    if (yWarn > yCrit) {
      ctx.fillStyle = 'rgba(217, 119, 6, 0.04)';
      ctx.fillRect(pad.left, Math.max(pad.top, yCrit), plotW, Math.max(0, yWarn - Math.max(pad.top, yCrit)));
    }
    ctx.restore();

    // Horizontal Gridlines
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#64748B';
    ctx.font = '11px "JetBrains Mono", monospace';
    for (let i = 0; i <= 4; i++) {
      const val = (maxY / 4) * i;
      const y = pad.top + plotH - (val / maxY) * plotH;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.stroke();
      ctx.fillText(`${val.toFixed(yDecimals)} cm`, 4, y + 4);
    }

    // Warning Threshold Dashed Line (Amber)
    ctx.save();
    ctx.strokeStyle = '#D97706';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, yWarn);
    ctx.lineTo(pad.left + plotW, yWarn);
    ctx.stroke();
    ctx.fillStyle = '#B45309';
    ctx.font = '600 11px "JetBrains Mono", monospace';
    ctx.fillText(
      `Warning ${cfg.warnThresholdCm.toFixed(2)} cm`,
      pad.left + 8,
      Math.max(pad.top + 12, yWarn - 6)
    );

    // Critical Threshold Dashed Line (Red)
    ctx.strokeStyle = '#DC2626';
    ctx.beginPath();
    ctx.moveTo(pad.left, yCrit);
    ctx.lineTo(pad.left + plotW, yCrit);
    ctx.stroke();
    ctx.fillStyle = '#B91C1C';
    ctx.fillText(
      `Critical ${cfg.critThresholdCm.toFixed(2)} cm`,
      pad.left + 8,
      Math.max(pad.top + 12, yCrit - 6)
    );
    ctx.restore();

    if (!hasData) return;

    const coords = points.map((pt, idx) => {
      const x =
        points.length === 1
          ? pad.left + plotW / 2
          : pad.left + (idx / (points.length - 1)) * plotW;
      const y = pad.top + plotH - (Math.min(maxY, pt.filteredDepthCm) / maxY) * plotH;
      return { x, y, pt };
    });

    // Refined vertical gradient area fill under depth curve
    ctx.save();
    const areaGrad = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
    if (telemetryState.mode === 'LIVE') {
      areaGrad.addColorStop(0, 'rgba(8, 145, 178, 0.24)');
      areaGrad.addColorStop(1, 'rgba(8, 145, 178, 0.02)');
    } else {
      areaGrad.addColorStop(0, 'rgba(217, 119, 6, 0.20)');
      areaGrad.addColorStop(1, 'rgba(217, 119, 6, 0.02)');
    }
    ctx.beginPath();
    ctx.moveTo(coords[0].x, pad.top + plotH);
    coords.forEach((c) => ctx.lineTo(c.x, c.y));
    ctx.lineTo(coords[coords.length - 1].x, pad.top + plotH);
    ctx.closePath();
    ctx.fillStyle = areaGrad;
    ctx.fill();
    ctx.restore();

    // Water-depth line
    ctx.save();
    ctx.strokeStyle = telemetryState.mode === 'LIVE' ? '#0891B2' : '#D97706';
    ctx.lineWidth = 2.6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    coords.forEach((c, idx) => {
      if (idx === 0) ctx.moveTo(c.x, c.y);
      else ctx.lineTo(c.x, c.y);
    });
    ctx.stroke();

    // Point markers with crisp live halo on latest reading
    coords.forEach((c, idx) => {
      const isLast = idx === coords.length - 1;
      if (isLast) {
        ctx.beginPath();
        ctx.arc(c.x, c.y, 9, 0, Math.PI * 2);
        ctx.fillStyle =
          telemetryState.mode === 'LIVE'
            ? 'rgba(8, 145, 178, 0.20)'
            : 'rgba(217, 119, 6, 0.20)';
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(c.x, c.y, isLast ? 4.8 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = isLast
        ? '#0A192F'
        : telemetryState.mode === 'LIVE'
        ? '#0891B2'
        : '#D97706';
      ctx.fill();
      if (isLast) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#FFFFFF';
        ctx.stroke();
      }
    });
    ctx.restore();

    // X-axis time labels
    ctx.fillStyle = '#64748B';
    ctx.font = '11px "JetBrains Mono", monospace';
    const labelIndices =
      coords.length <= 2
        ? [0, coords.length - 1]
        : [0, Math.floor((coords.length - 1) / 2), coords.length - 1];
    const seen = new Set();
    labelIndices.forEach((i) => {
      if (seen.has(i) || !coords[i]) return;
      seen.add(i);
      const tStr = new Date(coords[i].pt.timestampMs).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      const textW = ctx.measureText(tStr).width;
      const tx = Math.max(pad.left, Math.min(pad.left + plotW - textW, coords[i].x - textW / 2));
      ctx.fillText(tStr, tx, height - 10);
    });
  }

  /* --------------------------------------------------------------------------
   * 6B. LIVE NYC WEATHER (OPEN-METEO) CONTROLLER
   * -------------------------------------------------------------------------- */
  async function loadLiveNycWeather(showToastOnDone = false) {
    if (!navigator.onLine) {
      weatherState.loading = false;
      weatherState.error = 'Offline — unable to fetch live NYC weather from Open-Meteo.';
      renderNycWeatherPanel();
      return;
    }

    if (weatherState.abortController) {
      weatherState.abortController.abort();
    }
    const controller = new AbortController();
    weatherState.abortController = controller;
    weatherState.loading = true;
    weatherState.error = '';
    renderNycWeatherPanel();

    try {
      const data = await fetchLiveNycWeather({ signal: controller.signal });
      weatherState.data = data;
      weatherState.error = '';
      if (showToastOnDone) {
        showToast(`NYC weather updated (${data.current.condition}, ${data.current.tempF}°F).`, 'NORMAL');
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      weatherState.error =
        err instanceof Error ? err.message : 'Unable to retrieve live NYC weather from Open-Meteo.';
      if (showToastOnDone) {
        showToast(`NYC Weather error: ${weatherState.error}`, 'WARNING');
      }
    } finally {
      if (weatherState.abortController === controller) {
        weatherState.loading = false;
        renderNycWeatherPanel();
        recalculateTelemetryAndRender();
      }
    }
  }

  function renderNycWeatherPanel() {
    const loadingBox = document.getElementById('weatherLoadingBox');
    const errorBox = document.getElementById('weatherErrorBox');
    const contentWrap = document.getElementById('weatherContentWrap');
    const metaLine = document.getElementById('weatherMetaLine');
    const sevStrip = document.getElementById('weatherSeverityStrip');
    const sevLabel = document.getElementById('weatherSeverityLabel');
    const sevDetail = document.getElementById('weatherSeverityDetail');
    const condEl = document.getElementById('weatherCurrentCond');
    const tempEl = document.getElementById('weatherCurrentTemp');
    const rainEl = document.getElementById('weatherCurrentRain');
    const humWindEl = document.getElementById('weatherHumidityWind');
    const next6hEl = document.getElementById('weatherNext6hPrecip');
    const next6hProbEl = document.getElementById('weatherNext6hProb');
    const next24hEl = document.getElementById('weatherNext24hPrecip');
    const peakEl = document.getElementById('weatherPeakHour');
    const hourlyStrip = document.getElementById('weatherHourlyStrip');

    setButtonBusy(document.getElementById('btnRefreshWeather'), 'Refreshing…', weatherState.loading);
    loadingBox?.classList.toggle('hidden', !weatherState.loading || Boolean(weatherState.data));

    if (errorBox) {
      errorBox.classList.toggle('hidden', !weatherState.error);
      errorBox.textContent = weatherState.error ? `Weather fetch failed: ${weatherState.error}` : '';
    }

    const w = weatherState.data;
    if (!w) {
      contentWrap?.classList.toggle('hidden', Boolean(weatherState.error));
      return;
    }

    contentWrap?.classList.remove('hidden');

    if (metaLine) {
      const updatedTime = new Date(w.fetchedAtMs).toLocaleTimeString();
      metaLine.textContent = `Source: ${w.source} · Updated: ${updatedTime}`;
    }

    if (sevStrip && sevLabel && sevDetail) {
      const level = (w.severity?.level || 'LOW').toLowerCase();
      sevStrip.className = `weather-severity-strip weather-sev-${level}`;
      sevLabel.textContent = w.severity.label;
      sevDetail.textContent = w.severity.detail;
    }

    if (condEl) condEl.textContent = w.current.condition;
    if (tempEl) {
      tempEl.textContent =
        w.current.tempF != null && w.current.tempC != null
          ? `${w.current.tempF.toFixed(1)}°F / ${w.current.tempC.toFixed(1)}°C`
          : '--';
    }
    if (rainEl) rainEl.textContent = `${w.current.precipMm.toFixed(2)} mm/h`;
    if (humWindEl) {
      humWindEl.textContent = `Humidity ${w.current.humidityPct ?? '--'}% · Wind ${w.current.windMph ?? '--'} mph`;
    }
    if (next6hEl) {
      next6hEl.textContent = `${w.summary.next6hPrecipMm.toFixed(1)} mm (${w.summary.next6hPrecipIn.toFixed(2)} in)`;
    }
    if (next6hProbEl) {
      next6hProbEl.textContent = `Max rain prob: ${w.summary.maxRainProb6h}%`;
    }
    if (next24hEl) {
      next24hEl.textContent = `${w.summary.next24hPrecipMm.toFixed(1)} mm (${w.summary.next24hPrecipIn.toFixed(2)} in)`;
    }
    if (peakEl) {
      peakEl.textContent = `Peak 6h rate: ${w.summary.peakHourlyRateMm.toFixed(1)} mm/h (${w.summary.peakHourLabel})`;
    }

    if (hourlyStrip) {
      hourlyStrip.innerHTML = w.hourly12h
        .slice(0, 6)
        .map(
          (h) => `
          <div class="weather-hour-cell">
            <div class="weather-hour-time">${escapeHtml(h.hourLabel)}</div>
            <div class="weather-hour-rain">${h.precipMm.toFixed(1)} mm</div>
            <div class="weather-hour-prob">${h.precipProbPct}%</div>
          </div>
        `
        )
        .join('');
    }

    drawWeatherRainChart();
  }

  function drawWeatherRainChart() {
    const canvas = document.getElementById('weatherRainCanvas');
    const w = weatherState.data;
    if (!canvas || !w || !Array.isArray(w.hourly12h) || w.hourly12h.length === 0) return;

    const ctx = canvas.getContext('2d');
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(260, rect.width || 460);
    const height = Math.max(125, rect.height || 145);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const hours = w.hourly12h;
    const pad = { top: 18, right: 12, bottom: 26, left: 38 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const maxMm = Math.max(5.0, ...hours.map((h) => h.precipMm)) * 1.15;

    // Horizontal gridlines
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#64748B';
    ctx.font = '10px "JetBrains Mono", monospace';
    for (let i = 0; i <= 2; i++) {
      const val = (maxMm / 2) * i;
      const y = pad.top + plotH - (val / maxMm) * plotH;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.stroke();
      ctx.fillText(`${val.toFixed(1)}`, 4, y + 3);
    }

    const slotW = plotW / hours.length;
    const barW = Math.max(10, slotW * 0.58);

    hours.forEach((h, i) => {
      const cx = pad.left + slotW * i + slotW / 2;
      const barH = Math.max(h.precipMm > 0 ? 3 : 0, (h.precipMm / maxMm) * plotH);
      const bx = cx - barW / 2;
      const by = pad.top + plotH - barH;

      // Rain intensity color (Cyan light, Amber moderate, Red heavy)
      ctx.fillStyle =
        h.precipMm >= 7.6 ? '#DC2626' : h.precipMm >= 2.5 ? '#D97706' : '#0891B2';
      if (barH > 0) {
        ctx.fillRect(bx, by, barW, barH);
      } else {
        ctx.fillStyle = '#CBD5E1';
        ctx.fillRect(bx, pad.top + plotH - 1.5, barW, 1.5);
      }

      // Probability % above bar when > 0
      if (h.precipProbPct >= 20 && i % 2 === 0) {
        ctx.fillStyle = '#475569';
        ctx.font = '9px "JetBrains Mono", monospace';
        const pTxt = `${h.precipProbPct}%`;
        const pw = ctx.measureText(pTxt).width;
        ctx.fillText(pTxt, cx - pw / 2, Math.max(11, by - 4));
      }

      // Hour label every 2 hours
      if (i % 2 === 0) {
        ctx.fillStyle = '#64748B';
        ctx.font = '10px "JetBrains Mono", monospace';
        const lw = ctx.measureText(h.hourLabel).width;
        ctx.fillText(h.hourLabel, cx - lw / 2, height - 8);
      }
    });
  }

  /* --------------------------------------------------------------------------
   * 6C. OPTIONAL SERVER-SIDE AI FLOODGUARD ASSISTANT CONTROLLER
   * -------------------------------------------------------------------------- */
  function getAssistantApiBase() {
    const raw =
      typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_ASSISTANT_API_URL
        ? String(import.meta.env.VITE_ASSISTANT_API_URL).trim()
        : '';
    if (!raw) return '';
    const cleaned = raw.replace(/\/+$/, '');
    return /^https?:\/\//i.test(cleaned) ? cleaned : '';
  }

  function buildAssistantEndpoint(pathname) {
    const base = getAssistantApiBase();
    return base ? `${base}${pathname}` : pathname;
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function checkAiAssistantStatus() {
    aiAssistantState.statusChecked = false;
    aiAssistantState.statusState = 'connecting';
    aiAssistantState.statusLabel = 'Connecting';
    renderAiAssistantPanel();

    const apiBase = getAssistantApiBase();
    const statusUrl = buildAssistantEndpoint('/api/assistant/status');

    try {
      const resp = await fetchWithTimeout(
        statusUrl,
        { headers: { Accept: 'application/json' } },
        20000
      );
      aiAssistantState.statusChecked = true;
      const contentType = resp.headers.get('content-type') || '';
      if (!resp.ok || !contentType.includes('application/json')) {
        aiAssistantState.available = false;
        aiAssistantState.statusState = 'offline';
        if (!apiBase) {
          aiAssistantState.statusLabel = 'Offline';
          aiAssistantState.statusNote =
            'GitHub Pages serves static files only. Deploy the Node/Express backend on Render and set the VITE_ASSISTANT_API_URL repository variable to enable the AI Assistant. Rule-based FloodGuard Risk Intelligence remains fully active.';
        } else if (resp.status === 403) {
          aiAssistantState.statusLabel = 'Offline (CORS)';
          aiAssistantState.statusNote =
            'The configured AI backend rejected this site origin. Verify ALLOWED_ORIGINS on your Render backend includes your GitHub Pages origin (e.g. https://kdawtech.github.io).';
        } else {
          aiAssistantState.statusLabel = 'Offline';
          aiAssistantState.statusNote = `The configured AI backend returned HTTP ${resp.status}. Rule-based FloodGuard Risk Intelligence remains fully active.`;
        }
        renderAiAssistantPanel();
        return;
      }
      const data = await resp.json();
      aiAssistantState.available = Boolean(data.available);
      aiAssistantState.statusState = data.available ? 'ready' : 'offline';
      aiAssistantState.statusLabel = data.available ? 'Gemini Ready' : 'Offline';
      aiAssistantState.statusNote = data.note || '';
    } catch (err) {
      aiAssistantState.statusChecked = true;
      aiAssistantState.available = false;
      const isTimeout = err && err.name === 'AbortError';
      aiAssistantState.statusState = isTimeout && apiBase ? 'connecting' : 'offline';
      aiAssistantState.statusLabel = isTimeout && apiBase ? 'Connecting' : 'Offline';
      aiAssistantState.statusNote = apiBase
        ? isTimeout
          ? 'The Render backend is waking up from standby (free-tier cold start). You can try asking a question in a few seconds.'
          : 'Unable to reach the configured AI backend URL. Verify the Render service is running and ALLOWED_ORIGINS permits this site.'
        : 'Unable to reach /api/assistant. Rule-based FloodGuard Risk Intelligence remains fully active.';
    }
    renderAiAssistantPanel();
  }

  function buildAssistantContextSnapshot() {
    const analysis = telemetryState.latestAnalysis;
    const intel = telemetryState.latestRiskIntel;
    const settings = getEffectiveThresholds();
    const w = weatherState.data;
    const cal = telemetryState.calibration;

    return {
      sourceMode:
        telemetryState.mode === 'LIVE'
          ? 'LIVE Arduino GIGA R1 WiFi (USB Serial)'
          : telemetryState.mode === 'SIMULATED'
          ? 'DEMO MODE (Simulated)'
          : 'UNAVAILABLE (No Sensor Connected)',
      streamHealth: telemetryState.streamHealth || 'IDLE',
      status: analysis?.status || 'UNAVAILABLE',
      statusSource: analysis?.statusSource || '',
      depthCm: analysis?.filteredDepthCm ?? null,
      distanceCm: analysis?.filteredDistanceCm ?? analysis?.rawDistanceCm ?? null,
      baselineCm: cal?.baselineCm ?? analysis?.mountHeightCm ?? null,
      calibrationStatus: cal?.status || 'UNSET',
      warningThresholdCm: settings?.warnThresholdCm ?? null,
      criticalThresholdCm: settings?.critThresholdCm ?? null,
      trend: analysis?.trendLabel || 'Unavailable',
      rateCmPerMin: analysis?.rateCmPerMin ?? null,
      etaWarningLabel: analysis?.etaWarning?.label || 'Insufficient Data',
      etaCriticalLabel: analysis?.etaCritical?.label || 'Insufficient Data',
      predictionConfidence: analysis?.predictionConfidenceLabel || 'Insufficient Data',
      sensorQuality: analysis?.sensorQualityLabel || 'Unavailable',
      suspiciousReading: Boolean(analysis?.suspiciousReading),
      suspiciousReason: analysis?.suspiciousReason || '',
      riskLevel: intel?.riskLabel || 'Awaiting Data',
      trajectoryLabel: intel?.trajectoryLabel || '',
      rapidRiseDetected: Boolean(intel?.rapidRiseDetected),
      blockedDrainSuspected: Boolean(intel?.blockedDrainSuspected),
      riskDrivers: Array.isArray(intel?.drivers) ? intel.drivers.slice(0, 5) : [],
      weatherSummary: w
        ? `${w.current.condition}, ${w.current.tempF != null ? `${w.current.tempF}°F` : '--'}, current rain ${w.current.precipMm} mm/h, next 6h ${w.summary.next6hPrecipMm} mm (peak ${w.summary.peakRate6hMm ?? 0} mm/h, max ${w.summary.maxRainProb6h}% prob), ${w.severity.label}`
        : 'Open-Meteo weather unavailable',
      weatherUpdatedAt: w?.fetchedAt || ''
    };
  }

  async function askFloodGuardAssistant(rawQuestion) {
    const question = String(rawQuestion || '').trim();
    if (!question || aiAssistantState.loading) return;

    const apiBase = getAssistantApiBase();
    const endpoint = buildAssistantEndpoint('/api/assistant');

    aiAssistantState.loading = true;
    aiAssistantState.pendingQuestion = question;
    aiAssistantState.pendingAt = new Date().toISOString();
    aiAssistantState.statusState = 'processing';
    aiAssistantState.statusLabel = 'Processing';
    aiAssistantState.error = '';
    renderAiAssistantPanel();

    try {
      const resp = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            question,
            context: buildAssistantContextSnapshot()
          })
        },
        45000
      );

      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error(
          apiBase
            ? `Configured AI backend (${apiBase}) returned a non-JSON response (HTTP ${resp.status}). Verify the Render service URL and deployment status.`
            : 'AI Assistant backend is not configured for this static site. Deploy the backend on Render and set VITE_ASSISTANT_API_URL in GitHub Actions Variables.'
        );
      }

      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || `AI Assistant returned HTTP ${resp.status}.`);
      }

      aiAssistantState.messages.push({
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        question,
        askedAt: aiAssistantState.pendingAt,
        answer: data.answer,
        model: data.model || 'gemini-4-hydrogen',
        generatedAt: data.generatedAt || new Date().toISOString()
      });
      if (aiAssistantState.messages.length > 20) {
        aiAssistantState.messages = aiAssistantState.messages.slice(-20);
      }
      aiAssistantState.available = true;
      aiAssistantState.statusState = 'ready';
      aiAssistantState.statusLabel = 'Gemini Ready';
      aiAssistantState.statusNote = '';
    } catch (err) {
      if (err && err.name === 'AbortError') {
        aiAssistantState.error =
          'The request timed out while waiting for the AI backend (Render free instances can take ~30 seconds to wake up). Please try again.';
        aiAssistantState.statusState = 'offline';
        aiAssistantState.statusLabel = 'Offline';
      } else {
        aiAssistantState.error =
          err instanceof Error ? err.message : 'Unable to reach AI FloodGuard Assistant.';
        aiAssistantState.statusState = aiAssistantState.available ? 'ready' : 'offline';
        aiAssistantState.statusLabel = aiAssistantState.available ? 'Gemini Ready' : 'Offline';
      }
    } finally {
      aiAssistantState.loading = false;
      aiAssistantState.pendingQuestion = '';
      aiAssistantState.pendingAt = '';
      renderAiAssistantPanel();
    }
  }

  function formatChatTime(isoString) {
    try {
      return new Date(isoString || Date.now()).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return '';
    }
  }

  function renderAiAssistantPanel() {
    const panel = document.getElementById('aiAssistantPanel');
    const statusTag = document.getElementById('aiStatusTag');
    const statusTagText = document.getElementById('aiStatusTagText');
    const errEl = document.getElementById('aiErrorNotice');
    const box = document.getElementById('aiMessagesBox');
    const askBtn = document.getElementById('btnAskAssistant');
    const clearBtn = document.getElementById('btnClearAssistant');
    const expandBtn = document.getElementById('btnExpandAssistant');
    const expandLabel = document.getElementById('btnExpandAssistantLabel');

    if (panel) {
      panel.classList.toggle('ai-assistant-expanded', aiAssistantState.expanded);
    }
    if (expandBtn) {
      expandBtn.setAttribute('aria-expanded', aiAssistantState.expanded ? 'true' : 'false');
    }
    if (expandLabel) {
      expandLabel.textContent = aiAssistantState.expanded ? 'Collapse' : 'Expand';
    }

    const activeState = aiAssistantState.loading ? 'processing' : aiAssistantState.statusState;
    const activeLabel = aiAssistantState.loading ? 'Processing' : aiAssistantState.statusLabel;

    if (statusTag) {
      statusTag.className = `ai-status-badge ai-status-${activeState}`;
    }
    if (statusTagText) {
      statusTagText.textContent = activeLabel;
    } else if (statusTag) {
      statusTag.textContent = activeLabel;
    }

    if (askBtn) {
      askBtn.disabled = aiAssistantState.loading;
      const span = askBtn.querySelector('span');
      if (span) {
        span.textContent = aiAssistantState.loading ? 'Processing…' : 'Ask';
      } else {
        askBtn.textContent = aiAssistantState.loading ? 'Processing…' : 'Ask';
      }
    }
    if (clearBtn) {
      clearBtn.disabled = aiAssistantState.loading || aiAssistantState.messages.length === 0;
    }

    document.querySelectorAll('.ai-prompt-btn').forEach((b) => {
      b.disabled = aiAssistantState.loading;
    });

    if (errEl) {
      const showMsg =
        aiAssistantState.error ||
        (!aiAssistantState.available && aiAssistantState.statusChecked ? aiAssistantState.statusNote : '');
      errEl.classList.toggle('hidden', !showMsg);
      errEl.textContent = showMsg;
    }

    if (!box) return;

    const geminiSvg = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"><path d="M12 2C12.7 7.1 16.9 11.3 22 12C16.9 12.7 12.7 16.9 12 22C11.3 16.9 7.1 12.7 2 12C7.1 11.3 11.3 7.1 12 2Z" fill="currentColor"/></svg>`;

    if (aiAssistantState.messages.length === 0 && !aiAssistantState.loading) {
      box.innerHTML = `
        <div class="ai-empty-state">
          <div class="ai-empty-icon" aria-hidden="true">${geminiSvg}</div>
          <p class="ai-empty-title">Ready to analyze your live flood data</p>
          <p class="ai-empty-desc">Choose a suggested question above or ask about water depth, blocked storm drains, rainfall outlook, or resident safety guidance.</p>
        </div>
      `;
      return;
    }

    const turnsHtml = aiAssistantState.messages
      .map((m) => {
        const renderedAnswer = renderAssistantMarkdown(m.answer);
        const isCopied = aiAssistantState.copiedId === m.id;
        return `
          <div class="chat-turn" data-msg-id="${escapeHtml(m.id)}">
            <div class="chat-row chat-row-user">
              <div class="chat-bubble chat-bubble-user">
                <div class="chat-bubble-head">
                  <span class="chat-sender">You</span>
                  <span class="chat-time">${escapeHtml(formatChatTime(m.askedAt || m.generatedAt))}</span>
                </div>
                <div class="chat-user-text">${escapeHtml(m.question)}</div>
              </div>
            </div>

            <div class="chat-row chat-row-assistant">
              <div class="chat-avatar chat-avatar-gemini" aria-hidden="true">${geminiSvg}</div>
              <div class="chat-bubble chat-bubble-assistant">
                <div class="chat-bubble-head">
                  <span class="chat-sender">FloodGuard Gemini Assistant</span>
                  <div class="chat-bubble-tools">
                    <span class="chat-time">${escapeHtml(formatChatTime(m.generatedAt))}</span>
                    <button type="button" class="chat-copy-btn${isCopied ? ' is-copied' : ''}" data-copy-msg="${escapeHtml(m.id)}" title="Copy response text">
                      <i data-lucide="${isCopied ? 'check' : 'copy'}" class="ui-icon ui-icon-xs" aria-hidden="true"></i>
                      <span>${isCopied ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                </div>
                <div class="chat-markdown-body">${renderedAnswer}</div>
                <div class="chat-bubble-foot">
                  <span>Informational Only</span>
                  <span aria-hidden="true">&middot;</span>
                  <span>Server-Side Gemini (${escapeHtml(m.model)})</span>
                </div>
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    const pendingHtml = aiAssistantState.loading
      ? `
        <div class="chat-turn chat-turn-pending">
          <div class="chat-row chat-row-user">
            <div class="chat-bubble chat-bubble-user">
              <div class="chat-bubble-head">
                <span class="chat-sender">You</span>
                <span class="chat-time">${escapeHtml(formatChatTime(aiAssistantState.pendingAt))}</span>
              </div>
              <div class="chat-user-text">${escapeHtml(aiAssistantState.pendingQuestion)}</div>
            </div>
          </div>
          <div class="chat-row chat-row-assistant">
            <div class="chat-avatar chat-avatar-gemini" aria-hidden="true">${geminiSvg}</div>
            <div class="chat-bubble chat-bubble-assistant chat-bubble-typing">
              <div class="typing-indicator" role="status" aria-label="Gemini is analyzing live flood telemetry">
                <span class="typing-dot"></span>
                <span class="typing-dot"></span>
                <span class="typing-dot"></span>
                <span class="typing-label">Analyzing live telemetry &amp; NYC weather&hellip;</span>
              </div>
            </div>
          </div>
        </div>
      `
      : '';

    box.innerHTML = turnsHtml + pendingHtml;
    refreshLucideIcons();
    box.scrollTop = box.scrollHeight;
  }

  /* --------------------------------------------------------------------------
   * 6D. FULLSCREEN PRESENTATION MODE CONTROLLER (UI-ONLY EMPHASIS)
   * -------------------------------------------------------------------------- */
  function updatePresentationClock() {
    const el = document.getElementById('presClockText');
    if (el) {
      el.textContent = new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    }
  }

  function setPresentationMode(enable) {
    const next = Boolean(enable);
    presentationState.active = next;
    document.body.classList.toggle('presentation-mode', next);
    const bar = document.getElementById('presentationTopBar');
    if (bar) bar.classList.toggle('hidden', !next);

    if (next) {
      updatePresentationClock();
      if (presentationState.clockTimerId) clearInterval(presentationState.clockTimerId);
      presentationState.clockTimerId = setInterval(updatePresentationClock, 1000);
      if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {
          // Graceful fallback to full-viewport CSS mode inside sandboxed iframes
        });
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      if (presentationState.clockTimerId) {
        clearInterval(presentationState.clockTimerId);
        presentationState.clockTimerId = null;
      }
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
    }

    // Re-scale charts cleanly after layout change
    setTimeout(() => {
      drawWaterHistoryChart();
      drawWeatherRainChart();
      refreshLucideIcons();
    }, 80);
  }

  /* --------------------------------------------------------------------------
   * 7. EXISTING SUPABASE DEMO TABLES CHECK (READ-ONLY, PRESERVED)
   * -------------------------------------------------------------------------- */
  async function checkExistingSupabaseDemoTables() {
    if (!navigator.onLine) {
      supabaseDemoState.status = 'offline';
      supabaseDemoState.summaryText = 'Offline';
      renderDashboard();
      return;
    }
    try {
      const res = await fetchSupabaseFloodData();
      supabaseDemoState.status = res.status;
      if (res.status === 'connected') {
        const first = res.sensors[0];
        if (first && first.waterLevelIn != null) {
          supabaseDemoState.summaryText = `Connected (${first.name}: ${first.waterLevelIn.toFixed(1)} in saved demo row)`;
        } else {
          supabaseDemoState.summaryText = `Connected (${res.sensors.length} sensor, ${res.readings.length} readings)`;
        }
      } else {
        supabaseDemoState.summaryText = res.errorMessage || 'Unavailable';
      }
    } catch {
      supabaseDemoState.summaryText = 'Connection check failed';
    }
    renderDashboard();
  }

  /* --------------------------------------------------------------------------
   * 8. NYC FLOODNET HISTORICAL DATA & PER-USER SUPABASE BOOKMARKS (PRESERVED)
   * -------------------------------------------------------------------------- */
  function populateRealDataFilterOptions() {
    const boroughSel = document.getElementById('realDataBoroughFilter');
    const sensorSel = document.getElementById('realDataSensorFilter');

    if (boroughSel) {
      const prevBorough = realFloodState.borough || 'ALL';
      const boroughOptions =
        realFloodState.boroughs.length > 0
          ? realFloodState.boroughs
          : ['Bronx', 'Brooklyn', 'Manhattan', 'Queens', 'Staten Island'];
      boroughSel.innerHTML =
        `<option value="ALL">All Boroughs</option>` +
        boroughOptions.map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
      boroughSel.value = prevBorough;
    }

    if (sensorSel) {
      const activeBorough = realFloodState.borough || 'ALL';
      const prevSensor = realFloodState.sensorId || 'ALL';
      const filteredSensors = realFloodState.sensorsList.filter(
        (s) => activeBorough === 'ALL' || s.borough === activeBorough
      );
      sensorSel.innerHTML =
        `<option value="ALL">All FloodNet Sensors (${filteredSensors.length})</option>` +
        filteredSensors
          .map((s) => {
            const locHint = s.streetName ? ` — ${s.streetName}` : s.borough ? ` (${s.borough})` : '';
            return `<option value="${escapeHtml(s.sensorId)}">${escapeHtml(s.sensorName)}${escapeHtml(locHint)}</option>`;
          })
          .join('');
      if (filteredSensors.some((s) => s.sensorId === prevSensor)) {
        sensorSel.value = prevSensor;
      } else {
        realFloodState.sensorId = 'ALL';
        sensorSel.value = 'ALL';
      }
    }
  }

  function formatRealFloodDate(isoString) {
    if (!isoString) return '—';
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return String(isoString);
    return d.toLocaleString([], {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function formatDurationMinutes(mins) {
    if (mins == null || Number.isNaN(mins)) return '—';
    const num = Number(mins);
    const rounded = Number.isInteger(num) ? String(num) : num.toFixed(2).replace(/\.?0+$/, '');
    if (num >= 60) {
      const hrs = Math.floor(num / 60);
      const rem = Math.round(num % 60);
      return `${rounded} mins (${hrs}h ${rem}m)`;
    }
    return `${rounded} mins`;
  }

  function renderRealFloodDataView() {
    const loadingBox = document.getElementById('realDataLoadingBox');
    const errorBox = document.getElementById('realDataErrorBox');
    const errorText = document.getElementById('realDataErrorText');
    const emptyBox = document.getElementById('realDataEmptyBox');
    const tableWrap = document.getElementById('realDataTableWrap');
    const tbody = document.getElementById('realDataTableBody');
    const syncMeta = document.getElementById('realDataSyncMeta');
    const apiUpdatedMeta = document.getElementById('realDataApiUpdatedMeta');
    const latestEventMeta = document.getElementById('realDataLatestEventMeta');

    const kpiTotal = document.getElementById('realDataKpiTotal');
    const kpiTotalMeta = document.getElementById('realDataKpiTotalMeta');
    const kpiSensors = document.getElementById('realDataKpiSensors');
    const kpiPeakDepth = document.getElementById('realDataKpiPeakDepth');
    const kpiPeakSensor = document.getElementById('realDataKpiPeakSensor');
    const kpiRange = document.getElementById('realDataKpiRange');
    const kpiPageMeta = document.getElementById('realDataKpiPageMeta');
    const activeSummary = document.getElementById('realDataActiveSummary');
    const offsetInfo = document.getElementById('realDataOffsetInfo');
    const pageIndicator = document.getElementById('realDataPageIndicator');
    const jumpInput = document.getElementById('realDataJumpPageInput');

    if (!tbody) return;

    if (loadingBox) loadingBox.classList.toggle('hidden', !realFloodState.loading);
    if (errorBox) errorBox.classList.toggle('hidden', !realFloodState.error || realFloodState.loading);
    if (errorText && realFloodState.error) errorText.textContent = realFloodState.error;

    setButtonBusy(document.getElementById('btnRefreshRealData'), 'Refreshing…', realFloodState.loading);

    if (apiUpdatedMeta) {
      apiUpdatedMeta.textContent = realFloodState.apiUpdatedAtIso
        ? `API Dataset Updated: ${formatRealFloodDate(realFloodState.apiUpdatedAtIso)}`
        : 'API Dataset Updated: Loading…';
    }
    if (latestEventMeta) {
      latestEventMeta.textContent = realFloodState.latestRecordedEventIso
        ? `Latest Recorded Event: ${formatRealFloodDate(realFloodState.latestRecordedEventIso)}`
        : 'Latest Recorded Event: —';
    }
    if (syncMeta) {
      if (realFloodState.loading) {
        syncMeta.textContent = 'Fetching…';
      } else if (realFloodState.lastFetchedMs) {
        const lat = realFloodState.latencyMs != null ? ` (${realFloodState.latencyMs} ms)` : '';
        syncMeta.textContent = `Fetched ${new Date(realFloodState.lastFetchedMs).toLocaleTimeString()}${lat}`;
      } else if (realFloodState.error) {
        syncMeta.textContent = 'Request failed';
      }
    }

    if (kpiTotal) {
      kpiTotal.textContent = realFloodState.initialized ? realFloodState.totalCount.toLocaleString() : '—';
    }
    if (kpiTotalMeta) {
      const hasFilters =
        realFloodState.search ||
        realFloodState.borough !== 'ALL' ||
        realFloodState.sensorId !== 'ALL' ||
        realFloodState.startDate ||
        realFloodState.endDate;
      kpiTotalMeta.textContent = hasFilters ? 'Filtered historical records' : 'Total historical FloodNet records';
    }
    if (kpiSensors) {
      kpiSensors.textContent = realFloodState.metadataLoaded
        ? realFloodState.sensorsList.length.toLocaleString()
        : '—';
    }

    const rowsWithDepth = realFloodState.records.filter((r) => typeof r.maxDepthInches === 'number');
    if (rowsWithDepth.length > 0) {
      const peakRow = rowsWithDepth.reduce(
        (best, cur) => (cur.maxDepthInches > best.maxDepthInches ? cur : best),
        rowsWithDepth[0]
      );
      if (kpiPeakDepth) kpiPeakDepth.textContent = `${peakRow.maxDepthInches.toFixed(2)} in`;
      if (kpiPeakSensor) kpiPeakSensor.textContent = `${peakRow.sensorName} (${peakRow.borough || 'NYC'})`;
    } else {
      if (kpiPeakDepth) kpiPeakDepth.textContent = '—';
      if (kpiPeakSensor) kpiPeakSensor.textContent = 'No depth records on page';
    }

    const total = realFloodState.totalCount;
    const offset = (realFloodState.page - 1) * realFloodState.pageSize;
    const startIdx = total === 0 ? 0 : offset + 1;
    const endIdx = Math.min(total, offset + realFloodState.records.length);

    if (kpiRange) {
      kpiRange.textContent = total > 0 ? `${startIdx.toLocaleString()}–${endIdx.toLocaleString()}` : '0';
    }
    if (kpiPageMeta) {
      kpiPageMeta.textContent =
        total > 0
          ? `Page ${realFloodState.page} of ${realFloodState.totalPages.toLocaleString()} (${total.toLocaleString()} total)`
          : 'No matching pages';
    }

    const hasNoResults =
      !realFloodState.loading &&
      !realFloodState.error &&
      realFloodState.initialized &&
      realFloodState.records.length === 0;
    if (emptyBox) emptyBox.classList.toggle('hidden', !hasNoResults);
    if (tableWrap) {
      tableWrap.classList.toggle(
        'hidden',
        (realFloodState.error && realFloodState.records.length === 0) || hasNoResults
      );
    }

    if (activeSummary) {
      const parts = [];
      if (realFloodState.borough !== 'ALL') parts.push(realFloodState.borough);
      if (realFloodState.search) parts.push(`Search: "${realFloodState.search}"`);
      if (realFloodState.startDate || realFloodState.endDate) {
        parts.push(`${realFloodState.startDate || 'Start'} to ${realFloodState.endDate || 'Latest'}`);
      }
      activeSummary.textContent =
        parts.length > 0
          ? `Historical Flood Events (${parts.join(' · ')})`
          : 'Historical Flood Events (Newest Recorded First)';
    }

    if (offsetInfo) {
      offsetInfo.textContent =
        total > 0
          ? `Showing ${startIdx.toLocaleString()}–${endIdx.toLocaleString()} of ${total.toLocaleString()} · Offset ${offset.toLocaleString()}`
          : 'Offset: 0';
    }

    const savedKeySet = new Set(savedEventsState.events.map((ev) => ev.eventKey));
    const authed = isAuthenticated();

    if (realFloodState.records.length > 0) {
      tbody.innerHTML = realFloodState.records
        .map((rec, idx) => {
          const depthNum = rec.maxDepthInches;
          const depthClass =
            depthNum != null && depthNum >= 12
              ? 'depth-val-crit'
              : depthNum != null && depthNum >= 4
              ? 'depth-val-warn'
              : 'depth-val-normal';

          const depthText = depthNum != null ? `${depthNum.toFixed(2)} in` : '—';
          const depthSub = depthNum != null ? `${(depthNum * 2.54).toFixed(1)} cm` : '';
          const locationStreet = rec.streetName || 'Location metadata unavailable';
          const metaLine = [
            rec.borough || 'NYC',
            rec.zipcode ? `ZIP ${rec.zipcode}` : '',
            rec.tidallyInfluenced && rec.tidallyInfluenced.toLowerCase() === 'yes' ? 'Tidally Influenced' : ''
          ]
            .filter(Boolean)
            .join(' · ');

          const eventKey = buildFloodEventKey(rec.sensorId, rec.floodStartTime);
          const isSaved = savedKeySet.has(eventKey);
          const isSaving = savedEventsState.savingKeys.has(eventKey);

          let actionHtml;
          if (!authed) {
            actionHtml = `<button type="button" class="btn btn-sm btn-outline js-save-flood-event" data-index="${idx}">Save Event</button>`;
          } else if (isSaved) {
            actionHtml = `<button type="button" class="btn btn-sm btn-saved" disabled>Saved ✓</button>`;
          } else if (isSaving) {
            actionHtml = `<button type="button" class="btn btn-sm btn-cyan" disabled>Saving…</button>`;
          } else {
            actionHtml = `<button type="button" class="btn btn-sm btn-cyan js-save-flood-event" data-index="${idx}">Save Event</button>`;
          }

          return `
            <tr>
              <td>
                <div style="font-weight:700;color:var(--navy-900);">${escapeHtml(rec.sensorName)}</div>
                <div class="mono-subtext" style="font-size:0.74rem;">${escapeHtml(rec.sensorId)}</div>
              </td>
              <td>
                <div style="font-weight:600;color:var(--gray-800);">${escapeHtml(locationStreet)}</div>
                <div style="font-size:0.76rem;color:var(--gray-500);">${escapeHtml(metaLine)}</div>
              </td>
              <td>
                <div class="mono-text" style="font-size:0.8rem;font-weight:600;color:var(--navy-900);">
                  ${escapeHtml(formatRealFloodDate(rec.floodStartTime))}
                </div>
                ${rec.floodEndTime ? `<div style="font-size:0.74rem;color:var(--gray-500);">Ended: ${escapeHtml(formatRealFloodDate(rec.floodEndTime))}</div>` : ''}
              </td>
              <td class="num-col">
                <div class="${depthClass}">${escapeHtml(depthText)}</div>
                ${depthSub ? `<div style="font-size:0.74rem;color:var(--gray-500);">${escapeHtml(depthSub)}</div>` : ''}
              </td>
              <td class="num-col">
                <div style="font-weight:600;color:var(--navy-900);">${escapeHtml(formatDurationMinutes(rec.durationMins))}</div>
              </td>
              <td>${actionHtml}</td>
            </tr>
          `;
        })
        .join('');
    } else if (!realFloodState.loading) {
      tbody.innerHTML = '';
    }

    const curPage = realFloodState.page;
    const maxPage = Math.max(1, realFloodState.totalPages);
    if (pageIndicator) {
      pageIndicator.textContent = `Page ${curPage.toLocaleString()} of ${maxPage.toLocaleString()}`;
    }
    if (jumpInput) {
      jumpInput.max = String(maxPage);
      jumpInput.value = String(curPage);
    }

    const firstBtn = document.getElementById('btnRealPageFirst');
    const prevBtn = document.getElementById('btnRealPagePrev');
    const nextBtn = document.getElementById('btnRealPageNext');
    const lastBtn = document.getElementById('btnRealPageLast');
    const jump1000Btn = document.getElementById('btnJumpPast1000');

    if (firstBtn) firstBtn.disabled = realFloodState.loading || curPage <= 1;
    if (prevBtn) prevBtn.disabled = realFloodState.loading || curPage <= 1;
    if (nextBtn) nextBtn.disabled = realFloodState.loading || curPage >= maxPage;
    if (lastBtn) lastBtn.disabled = realFloodState.loading || curPage >= maxPage;
    if (jump1000Btn) {
      const target1000Page = Math.floor(1000 / realFloodState.pageSize) + 1;
      jump1000Btn.disabled = realFloodState.loading || total <= 1000 || curPage === target1000Page;
    }

    renderSavedFloodEventsPanel();
  }

  function renderSavedFloodEventsPanel() {
    const body = document.getElementById('savedEventsPanelBody');
    const countBadge = document.getElementById('savedEventsCountBadge');
    if (!body) return;

    const authed = isAuthenticated();
    if (countBadge) {
      if (!authed) {
        countBadge.className = 'status-tag tag-neutral';
        countBadge.textContent = 'Sign In Required';
      } else if (savedEventsState.status === 'migration_required') {
        countBadge.className = 'status-tag tag-warn';
        countBadge.textContent = 'SQL Migration Needed';
      } else {
        countBadge.className = 'status-tag tag-normal';
        countBadge.textContent = `${savedEventsState.events.length} Saved`;
      }
    }

    if (!authed) {
      body.innerHTML = `
        <div class="card-header-row" style="align-items:center;">
          <p class="card-subtitle">Sign in with your Supabase account to save and manage personal historical flood event bookmarks.</p>
          <button type="button" class="btn btn-sm btn-cyan js-saved-signin-cta">Sign In to Save Events</button>
        </div>
      `;
      return;
    }

    if (savedEventsState.loading && savedEventsState.events.length === 0) {
      body.innerHTML = `<p class="card-subtitle">Loading your saved flood events…</p>`;
      return;
    }

    if (savedEventsState.status === 'migration_required') {
      body.innerHTML = `<div class="inline-notice notice-warn" style="margin-bottom:0;"><strong>Database Setup Required:</strong> ${escapeHtml(savedEventsState.errorMessage)}</div>`;
      return;
    }

    if (savedEventsState.status === 'error') {
      body.innerHTML = `<div class="inline-notice notice-error" style="margin-bottom:0;"><strong>Unable to load bookmarks:</strong> ${escapeHtml(savedEventsState.errorMessage)}</div>`;
      return;
    }

    if (savedEventsState.events.length === 0) {
      body.innerHTML = `<p class="card-subtitle">You have no saved flood events yet. Click <strong>Save Event</strong> on any historical row above to bookmark it.</p>`;
      return;
    }

    body.innerHTML = `
      <div class="table-responsive">
        <table class="data-table">
          <thead>
            <tr>
              <th>Sensor &amp; Location</th>
              <th>Flood Start Date</th>
              <th class="num-col">Max Depth</th>
              <th class="num-col">Duration</th>
              <th>Saved At</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${savedEventsState.events
              .map((ev) => {
                const locText = [ev.borough, ev.streetName, ev.zipcode ? `ZIP ${ev.zipcode}` : '']
                  .filter(Boolean)
                  .join(' · ');
                const depthText = ev.maxDepthInches != null ? `${Number(ev.maxDepthInches).toFixed(2)} in` : '—';
                const savedAt = ev.createdAt ? new Date(ev.createdAt).toLocaleString() : '—';
                return `
                  <tr>
                    <td>
                      <div style="font-weight:700;color:var(--navy-900);">${escapeHtml(ev.sensorName)}</div>
                      <div style="font-size:0.76rem;color:var(--gray-500);">${escapeHtml(locText || ev.sensorId)}</div>
                    </td>
                    <td class="mono-text" style="font-size:0.78rem;">${escapeHtml(formatRealFloodDate(ev.floodStartTime))}</td>
                    <td class="num-col"><strong>${escapeHtml(depthText)}</strong></td>
                    <td class="num-col">${escapeHtml(formatDurationMinutes(ev.durationMins))}</td>
                    <td class="mono-subtext" style="font-size:0.75rem;">${escapeHtml(savedAt)}</td>
                    <td>
                      <button type="button" class="btn btn-sm btn-danger js-delete-saved-event" data-saved-id="${escapeHtml(ev.id)}">Remove</button>
                    </td>
                  </tr>
                `;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  async function loadSavedFloodEvents(showToastOnError) {
    if (!isAuthenticated()) {
      savedEventsState.status = 'unauthenticated';
      savedEventsState.events = [];
      savedEventsState.errorMessage = '';
      renderRealFloodDataView();
      return;
    }

    savedEventsState.loading = true;
    renderSavedFloodEventsPanel();

    try {
      const res = await fetchSavedFloodEvents();
      savedEventsState.status = res.status;
      savedEventsState.events = res.events || [];
      savedEventsState.errorMessage = res.errorMessage || '';
      if (showToastOnError && res.status !== 'ok') {
        showToast(res.errorMessage || 'Could not load saved flood events.', 'WARNING');
      }
    } catch (err) {
      savedEventsState.status = 'error';
      savedEventsState.errorMessage =
        err instanceof Error ? err.message : 'Unable to fetch saved flood events.';
    } finally {
      savedEventsState.loading = false;
      renderRealFloodDataView();
    }
  }

  async function handleSaveFloodEvent(recordIndex) {
    const rec = realFloodState.records[recordIndex];
    if (!rec) return;

    if (!isAuthenticated()) {
      authState.pendingProtectedView = 'realdata';
      setAuthMode('login', false);
      showAuthFeedback('Sign in to bookmark historical flood events to your account.', 'info');
      applyActiveViewDOM('home');
      document.getElementById('homeAuthCard')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    const eventKey = buildFloodEventKey(rec.sensorId, rec.floodStartTime);
    if (savedEventsState.events.some((ev) => ev.eventKey === eventKey)) {
      showToast('This flood event is already in your bookmarks.', 'NORMAL');
      return;
    }

    savedEventsState.savingKeys.add(eventKey);
    renderRealFloodDataView();

    try {
      const res = await saveFloodEventBookmark(rec);
      if (res.status === 'ok' && res.event) {
        savedEventsState.status = 'ok';
        savedEventsState.errorMessage = '';
        savedEventsState.events.unshift(res.event);
        showToast(`Saved "${rec.sensorName}" flood event to your bookmarks.`, 'NORMAL');
      } else if (res.status === 'duplicate') {
        await loadSavedFloodEvents(false);
        showToast(res.errorMessage, 'WARNING');
      } else {
        showToast(res.errorMessage || 'Unable to save flood event.', 'CRITICAL');
      }
    } finally {
      savedEventsState.savingKeys.delete(eventKey);
      renderRealFloodDataView();
    }
  }

  async function handleDeleteSavedEvent(savedId) {
    if (!isAuthenticated()) return;
    const numericId = Number(savedId);
    const res = await deleteSavedFloodEvent(numericId);
    if (res.status === 'ok') {
      savedEventsState.events = savedEventsState.events.filter((ev) => Number(ev.id) !== numericId);
      renderRealFloodDataView();
      showToast('Removed flood event bookmark.', 'NORMAL');
    } else {
      showToast(res.errorMessage || 'Unable to remove bookmark.', 'CRITICAL');
    }
  }

  async function loadRealFloodData(options = {}) {
    const { refreshMetadata = false, showToastOnDone = false } = options;

    if (!navigator.onLine) {
      realFloodState.loading = false;
      realFloodState.error = 'No internet connection detected. Reconnect to fetch NYC Open Data records.';
      renderRealFloodDataView();
      return;
    }

    if (realFloodState.abortController) {
      realFloodState.abortController.abort();
    }
    const controller = new AbortController();
    realFloodState.abortController = controller;
    realFloodState.loading = true;
    realFloodState.error = '';
    renderRealFloodDataView();

    try {
      if (!realFloodState.metadataLoaded || refreshMetadata) {
        const metaResult = await fetchFloodNetSensorMetadata({ signal: controller.signal });
        realFloodState.sensorsList = metaResult.sensorsList;
        realFloodState.sensorById = metaResult.sensorById;
        realFloodState.boroughs = metaResult.boroughs;
        if (metaResult.apiUpdatedAtIso) realFloodState.apiUpdatedAtIso = metaResult.apiUpdatedAtIso;
        if (metaResult.latestRecordedEventIso) {
          realFloodState.latestRecordedEventIso = metaResult.latestRecordedEventIso;
        }
        realFloodState.metadataLoaded = true;
        populateRealDataFilterOptions();
      }

      const eventsResult = await fetchFloodNetEvents({
        search: realFloodState.search,
        sensorId: realFloodState.sensorId,
        borough: realFloodState.borough,
        startDate: realFloodState.startDate,
        endDate: realFloodState.endDate,
        page: realFloodState.page,
        pageSize: realFloodState.pageSize,
        sensorsList: realFloodState.sensorsList,
        sensorById: realFloodState.sensorById,
        signal: controller.signal
      });

      realFloodState.records = eventsResult.records;
      realFloodState.totalCount = eventsResult.totalCount;
      realFloodState.totalPages = eventsResult.totalPages;
      realFloodState.page = eventsResult.page;
      realFloodState.latencyMs = eventsResult.latencyMs;
      realFloodState.lastFetchedMs = eventsResult.fetchedAtMs;
      realFloodState.initialized = true;
      realFloodState.error = '';

      if (showToastOnDone) {
        showToast(
          `Loaded ${eventsResult.records.length} historical FloodNet records (${eventsResult.totalCount.toLocaleString()} total matching).`,
          'NORMAL'
        );
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      realFloodState.error =
        err instanceof Error ? err.message : 'Failed to retrieve NYC Open Data records.';
      if (showToastOnDone) {
        showToast(`NYC Open Data error: ${realFloodState.error}`, 'CRITICAL');
      }
    } finally {
      if (realFloodState.abortController === controller) {
        realFloodState.loading = false;
        renderRealFloodDataView();
      }
    }
  }

  /* --------------------------------------------------------------------------
   * 9. EVENT LISTENERS
   * -------------------------------------------------------------------------- */
  function bindEvents() {
    // Primary 4-Section Navigation
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-view');
        if (target) switchView(target);
      });
    });

    document.getElementById('brandHomeLink')?.addEventListener('click', (e) => {
      e.preventDefault();
      switchView('home');
    });

    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const primaryNav = document.getElementById('primaryNav');
    if (mobileMenuBtn && primaryNav) {
      mobileMenuBtn.addEventListener('click', () => {
        const isOpen = primaryNav.classList.toggle('mobile-open');
        mobileMenuBtn.setAttribute('aria-expanded', String(isOpen));
      });
    }

    // Header & Home Auth Actions
    document.getElementById('btnHeaderSignIn')?.addEventListener('click', () => {
      setAuthMode('login', false);
      applyActiveViewDOM('home');
      document.getElementById('homeAuthCard')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    document.getElementById('btnHomeOpenDashboard')?.addEventListener('click', () => switchView('dashboard'));
    document.getElementById('btnHomeOpenRealData')?.addEventListener('click', () => switchView('realdata'));

    async function handleLogoutClick(triggerBtn) {
      setButtonBusy(triggerBtn, 'Signing out…', true);
      const { error } = await signOutUser();
      setButtonBusy(triggerBtn, 'Logout', false);
      if (error) {
        showToast(`Sign out failed: ${mapAuthError(error)}`, 'CRITICAL');
        return;
      }
      await arduinoClient.disconnect();
      stopSimulationBackup(true);
      authState.session = null;
      authState.user = null;
      authState.role = 'user';
      authState.roleStatus = 'idle';
      authState.recoveryActive = false;
      authState.pendingProtectedView = null;
      savedEventsState.status = 'unauthenticated';
      savedEventsState.events = [];
      try {
        window.sessionStorage.removeItem(LAST_VIEW_KEY);
      } catch {
        // Ignore storage blocks
      }
      updateAuthUI();
      renderRealFloodDataView();
      if (PROTECTED_VIEWS.has(activeView)) {
        setAuthMode('login', false);
        showAuthFeedback('You have been signed out.', 'info');
        applyActiveViewDOM('home');
      }
      showToast('Signed out of NYC FloodGuard.', 'NORMAL');
    }

    document.getElementById('btnHeaderLogout')?.addEventListener('click', (e) => handleLogoutClick(e.currentTarget));
    document.getElementById('btnHomeLogout')?.addEventListener('click', (e) => handleLogoutClick(e.currentTarget));

    document.querySelectorAll('.seg-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const mode = tab.getAttribute('data-auth-mode');
        if (mode) setAuthMode(mode, false);
      });
    });

    document.getElementById('btnGoForgotFromLogin')?.addEventListener('click', () => setAuthMode('forgot', false));
    document.getElementById('btnGoSignUpFromLogin')?.addEventListener('click', () => setAuthMode('signup', false));
    document.getElementById('btnBackToLoginFromForgot')?.addEventListener('click', () => setAuthMode('login', false));
    document.getElementById('btnVerifyBackToLogin')?.addEventListener('click', () => setAuthMode('login', false));

    document.querySelectorAll('.js-toggle-password').forEach((toggleBtn) => {
      toggleBtn.addEventListener('click', () => {
        const targetId = toggleBtn.getAttribute('data-target');
        const input = targetId ? document.getElementById(targetId) : null;
        if (!input) return;
        const isHidden = input.type === 'password';
        input.type = isHidden ? 'text' : 'password';
        toggleBtn.textContent = isHidden ? 'Hide' : 'Show';
      });
    });

    // Sign In Submit
    document.getElementById('authLoginForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = (document.getElementById('authLoginEmail')?.value || '').trim();
      const password = document.getElementById('authLoginPassword')?.value || '';
      const submitBtn = document.getElementById('btnLoginSubmit');

      if (!isValidEmail(email)) {
        showAuthFeedback('Please enter a valid email address.', 'error');
        return;
      }
      if (!password) {
        showAuthFeedback('Please enter your password.', 'error');
        return;
      }

      showAuthFeedback('', 'info');
      setButtonBusy(submitBtn, 'Signing in…', true);
      try {
        const { data, error } = await signInWithEmail({ email, password });
        if (error) {
          showAuthFeedback(mapAuthError(error), 'error');
          return;
        }
        if (data?.session && data?.user) {
          authState.session = data.session;
          authState.user = data.user;
          authState.recoveryActive = false;
          await loadUserRoleAndSettings();
          loadSavedFloodEvents(false);
          checkExistingSupabaseDemoTables();
          const targetView = authState.pendingProtectedView || 'dashboard';
          authState.pendingProtectedView = null;
          switchView(targetView);
          showToast(`Welcome back, ${getUserDisplayName(data.user)}.`, 'NORMAL');
        }
      } catch (err) {
        showAuthFeedback(mapAuthError(err), 'error');
      } finally {
        setButtonBusy(submitBtn, 'Sign In to Dashboard', false);
      }
    });

    // Sign Up Submit
    document.getElementById('authSignUpForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fullName = (document.getElementById('authSignUpName')?.value || '').trim();
      const email = (document.getElementById('authSignUpEmail')?.value || '').trim();
      const password = document.getElementById('authSignUpPassword')?.value || '';
      const confirmPassword = document.getElementById('authSignUpConfirmPassword')?.value || '';
      const submitBtn = document.getElementById('btnSignUpSubmit');

      if (fullName.length < 2) {
        showAuthFeedback('Please enter your full name (at least 2 characters).', 'error');
        return;
      }
      if (!isValidEmail(email)) {
        showAuthFeedback('Please enter a valid email address.', 'error');
        return;
      }
      if (password.length < 6) {
        showAuthFeedback('Password must be at least 6 characters long.', 'error');
        return;
      }
      if (password !== confirmPassword) {
        showAuthFeedback('Passwords do not match.', 'error');
        return;
      }

      showAuthFeedback('', 'info');
      setButtonBusy(submitBtn, 'Creating account…', true);
      try {
        const { data, error } = await signUpWithEmail({ fullName, email, password });
        if (error) {
          showAuthFeedback(mapAuthError(error), 'error');
          return;
        }
        if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          showAuthFeedback('An account with this email may already exist. Try signing in or resetting your password.', 'info');
          return;
        }
        if (data?.session && data?.user) {
          authState.session = data.session;
          authState.user = data.user;
          await loadUserRoleAndSettings();
          loadSavedFloodEvents(false);
          const targetView = authState.pendingProtectedView || 'dashboard';
          authState.pendingProtectedView = null;
          switchView(targetView);
          showToast(`Account created. Welcome, ${fullName}.`, 'NORMAL');
        } else {
          authState.pendingEmailForVerify = email;
          const verifyMsg = document.getElementById('authVerifyMessage');
          if (verifyMsg) {
            verifyMsg.innerHTML = `Account created for <strong>${escapeHtml(fullName)}</strong>. A confirmation link has been sent to <strong>${escapeHtml(email)}</strong>.`;
          }
          document.getElementById('authSignUpForm')?.reset();
          setAuthMode('verify', true);
          showAuthFeedback('Registration successful — check your inbox to verify your email.', 'success');
        }
      } catch (err) {
        showAuthFeedback(mapAuthError(err), 'error');
      } finally {
        setButtonBusy(submitBtn, 'Create Account', false);
      }
    });

    // Resend Verification
    document.getElementById('btnResendVerification')?.addEventListener('click', async (e) => {
      const email =
        authState.pendingEmailForVerify ||
        (document.getElementById('authLoginEmail')?.value || '').trim();
      if (!isValidEmail(email)) {
        showAuthFeedback('Enter your email address on the Sign In tab first.', 'error');
        return;
      }
      const btn = e.currentTarget;
      setButtonBusy(btn, 'Sending…', true);
      try {
        const { error } = await resendVerificationEmail(email);
        if (error) showAuthFeedback(mapAuthError(error), 'error');
        else showAuthFeedback(`Verification email re-sent to ${email}.`, 'success');
      } finally {
        setButtonBusy(btn, 'Resend Email', false);
      }
    });

    // Forgot Password Submit
    document.getElementById('authForgotForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = (document.getElementById('authForgotEmail')?.value || '').trim();
      const submitBtn = document.getElementById('btnForgotSubmit');
      if (!isValidEmail(email)) {
        showAuthFeedback('Please enter a valid email address.', 'error');
        return;
      }
      showAuthFeedback('', 'info');
      setButtonBusy(submitBtn, 'Sending link…', true);
      try {
        const { error } = await sendPasswordResetEmail(email);
        if (error) showAuthFeedback(mapAuthError(error), 'error');
        else {
          showAuthFeedback(
            `Password reset email sent to ${email}. Open the link in your inbox to set a new password.`,
            'success'
          );
        }
      } catch (err) {
        showAuthFeedback(mapAuthError(err), 'error');
      } finally {
        setButtonBusy(submitBtn, 'Send Reset Link', false);
      }
    });

    // Password Recovery Submit
    document.getElementById('authRecoveryForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const newPassword = document.getElementById('authRecoveryNewPassword')?.value || '';
      const confirmPassword = document.getElementById('authRecoveryConfirmPassword')?.value || '';
      const submitBtn = document.getElementById('btnRecoverySubmit');
      if (newPassword.length < 6) {
        showAuthFeedback('New password must be at least 6 characters long.', 'error');
        return;
      }
      if (newPassword !== confirmPassword) {
        showAuthFeedback('Passwords do not match.', 'error');
        return;
      }
      showAuthFeedback('', 'info');
      setButtonBusy(submitBtn, 'Updating…', true);
      try {
        const { data, error } = await updateUserPassword(newPassword);
        if (error) {
          showAuthFeedback(mapAuthError(error), 'error');
          return;
        }
        authState.recoveryActive = false;
        if (data?.user) authState.user = data.user;
        document.getElementById('authRecoveryForm')?.reset();
        await loadUserRoleAndSettings();
        if (isAuthenticated()) {
          switchView('dashboard');
          showToast('Password updated successfully.', 'NORMAL');
        } else {
          setAuthMode('login', true);
          showAuthFeedback('Password updated. You can now sign in.', 'success');
        }
      } catch (err) {
        showAuthFeedback(mapAuthError(err), 'error');
      } finally {
        setButtonBusy(submitBtn, 'Update Password', false);
      }
    });

    // Dashboard: Arduino USB Serial & 6-Stage Demo Mode Controls
    document.getElementById('btnConnectArduino')?.addEventListener('click', async () => {
      if (!isWebSerialSupported()) {
        setDashboardNotice(
          'Web Serial is not supported in this browser. Open NYC FloodGuard 2.0 in desktop Chrome or Microsoft Edge to connect your Arduino GIGA R1 WiFi over USB (close Arduino IDE Serial Monitor first), or use Demo Mode.',
          'warn'
        );
        return;
      }
      await arduinoClient.connect();
    });

    document.getElementById('btnDisconnectArduino')?.addEventListener('click', async () => {
      await arduinoClient.disconnect({ reason: 'manual', message: 'Arduino USB disconnected by user.' });
    });

    // Manual Dry-Road Recalibration ('c' serial command with dry-road confirmation)
    document.getElementById('btnOpenRecalibrate')?.addEventListener('click', () => {
      if (!arduinoClient.connected) {
        showToast('Connect your Arduino GIGA R1 WiFi over USB first.', 'WARNING');
        return;
      }
      const currentStatus = telemetryState.latestAnalysis?.status;
      if (currentStatus === 'WARNING' || currentStatus === 'CRITICAL') {
        showToast(
          `Active ${currentStatus} flood detected — drain the roadway completely before recalibrating!`,
          'WARNING'
        );
      }
      const strip = document.getElementById('recalibrateConfirmStrip');
      const chk = document.getElementById('chkConfirmDryRoad');
      const confirmBtn = document.getElementById('btnConfirmRecalibrate');
      if (chk) chk.checked = false;
      if (confirmBtn) confirmBtn.disabled = true;
      strip?.classList.remove('hidden');
      strip?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    document.getElementById('chkConfirmDryRoad')?.addEventListener('change', (e) => {
      const confirmBtn = document.getElementById('btnConfirmRecalibrate');
      if (confirmBtn) confirmBtn.disabled = !e.target.checked;
    });

    document.getElementById('btnCancelRecalibrate')?.addEventListener('click', () => {
      closeRecalibratePanel();
    });

    document.getElementById('btnConfirmRecalibrate')?.addEventListener('click', async () => {
      const chk = document.getElementById('chkConfirmDryRoad');
      if (!chk || !chk.checked) {
        showToast('Please confirm the roadway is completely dry before recalibrating.', 'WARNING');
        return;
      }
      if (!arduinoClient.connected) {
        closeRecalibratePanel();
        showToast('Arduino USB is no longer connected.', 'WARNING');
        return;
      }

      const confirmBtn = document.getElementById('btnConfirmRecalibrate');
      setButtonBusy(confirmBtn, 'Sending "c"…', true);
      try {
        const res = await arduinoClient.sendCommand('c');
        if (res.ok) {
          closeRecalibratePanel();
          resetCalibrationState('CALIBRATING');
          telemetryState.samples = [];
          setDashboardNotice(
            'Sent "c" recalibration command to Arduino GIGA R1 WiFi. Keep the roadway dry while the new baseline locks…',
            'info'
          );
          showToast('Sent "c" recalibration command to Arduino.', 'NORMAL');
          recalculateTelemetryAndRender(false);
        } else {
          showToast(res.error || 'Could not send recalibration command.', 'CRITICAL');
        }
      } finally {
        setButtonBusy(confirmBtn, "Send 'c' Recalibrate", false);
      }
    });

    // Presentation Test Session Recorder Controls
    document.getElementById('btnToggleRecording')?.addEventListener('click', () => {
      if (sessionRecorder.recording) {
        sessionRecorder.stop();
        if (sessionUiState.timerId) {
          clearInterval(sessionUiState.timerId);
          sessionUiState.timerId = null;
        }
        sessionUiState.showSummary = true;
        renderTestSessionPanel();
        showToast('Test session stopped — summary & CSV download ready.', 'NORMAL');
      } else {
        if (telemetryState.mode === 'UNAVAILABLE') {
          showToast('Connect Arduino (USB) or start Demo Mode before recording a test session.', 'WARNING');
          return;
        }
        const initialStatus = telemetryState.latestAnalysis?.status || 'NORMAL';
        sessionRecorder.start({
          sourceMode: telemetryState.mode === 'LIVE' ? 'LIVE' : 'DEMO',
          initialStatus
        });
        sessionUiState.showSummary = false;
        if (sessionUiState.timerId) clearInterval(sessionUiState.timerId);
        sessionUiState.timerId = setInterval(() => {
          if (sessionRecorder.recording) {
            renderTestSessionPanel();
          }
        }, 1000);
        renderTestSessionPanel();
        showToast('Recording test session — capturing readings, transitions & recovery.', 'NORMAL');
      }
    });

    document.getElementById('btnMarkPumpStopped')?.addEventListener('click', () => {
      if (!sessionRecorder.recording) return;
      const depthCm = telemetryState.latestAnalysis?.filteredDepthCm ?? null;
      sessionRecorder.markPumpStopped({ currentDepthCm: depthCm });
      renderTestSessionPanel();
      showToast('Marked Pump 2 stopped — tracking recovery time to NORMAL.', 'NORMAL');
    });

    document.getElementById('btnDownloadSessionCsv')?.addEventListener('click', () => {
      const summary = sessionRecorder.getSummary();
      if (!summary.hasData) {
        showToast('No test session data recorded yet.', 'WARNING');
        return;
      }
      const csv = sessionRecorder.toCsv();
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
      triggerBrowserDownload(`nyc_floodguard_test_session_${stamp}.csv`, csv, 'text/csv;charset=utf-8');
    });

    document.getElementById('btnToggleSessionSummary')?.addEventListener('click', () => {
      sessionUiState.showSummary = !sessionUiState.showSummary;
      renderTestSessionPanel();
    });

    document.getElementById('btnCopySessionSummary')?.addEventListener('click', async () => {
      const summary = sessionRecorder.getSummary();
      if (!summary.hasData) return;
      const text = [
        'NYC FloodGuard 2.0 — Test Session Summary',
        ...summary.classroomHighlights.map((line) => `- ${line}`)
      ].join('\n');
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          showToast('Copied classroom summary to clipboard.', 'NORMAL');
        } else {
          showToast('Clipboard API unavailable in this browser.', 'WARNING');
        }
      } catch {
        showToast('Could not copy summary to clipboard.', 'WARNING');
      }
    });

    document.getElementById('btnResetSession')?.addEventListener('click', () => {
      if (sessionUiState.timerId) {
        clearInterval(sessionUiState.timerId);
        sessionUiState.timerId = null;
      }
      sessionRecorder.reset();
      sessionUiState.showSummary = false;
      renderTestSessionPanel();
      showToast('Cleared recorded test session.', 'NORMAL');
    });

    document.getElementById('btnToggleSimBackup')?.addEventListener('click', () => {
      if (telemetryState.mode === 'SIMULATED') {
        stopSimulationBackup(true);
      } else {
        startSimulationBackup();
      }
    });

    document.getElementById('btnDemoStop')?.addEventListener('click', () => {
      stopSimulationBackup(true);
    });

    document.getElementById('btnDemoAutoToggle')?.addEventListener('click', () => {
      telemetryState.demoAutoAdvance = !telemetryState.demoAutoAdvance;
      renderDemoStageBar();
      showToast(
        telemetryState.demoAutoAdvance
          ? 'DEMO MODE: Auto-sequence resumed.'
          : 'DEMO MODE: Auto-sequence paused on current stage.',
        'NORMAL'
      );
    });

    document.getElementById('btnDemoRestart')?.addEventListener('click', () => {
      if (telemetryState.mode !== 'SIMULATED') return;
      telemetryState.samples = [];
      telemetryState.lastAlertStatus = null;
      telemetryState.demoAutoAdvance = true;
      setDemoStage(0, true);
      recalculateTelemetryAndRender(false);
    });

    document.querySelectorAll('.demo-stage-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (telemetryState.mode !== 'SIMULATED') return;
        const idx = Number(btn.getAttribute('data-demo-stage'));
        if (Number.isFinite(idx)) {
          setDemoStage(idx, true);
        }
      });
    });

    document.getElementById('btnClearChartHistory')?.addEventListener('click', () => {
      telemetryState.samples = [];
      recalculateTelemetryAndRender(false);
    });

    document.getElementById('btnClearAlertHistory')?.addEventListener('click', () => {
      telemetryState.alertHistory = [];
      telemetryState.lastAlertStatus = null;
      renderAlertHistoryPanel();
    });

    // Live NYC Weather Refresh
    document.getElementById('btnRefreshWeather')?.addEventListener('click', () => {
      loadLiveNycWeather(true);
    });

    // AI FloodGuard Assistant Form, Suggested Questions, Copy, Clear & Expand Controls
    document.getElementById('aiAssistantForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('aiQuestionInput');
      const q = (input?.value || '').trim();
      if (!q) return;
      if (input) input.value = '';
      askFloodGuardAssistant(q);
    });

    document.querySelectorAll('.ai-prompt-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const q = btn.getAttribute('data-question');
        if (q) askFloodGuardAssistant(q);
      });
    });

    document.getElementById('btnExpandAssistant')?.addEventListener('click', () => {
      aiAssistantState.expanded = !aiAssistantState.expanded;
      renderAiAssistantPanel();
    });

    document.getElementById('btnClearAssistant')?.addEventListener('click', () => {
      aiAssistantState.messages = [];
      aiAssistantState.error = '';
      aiAssistantState.copiedId = null;
      renderAiAssistantPanel();
      showToast('Conversation cleared.', 'NORMAL');
    });

    document.getElementById('aiMessagesBox')?.addEventListener('click', async (e) => {
      const copyBtn = e.target.closest('.chat-copy-btn');
      if (!copyBtn) return;
      const msgId = copyBtn.getAttribute('data-copy-msg');
      const target = aiAssistantState.messages.find((m) => m.id === msgId);
      if (!target) return;
      try {
        await navigator.clipboard.writeText(target.answer);
        aiAssistantState.copiedId = msgId;
        renderAiAssistantPanel();
        showToast('Assistant response copied to clipboard.', 'NORMAL');
        setTimeout(() => {
          if (aiAssistantState.copiedId === msgId) {
            aiAssistantState.copiedId = null;
            renderAiAssistantPanel();
          }
        }, 2000);
      } catch {
        showToast('Clipboard permission unavailable in this browser context.', 'WARNING');
      }
    });

    // Optional Fullscreen Presentation Mode Controls
    document.getElementById('btnTogglePresentationMode')?.addEventListener('click', () => {
      setPresentationMode(!presentationState.active);
    });
    document.getElementById('btnExitPresentationMode')?.addEventListener('click', () => {
      setPresentationMode(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && presentationState.active) {
        setPresentationMode(false);
      }
    });
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && presentationState.active) {
        // Keep user control synchronized when exiting native fullscreen via browser Esc
        presentationState.active = false;
        document.body.classList.remove('presentation-mode');
        document.getElementById('presentationTopBar')?.classList.add('hidden');
        if (presentationState.clockTimerId) {
          clearInterval(presentationState.clockTimerId);
          presentationState.clockTimerId = null;
        }
        setTimeout(() => {
          drawWaterHistoryChart();
          drawWeatherRainChart();
        }, 80);
      }
    });

    // Chart hover inspection (distinguishing filtered vs raw values consistently)
    const historyCanvas = document.getElementById('floodHistoryCanvas');
    if (historyCanvas) {
      historyCanvas.addEventListener('mousemove', (e) => {
        if (!lastChartPoints || lastChartPoints.length === 0) return;
        const rect = historyCanvas.getBoundingClientRect();
        const relX = Math.max(0, Math.min(1, (e.clientX - rect.left - 52) / Math.max(1, rect.width - 76)));
        const idx = Math.min(lastChartPoints.length - 1, Math.max(0, Math.round(relX * (lastChartPoints.length - 1))));
        const pt = lastChartPoints[idx];
        const readout = document.getElementById('dashChartReadout');
        if (readout && pt) {
          const fDistStr = pt.filteredDistanceCm != null ? pt.filteredDistanceCm.toFixed(2) : '--';
          const rDistStr = pt.rawDistanceCm != null ? pt.rawDistanceCm.toFixed(2) : '--';
          const rDepthStr = pt.rawDepthCm != null ? pt.rawDepthCm.toFixed(2) : '--';
          readout.textContent = `${new Date(pt.timestampMs).toLocaleTimeString()} — Filtered: ${pt.filteredDepthCm.toFixed(2)} cm (Dist ${fDistStr} cm) · Raw: ${rDepthStr} cm (Dist ${rDistStr} cm)`;
        }
      });
    }

    // Administrator Settings Form Submit (Database RLS Enforced)
    document.getElementById('adminSettingsForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!isVerifiedAdmin()) {
        showToast('Administrator privileges required (enforced by Supabase RLS).', 'CRITICAL');
        return;
      }

      const mountHeightCm = Number(document.getElementById('cfgMountHeightCm')?.value);
      const warnThresholdCm = Number(document.getElementById('cfgWarnThresholdCm')?.value);
      const critThresholdCm = Number(document.getElementById('cfgCritThresholdCm')?.value);
      const minRiseRateCmPerMin = Number(document.getElementById('cfgMinRiseRate')?.value);
      const barrierThresholdCm = Number(document.getElementById('cfgBarrierThresholdCm')?.value);

      if (!Number.isFinite(mountHeightCm) || mountHeightCm <= 5) {
        showToast('Mounting height must be greater than 5 cm.', 'WARNING');
        return;
      }
      if (!Number.isFinite(warnThresholdCm) || warnThresholdCm <= 0) {
        showToast('Warning threshold must be greater than 0 cm.', 'WARNING');
        return;
      }
      if (!Number.isFinite(critThresholdCm) || critThresholdCm <= warnThresholdCm) {
        showToast('Critical threshold must be greater than the Warning threshold.', 'WARNING');
        return;
      }

      const saveBtn = document.getElementById('btnSaveAdminSettings');
      setButtonBusy(saveBtn, 'Saving…', true);
      try {
        const res = await updateMonitoringSettings({
          mountHeightCm,
          warnThresholdCm,
          critThresholdCm,
          minRiseRateCmPerMin,
          barrierThresholdCm
        });
        if (res.status === 'ok' && res.settings) {
          prototypeSettingsState.source = 'supabase';
          prototypeSettingsState.status = 'ok';
          prototypeSettingsState.legacyDeepBasinBlocked = false;
          prototypeSettingsState.explicitAdminSave = true;
          prototypeSettingsState.values = {
            ...DEFAULT_PROTOTYPE_SETTINGS,
            ...res.settings
          };
          renderAdminSettingsPanel();
          recalculateTelemetryAndRender();
          showToast('Saved prototype settings to Supabase.', 'NORMAL');
        } else {
          showToast(res.errorMessage || 'Unable to save settings.', 'CRITICAL');
        }
      } finally {
        setButtonBusy(saveBtn, 'Save Settings to Supabase', false);
      }
    });

    document.getElementById('btnPresetStreetModel')?.addEventListener('click', () => {
      if (!isVerifiedAdmin()) return;
      const p = PROTOTYPE_PRESETS.EXPERIMENTAL_STREET_MODEL;
      document.getElementById('cfgMountHeightCm').value = p.mountHeightCm.toFixed(2);
      document.getElementById('cfgWarnThresholdCm').value = p.warnThresholdCm.toFixed(2);
      document.getElementById('cfgCritThresholdCm').value = p.critThresholdCm.toFixed(2);
      document.getElementById('cfgMinRiseRate').value = p.minRiseRateCmPerMin.toFixed(2);
      document.getElementById('cfgBarrierThresholdCm').value = p.barrierThresholdCm.toFixed(2);
      showToast('Experimental Street Model thresholds (0.50 / 1.25 cm) populated — click Save Settings to persist.', 'NORMAL');
    });

    // Independent Backup Float Sensor (Liyafy XSL-3508-P) Configuration & Log Controls
    document.getElementById('floatActivationForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const inputEl = document.getElementById('floatActivationHeightInput');
      const polEl = document.getElementById('floatClosedPolaritySelect');
      const rawVal = Number(inputEl?.value);
      if (!Number.isFinite(rawVal) || rawVal < 0.1 || rawVal > 50) {
        showToast('Enter a valid physical float activation height between 0.10 and 50.00 cm.', 'WARNING');
        return;
      }
      floatSwitchState.activationHeightCm = Number(rawVal.toFixed(2));
      floatSwitchState.closedMeansWater = (polEl?.value || 'water') === 'water';
      persistFloatSwitchConfig();
      renderBackupFloatPanel();
      showToast(
        `Float activation height set to ${floatSwitchState.activationHeightCm.toFixed(2)} cm. Sensor-agreement indicator enabled.`,
        'NORMAL'
      );
    });

    document.getElementById('floatClosedPolaritySelect')?.addEventListener('change', (e) => {
      floatSwitchState.closedMeansWater = e.target.value === 'water';
      persistFloatSwitchConfig();
      renderBackupFloatPanel();
    });

    document.getElementById('btnClearFloatHeight')?.addEventListener('click', () => {
      floatSwitchState.activationHeightCm = null;
      persistFloatSwitchConfig();
      renderBackupFloatPanel();
      showToast('Float activation height cleared. Sensor-agreement indicator disabled until mounted.', 'NORMAL');
    });

    document.getElementById('btnClearFloatHistory')?.addEventListener('click', () => {
      floatSwitchState.history = [];
      floatSwitchState.transitionCount = 0;
      renderBackupFloatPanel();
    });

    // 9-Step Live Presentation Walkthrough Controls
    document.getElementById('walkthroughStepsGrid')?.addEventListener('click', (e) => {
      const stepBtn = e.target.closest('.walkthrough-step');
      if (!stepBtn) return;
      const stepNum = Number(stepBtn.getAttribute('data-step'));
      if (!Number.isFinite(stepNum)) return;
      if (walkthroughState.manualDone.has(stepNum)) {
        walkthroughState.manualDone.delete(stepNum);
        walkthroughState.autoDone.delete(stepNum);
      } else {
        walkthroughState.manualDone.add(stepNum);
      }
      renderLiveWalkthroughPanel(telemetryState.latestAnalysis);
    });

    document.getElementById('btnResetWalkthrough')?.addEventListener('click', () => {
      walkthroughState.manualDone.clear();
      walkthroughState.autoDone.clear();
      walkthroughState.sawFloodInLive = false;
      renderLiveWalkthroughPanel(telemetryState.latestAnalysis);
      showToast('Presentation walkthrough steps reset.', 'NORMAL');
    });

    // Independent Ruler vs. Ultrasonic Measurement Validation Form
    document.getElementById('rulerValidationForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const rulerInput = document.getElementById('valRulerDepthInput');
      const noteInput = document.getElementById('valNoteInput');
      const activeAnalysis = telemetryState.latestAnalysis;

      const hasValidReading =
        (telemetryState.mode === 'LIVE' || telemetryState.mode === 'SIMULATED') &&
        telemetryState.streamHealth !== 'STALE' &&
        telemetryState.streamHealth !== 'CONNECTION_LOST' &&
        activeAnalysis &&
        activeAnalysis.available &&
        activeAnalysis.filteredDepthCm != null;

      if (!hasValidReading) {
        showToast('Connect your LIVE Arduino (with a valid reading) before logging a ruler comparison.', 'WARNING');
        return;
      }

      const res = addValidationComparison(validationState, {
        rulerCm: rulerInput?.value,
        sensorCm: activeAnalysis.filteredDepthCm,
        sourceMode: telemetryState.mode === 'LIVE' ? 'LIVE' : 'SIMULATED',
        note: noteInput?.value || '',
        timestampMs: Date.now()
      });

      if (!res.ok) {
        showToast(res.error || 'Invalid ruler measurement.', 'WARNING');
        return;
      }

      persistValidationLog();
      if (rulerInput) rulerInput.value = '';
      if (noteInput) noteInput.value = '';
      renderMeasurementValidationPanel(activeAnalysis);
      showToast(
        `Logged ${res.entry.sourceMode} comparison: Ruler ${res.entry.rulerCm.toFixed(2)} cm vs Sensor ${res.entry.sensorCm.toFixed(2)} cm (Abs Error ${res.entry.absErrorCm.toFixed(2)} cm).`,
        'NORMAL'
      );
    });

    document.getElementById('btnClearValidationLog')?.addEventListener('click', () => {
      validationState.entries = [];
      persistValidationLog();
      renderMeasurementValidationPanel(telemetryState.latestAnalysis);
      showToast('Cleared measurement validation log.', 'NORMAL');
    });

    // Download Arduino GIGA R1 WiFi Sketch (.ino)
    document.getElementById('btnDownloadArduinoSketch')?.addEventListener('click', () => {
      triggerBrowserDownload('nyc_floodguard_giga.ino', arduinoSketchSource, 'text/plain;charset=utf-8');
    });

    // NYC FloodNet Historical Data Controls
    function syncRealFiltersFromInputs(resetPage) {
      realFloodState.search = (document.getElementById('realDataSearchInput')?.value || '').trim();
      realFloodState.borough = document.getElementById('realDataBoroughFilter')?.value || 'ALL';
      realFloodState.sensorId = document.getElementById('realDataSensorFilter')?.value || 'ALL';
      realFloodState.startDate = document.getElementById('realDataStartDate')?.value || '';
      realFloodState.endDate = document.getElementById('realDataEndDate')?.value || '';
      realFloodState.pageSize = Number(document.getElementById('realDataPageSize')?.value || 25);
      if (resetPage) realFloodState.page = 1;
    }

    function resetRealFiltersAndReload() {
      const ids = [
        ['realDataSearchInput', ''],
        ['realDataBoroughFilter', 'ALL'],
        ['realDataSensorFilter', 'ALL'],
        ['realDataStartDate', ''],
        ['realDataEndDate', ''],
        ['realDataPageSize', '25']
      ];
      ids.forEach(([id, val]) => {
        const el = document.getElementById(id);
        if (el) el.value = val;
      });
      realFloodState.search = '';
      realFloodState.borough = 'ALL';
      realFloodState.sensorId = 'ALL';
      realFloodState.startDate = '';
      realFloodState.endDate = '';
      realFloodState.pageSize = 25;
      realFloodState.page = 1;
      populateRealDataFilterOptions();
      loadRealFloodData();
    }

    document.getElementById('realDataFilterForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      syncRealFiltersFromInputs(true);
      loadRealFloodData();
    });

    document.getElementById('realDataBoroughFilter')?.addEventListener('change', () => {
      syncRealFiltersFromInputs(true);
      populateRealDataFilterOptions();
      loadRealFloodData();
    });

    ['realDataSensorFilter', 'realDataStartDate', 'realDataEndDate', 'realDataPageSize'].forEach((id) => {
      document.getElementById(id)?.addEventListener('change', () => {
        syncRealFiltersFromInputs(true);
        loadRealFloodData();
      });
    });

    document.getElementById('btnResetRealDataFilters')?.addEventListener('click', resetRealFiltersAndReload);
    document.getElementById('btnEmptyResetRealData')?.addEventListener('click', resetRealFiltersAndReload);

    document.getElementById('btnRefreshRealData')?.addEventListener('click', () => {
      syncRealFiltersFromInputs(false);
      loadRealFloodData({ refreshMetadata: true, showToastOnDone: true });
    });
    document.getElementById('btnRetryRealData')?.addEventListener('click', () => {
      syncRealFiltersFromInputs(false);
      loadRealFloodData({ refreshMetadata: !realFloodState.metadataLoaded, showToastOnDone: true });
    });

    document.getElementById('btnRealPageFirst')?.addEventListener('click', () => {
      if (realFloodState.page > 1) {
        realFloodState.page = 1;
        loadRealFloodData();
      }
    });
    document.getElementById('btnRealPagePrev')?.addEventListener('click', () => {
      if (realFloodState.page > 1) {
        realFloodState.page -= 1;
        loadRealFloodData();
      }
    });
    document.getElementById('btnRealPageNext')?.addEventListener('click', () => {
      if (realFloodState.page < realFloodState.totalPages) {
        realFloodState.page += 1;
        loadRealFloodData();
      }
    });
    document.getElementById('btnRealPageLast')?.addEventListener('click', () => {
      if (realFloodState.page < realFloodState.totalPages) {
        realFloodState.page = realFloodState.totalPages;
        loadRealFloodData();
      }
    });
    document.getElementById('btnJumpPast1000')?.addEventListener('click', () => {
      const targetPage = Math.min(realFloodState.totalPages, Math.floor(1000 / realFloodState.pageSize) + 1);
      realFloodState.page = targetPage;
      loadRealFloodData({ showToastOnDone: true });
    });
    document.getElementById('btnRealPageGo')?.addEventListener('click', () => {
      const val = Number(document.getElementById('realDataJumpPageInput')?.value || 1);
      realFloodState.page = Math.max(1, Math.min(realFloodState.totalPages, Math.floor(val)));
      loadRealFloodData();
    });

    document.getElementById('btnRefreshSavedEvents')?.addEventListener('click', () => {
      loadSavedFloodEvents(true);
    });

    // Delegated clicks for bookmark rows
    document.body.addEventListener('click', (e) => {
      const saveBtn = e.target.closest('.js-save-flood-event');
      if (saveBtn) {
        const idx = Number(saveBtn.getAttribute('data-index'));
        if (Number.isFinite(idx)) handleSaveFloodEvent(idx);
        return;
      }

      const delBtn = e.target.closest('.js-delete-saved-event');
      if (delBtn) {
        const savedId = delBtn.getAttribute('data-saved-id');
        if (savedId) handleDeleteSavedEvent(savedId);
        return;
      }

      const signInBtn = e.target.closest('.js-saved-signin-cta');
      if (signInBtn) {
        authState.pendingProtectedView = 'realdata';
        setAuthMode('login', false);
        showAuthFeedback('Sign in to bookmark and view your saved historical flood events.', 'info');
        applyActiveViewDOM('home');
        document.getElementById('homeAuthCard')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });

    // Network & resize listeners
    const syncOnlineBanner = () => {
      document.getElementById('networkBanner')?.classList.toggle('hidden', navigator.onLine);
    };
    window.addEventListener('online', () => {
      syncOnlineBanner();
      checkExistingSupabaseDemoTables();
      loadLiveNycWeather(false);
      if (activeView === 'realdata') {
        loadRealFloodData({ refreshMetadata: !realFloodState.metadataLoaded });
      }
    });
    window.addEventListener('offline', syncOnlineBanner);
    window.addEventListener('resize', () => {
      if (activeView === 'dashboard') {
        drawWaterHistoryChart();
        drawWeatherRainChart();
      }
    });
    syncOnlineBanner();
  }

  /* --------------------------------------------------------------------------
   * 10. INITIALIZE SUPABASE AUTH SESSION & APP STARTUP
   * -------------------------------------------------------------------------- */
  async function initAuthentication() {
    let urlErrorDesc = '';
    let urlRedirectType = '';
    try {
      const current = new URL(window.location.href);
      const hashParams = new URLSearchParams(current.hash.replace(/^#/, ''));
      urlErrorDesc =
        current.searchParams.get('error_description') ||
        hashParams.get('error_description') ||
        current.searchParams.get('error') ||
        hashParams.get('error') ||
        '';
      urlRedirectType = current.searchParams.get('type') || hashParams.get('type') || '';
    } catch {
      // Ignore URL parse error
    }

    if (urlRedirectType === 'recovery') {
      authState.recoveryActive = true;
    }

    subscribeToAuthState(async (event, session) => {
      authState.session = session || null;
      authState.user = session?.user || null;

      if (event === 'PASSWORD_RECOVERY') {
        authState.recoveryActive = true;
        updateAuthUI();
        setAuthMode('recovery', true);
        showAuthFeedback('Recovery link verified. Enter and confirm your new password below.', 'info');
        applyActiveViewDOM('home');
        cleanAuthRedirectUrl();
        return;
      }

      if (event === 'SIGNED_IN' && session?.user) {
        await loadUserRoleAndSettings();
        loadSavedFloodEvents(false);
        checkExistingSupabaseDemoTables();
        cleanAuthRedirectUrl();

        if (!authState.recoveryActive && authState.pendingProtectedView) {
          const targetView = authState.pendingProtectedView;
          authState.pendingProtectedView = null;
          switchView(targetView);
        }
        return;
      }

      if (event === 'SIGNED_OUT') {
        authState.session = null;
        authState.user = null;
        authState.role = 'user';
        authState.roleStatus = 'idle';
        authState.recoveryActive = false;
        savedEventsState.status = 'unauthenticated';
        savedEventsState.events = [];
        updateAuthUI();
        renderRealFloodDataView();
        if (PROTECTED_VIEWS.has(activeView)) {
          setAuthMode('login', false);
          showAuthFeedback('Your session ended. Please sign in again.', 'info');
          applyActiveViewDOM('home');
        }
      }
    });

    try {
      const { session, error } = await getAuthSession();
      authState.loading = false;
      authState.session = session || null;
      authState.user = session?.user || null;

      if (urlErrorDesc) {
        updateAuthUI();
        setAuthMode('login', true);
        showAuthFeedback(mapAuthError({ message: urlErrorDesc }), 'error');
        applyActiveViewDOM('home');
        cleanAuthRedirectUrl();
      } else if (authState.recoveryActive && session?.user) {
        updateAuthUI();
        setAuthMode('recovery', true);
        showAuthFeedback('Recovery link verified. Enter and confirm your new password below.', 'info');
        applyActiveViewDOM('home');
        cleanAuthRedirectUrl();
      } else if (session?.user) {
        await loadUserRoleAndSettings();
        loadSavedFloodEvents(false);
        cleanAuthRedirectUrl();
        let savedView = null;
        try {
          savedView = window.sessionStorage.getItem(LAST_VIEW_KEY);
        } catch {
          savedView = null;
        }
        if (savedView && document.getElementById('view-' + savedView)) {
          applyActiveViewDOM(savedView);
        }
      } else {
        if (error) showAuthFeedback(mapAuthError(error), 'error');
        updateAuthUI();
        renderSavedFloodEventsPanel();
      }
    } catch (err) {
      authState.loading = false;
      updateAuthUI();
      showAuthFeedback(mapAuthError(err), 'error');
    }

    checkExistingSupabaseDemoTables();
  }

  function init() {
    bindEvents();
    refreshLucideIcons();
    recalculateTelemetryAndRender();
    startLiveStaleWatchdog();
    initAuthentication();
    loadLiveNycWeather(false);
    checkAiAssistantStatus();

    // Auto-refresh live NYC weather every 10 minutes while online
    if (weatherState.refreshTimerId) clearInterval(weatherState.refreshTimerId);
    weatherState.refreshTimerId = setInterval(() => {
      if (navigator.onLine) loadLiveNycWeather(false);
    }, 10 * 60 * 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
