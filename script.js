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
  analyzeWaterTelemetry
} from './floodAnalytics.js';
import {
  ArduinoSerialClient,
  isWebSerialSupported
} from './arduinoSerial.js';
import arduinoSketchSource from './arduino/nyc_floodguard_giga.ino?raw';

(function () {
  'use strict';

  const PROTECTED_VIEWS = new Set(['dashboard']);
  const LAST_VIEW_KEY = 'nyc_floodguard_last_view_v2';
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
    values: { ...DEFAULT_PROTOTYPE_SETTINGS }
  };

  /**
   * Live / Simulated / Unavailable FloodGuard prototype telemetry state.
   * Strictly isolated from NYC FloodNet historical data.
   */
  const telemetryState = {
    mode: 'UNAVAILABLE', // 'LIVE' | 'SIMULATED' | 'UNAVAILABLE'
    connectionText: 'No live Arduino or backup simulation active',
    noticeText: '',
    noticeType: 'info', // 'info' | 'warn' | 'error' | 'success'
    samples: [], // { timestampMs, distanceCm, depthCm, mountHeightCm }
    latestAnalysis: null,
    latestHardware: {
      device: '',
      floatLow: null,
      floatHigh: null,
      barrierState: 'not_installed',
      lastPacketMs: null
    },
    // Backup simulation state (never mixed with LIVE hardware readings)
    simTimerId: null,
    simScenario: 'RISING', // 'RISING' | 'FALLING' | 'STEADY'
    simCurrentDepthCm: 2.5
  };

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
      setTimeout(drawWaterHistoryChart, 30);
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
      prototypeSettingsState.source = 'supabase';
      prototypeSettingsState.status = 'ok';
      prototypeSettingsState.message = '';
      prototypeSettingsState.values = {
        ...DEFAULT_PROTOTYPE_SETTINGS,
        ...settingsRes.settings
      };
    } else {
      prototypeSettingsState.source = 'defaults';
      prototypeSettingsState.status = settingsRes.status;
      prototypeSettingsState.message = settingsRes.errorMessage || '';
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
      mountInput.value = Number(cfg.mountHeightCm).toFixed(1);
      mountInput.disabled = !admin;
    }
    if (warnInput) {
      warnInput.value = Number(cfg.warnThresholdCm).toFixed(1);
      warnInput.disabled = !admin;
    }
    if (critInput) {
      critInput.value = Number(cfg.critThresholdCm).toFixed(1);
      critInput.disabled = !admin;
    }
    if (riseInput) {
      riseInput.value = Number(cfg.minRiseRateCmPerMin).toFixed(2);
      riseInput.disabled = !admin;
    }
    if (barrierInput) {
      barrierInput.value = Number(cfg.barrierThresholdCm).toFixed(1);
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
    timestampMs = Date.now(),
    errorCode = null,
    firmwareQuality = null,
    burstSpreadCm = null,
    validPings = null
  }) {
    const mount = Number.isFinite(mountHeightCm)
      ? mountHeightCm
      : prototypeSettingsState.values.mountHeightCm;

    // Store raw packet verbatim (including out-of-range and timeout frames)
    // so analyzeWaterTelemetry() can flag Out of Range, reject spikes, and never fake 0 cm.
    telemetryState.samples.push({
      timestampMs: timestampMs || Date.now(),
      distanceCm: Number.isFinite(distanceCm) ? Number(distanceCm.toFixed(2)) : null,
      mountHeightCm: Number(mount.toFixed(2)),
      errorCode: errorCode || null,
      firmwareQuality: firmwareQuality || null,
      burstSpreadCm: Number.isFinite(burstSpreadCm) ? Number(burstSpreadCm.toFixed(2)) : null,
      validPings: Number.isFinite(validPings) ? validPings : null
    });

    if (telemetryState.samples.length > MAX_RAW_PACKETS) {
      telemetryState.samples = telemetryState.samples.slice(-MAX_RAW_PACKETS);
    }

    recalculateTelemetryAndRender();
  }

  function recalculateTelemetryAndRender() {
    telemetryState.latestAnalysis = analyzeWaterTelemetry(
      telemetryState.samples,
      prototypeSettingsState.values,
      telemetryState.mode
    );
    renderDashboard();
  }

  // Real USB Web Serial Client for Arduino GIGA R1 WiFi
  const arduinoClient = new ArduinoSerialClient({
    baudRate: 115200,
    onStatusChange(status, msg) {
      if (status === 'connecting') {
        setDashboardNotice(msg, 'info');
      } else if (status === 'connected') {
        // Never allow simulation backup to stay active while live hardware is connected
        stopSimulationBackup(false);
        telemetryState.mode = 'UNAVAILABLE'; // Stay UNAVAILABLE until first Arduino packet arrives
        telemetryState.samples = [];
        telemetryState.connectionText = msg;
        telemetryState.latestHardware.lastPacketMs = null;
        setDashboardNotice(msg, 'info');
        recalculateTelemetryAndRender();
      } else if (status === 'disconnected') {
        if (telemetryState.mode === 'LIVE' || !telemetryState.simTimerId) {
          telemetryState.mode = 'UNAVAILABLE';
          telemetryState.connectionText = msg || 'Arduino USB disconnected';
          telemetryState.latestHardware.floatLow = null;
          telemetryState.latestHardware.floatHigh = null;
          telemetryState.latestHardware.barrierState = 'not_installed';
          telemetryState.latestHardware.lastPacketMs = null;
        }
        setDashboardNotice(msg || 'Arduino USB disconnected.', 'info');
        recalculateTelemetryAndRender();
      }
    },
    onReading(packet) {
      // Genuine live Arduino sensor packet received over USB Serial (including timeout / out-of-range frames)
      if (telemetryState.simTimerId) {
        stopSimulationBackup(false);
      }
      telemetryState.mode = 'LIVE';
      telemetryState.latestHardware = {
        device: packet.device,
        floatLow: packet.floatLow,
        floatHigh: packet.floatHigh,
        barrierState: packet.barrierState || 'not_installed',
        lastPacketMs: packet.receivedAtMs
      };
      telemetryState.connectionText = `${packet.device} · USB Serial 115200 baud · Last packet ${new Date(packet.receivedAtMs).toLocaleTimeString()}`;
      setDashboardNotice('', 'info');

      // Use Admin-configured mounting height if set in Supabase, or Arduino's calibrated mount_height_cm
      const mountHeightCm =
        prototypeSettingsState.source === 'supabase'
          ? prototypeSettingsState.values.mountHeightCm
          : packet.mountHeightCm ?? prototypeSettingsState.values.mountHeightCm;

      // Legacy fallback only if a packet sent water_depth_cm without distance_cm and without error
      let distanceCm = packet.distanceCm;
      if (distanceCm == null && !packet.errorCode && Number.isFinite(packet.reportedDepthCm)) {
        distanceCm = mountHeightCm - packet.reportedDepthCm;
      }

      pushTelemetrySample({
        distanceCm,
        mountHeightCm,
        timestampMs: packet.receivedAtMs,
        errorCode: packet.errorCode,
        firmwareQuality: packet.firmwareQuality,
        burstSpreadCm: packet.burstSpreadCm,
        validPings: packet.validPings
      });
    },
    onError(errMsg) {
      setDashboardNotice(errMsg, 'error');
      showToast(errMsg, 'WARNING');
      renderDashboard();
    }
  });

  function startSimulationBackup() {
    if (arduinoClient.connected) {
      showToast('Disconnect live Arduino USB before starting Simulation Backup.', 'WARNING');
      return;
    }

    stopSimulationBackup(false);
    telemetryState.mode = 'SIMULATED';
    telemetryState.simScenario = 'RISING';
    telemetryState.simCurrentDepthCm = 2.5;
    telemetryState.samples = [];
    telemetryState.connectionText = 'Backup demo generator active (1s interval · Not live hardware)';
    telemetryState.latestHardware = {
      device: 'SIMULATED_BACKUP',
      floatLow: null,
      floatHigh: null,
      barrierState: 'not_installed',
      lastPacketMs: Date.now()
    };
    setDashboardNotice(
      'Simulation Backup active — displaying clearly labeled SIMULATED readings for demonstration (no Arduino hardware connected).',
      'warn'
    );

    const stepSimulation = () => {
      if (telemetryState.mode !== 'SIMULATED') return;
      const mount = prototypeSettingsState.values.mountHeightCm;
      const maxDepth = Math.max(5, mount - 2.5);

      // Simulate realistic rising, falling, or steady ultrasonic distance readings
      let deltaCm = 0;
      if (telemetryState.simScenario === 'RISING') {
        deltaCm = 0.065 + (Math.random() - 0.5) * 0.025; // ~+3.9 cm/min steady rise for crisp classroom demo
      } else if (telemetryState.simScenario === 'FALLING') {
        deltaCm = -0.065 + (Math.random() - 0.5) * 0.025; // ~-3.9 cm/min steady falling water
      } else {
        deltaCm = (Math.random() - 0.5) * 0.03; // Minor acoustic ripple around steady surface
      }

      telemetryState.simCurrentDepthCm = Math.max(
        0,
        Math.min(maxDepth, telemetryState.simCurrentDepthCm + deltaCm)
      );

      // Small realistic ultrasonic jitter (±0.04 cm)
      const rippleNoise = (Math.random() - 0.5) * 0.08;
      const simulatedDepth = Math.max(0, telemetryState.simCurrentDepthCm + rippleNoise);
      const simulatedDistance = Math.max(2.2, mount - simulatedDepth);

      telemetryState.latestHardware.floatLow = simulatedDepth >= 2.0;
      telemetryState.latestHardware.floatHigh = simulatedDepth >= prototypeSettingsState.values.critThresholdCm;
      telemetryState.latestHardware.lastPacketMs = Date.now();

      pushTelemetrySample({
        distanceCm: simulatedDistance,
        mountHeightCm: mount,
        timestampMs: Date.now()
      });
    };

    stepSimulation();
    telemetryState.simTimerId = setInterval(stepSimulation, 1000);
    renderDashboard();
  }

  function stopSimulationBackup(resetToUnavailable = true) {
    if (telemetryState.simTimerId) {
      clearInterval(telemetryState.simTimerId);
      telemetryState.simTimerId = null;
    }
    if (resetToUnavailable && telemetryState.mode === 'SIMULATED') {
      telemetryState.mode = 'UNAVAILABLE';
      telemetryState.connectionText = 'Simulation stopped · No active sensor stream';
      telemetryState.latestHardware.floatLow = null;
      telemetryState.latestHardware.floatHigh = null;
      telemetryState.latestHardware.lastPacketMs = null;
      setDashboardNotice('', 'info');
      recalculateTelemetryAndRender();
    }
  }

  // Watchdog: if live Arduino stops sending JSON for > staleTimeoutMs, switch honestly to UNAVAILABLE
  function startLiveStaleWatchdog() {
    if (staleWatchTimerId) clearInterval(staleWatchTimerId);
    staleWatchTimerId = setInterval(() => {
      if (telemetryState.mode === 'LIVE' && telemetryState.latestHardware.lastPacketMs) {
        const elapsed = Date.now() - telemetryState.latestHardware.lastPacketMs;
        if (elapsed > prototypeSettingsState.values.staleTimeoutMs) {
          telemetryState.mode = 'UNAVAILABLE';
          telemetryState.connectionText = 'Arduino USB connected, but no sensor readings received recently';
          setDashboardNotice(
            'Live Arduino readings timed out (>8 seconds since last valid JSON packet). Check HC-SR04 wiring and Serial output.',
            'warn'
          );
          recalculateTelemetryAndRender();
        }
      }
    }, 2000);
  }

  /* --------------------------------------------------------------------------
   * 6. DASHBOARD RENDERING & WATER-LEVEL HISTORY CHART (CM)
   * -------------------------------------------------------------------------- */
  function renderDashboard() {
    const cfg = prototypeSettingsState.values;
    const analysis =
      telemetryState.latestAnalysis ||
      analyzeWaterTelemetry(telemetryState.samples, cfg, telemetryState.mode);

    // 1. Source indicator, Sensor Quality badge & controls
    const sourceBadge = document.getElementById('dashSourceBadge');
    const qualityBadge = document.getElementById('dashQualityBadge');
    const sourceDetail = document.getElementById('dashSourceDetail');
    const btnConnect = document.getElementById('btnConnectArduino');
    const btnDisconnect = document.getElementById('btnDisconnectArduino');
    const btnSimToggle = document.getElementById('btnToggleSimBackup');
    const simStrip = document.getElementById('simControlStrip');

    if (sourceBadge) {
      if (telemetryState.mode === 'LIVE') {
        sourceBadge.textContent = 'LIVE · ARDUINO USB';
        sourceBadge.className = 'source-indicator source-live';
      } else if (telemetryState.mode === 'SIMULATED') {
        sourceBadge.textContent = 'SIMULATED · BACKUP MODE';
        sourceBadge.className = 'source-indicator source-simulated';
      } else {
        sourceBadge.textContent = 'UNAVAILABLE';
        sourceBadge.className = 'source-indicator source-unavailable';
      }
    }

    if (qualityBadge) {
      qualityBadge.textContent = `Quality: ${analysis.sensorQualityLabel}`;
      qualityBadge.title = analysis.sensorQualityReason || '';
      if (analysis.sensorQuality === 'GOOD') {
        qualityBadge.className = 'source-indicator quality-good';
      } else if (analysis.sensorQuality === 'UNSTABLE') {
        qualityBadge.className = 'source-indicator quality-unstable';
      } else if (analysis.sensorQuality === 'OUT_OF_RANGE') {
        qualityBadge.className = 'source-indicator quality-out-of-range';
      } else {
        qualityBadge.className = 'source-indicator quality-unavailable';
      }
    }

    if (sourceDetail) {
      sourceDetail.textContent = telemetryState.connectionText;
    }

    if (btnConnect) btnConnect.classList.toggle('hidden', arduinoClient.connected);
    if (btnDisconnect) btnDisconnect.classList.toggle('hidden', !arduinoClient.connected);

    if (btnSimToggle) {
      btnSimToggle.disabled = arduinoClient.connected;
      btnSimToggle.textContent =
        telemetryState.mode === 'SIMULATED' ? 'Stop Simulation' : 'Start Simulation Backup';
    }

    if (simStrip) {
      simStrip.classList.toggle('hidden', telemetryState.mode !== 'SIMULATED');
    }

    // 2. Flood status card (NORMAL Green, WARNING Orange, CRITICAL Red, OUT OF RANGE Red, UNAVAILABLE Slate)
    const statusCard = document.getElementById('cardFloodStatus');
    const statusVal = document.getElementById('dashStatusValue');
    const statusMeta = document.getElementById('dashStatusMeta');
    const etaWarnThresh = document.getElementById('dashEtaWarnThresh');
    const etaCritThresh = document.getElementById('dashEtaCritThresh');

    if (etaWarnThresh) etaWarnThresh.textContent = Number(cfg.warnThresholdCm).toFixed(1);
    if (etaCritThresh) etaCritThresh.textContent = Number(cfg.critThresholdCm).toFixed(1);

    if (statusCard && statusVal) {
      statusCard.className = 'metric-card';
      if (analysis.status === 'NORMAL') {
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
      if (analysis.status === 'OUT_OF_RANGE') {
        statusMeta.textContent =
          analysis.sensorQualityReason || 'Ultrasonic echoes out of range — not interpreted as 0 cm';
      } else {
        statusMeta.innerHTML =
          `Prototype thresholds: Warn &ge; <span id="dashWarnValLabel">${Number(cfg.warnThresholdCm).toFixed(1)}</span> cm &middot; ` +
          `Crit &ge; <span id="dashCritValLabel">${Number(cfg.critThresholdCm).toFixed(1)}</span> cm`;
      }
    }

    // 3. Filtered Water Level (cm) with exact mathematical consistency & separate raw reading line
    const depthEl = document.getElementById('dashDepthCm');
    const depthFormulaEl = document.getElementById('dashDepthFormula');
    const rawLineEl = document.getElementById('dashRawReadingLine');

    if (depthEl) {
      depthEl.textContent =
        analysis.available && analysis.filteredDepthCm != null
          ? analysis.filteredDepthCm.toFixed(2)
          : '--';
    }

    if (depthFormulaEl) {
      if (analysis.available && analysis.filteredDistanceCm != null && analysis.filteredDepthCm != null) {
        const mountStr = analysis.mountHeightCm.toFixed(2);
        const fDistStr = analysis.filteredDistanceCm.toFixed(2);
        const fDepthStr = analysis.filteredDepthCm.toFixed(2);
        if (analysis.filteredDistanceCm > analysis.mountHeightCm) {
          depthFormulaEl.textContent = `Mount ${mountStr} − Filtered ${fDistStr} = 0.00 cm (dry floor)`;
        } else {
          depthFormulaEl.textContent = `Mount ${mountStr} − Filtered ${fDistStr} = ${fDepthStr} cm`;
        }
      } else if (analysis.status === 'OUT_OF_RANGE') {
        depthFormulaEl.textContent = 'Invalid distance — not shown as 0.00 cm';
      } else {
        depthFormulaEl.textContent = 'Filtered Depth = Mount − Filtered Dist';
      }
    }

    if (rawLineEl) {
      rawLineEl.className = 'metric-subtext mono-text raw-reading-subtext';
      if (analysis.rawReadingStatus === 'OUT_OF_RANGE') {
        rawLineEl.classList.add('raw-reading-flagged');
        rawLineEl.textContent =
          analysis.rawDistanceCm != null
            ? `Raw: Dist ${analysis.rawDistanceCm.toFixed(2)} cm (Out of Range — rejected)`
            : 'Raw: Ultrasonic timeout (Out of Range)';
      } else if (analysis.rawReadingStatus === 'SPIKE_REJECTED') {
        rawLineEl.classList.add('raw-reading-spike');
        rawLineEl.textContent =
          analysis.rawDistanceCm != null
            ? `Raw: Dist ${analysis.rawDistanceCm.toFixed(2)} cm (Isolated spike rejected)`
            : 'Raw: Isolated spike rejected';
      } else if (analysis.rawDistanceCm != null && analysis.rawDepthCm != null) {
        rawLineEl.textContent = `Raw: Dist ${analysis.rawDistanceCm.toFixed(2)} cm → ${analysis.rawDepthCm.toFixed(2)} cm`;
      } else {
        rawLineEl.textContent = 'Latest raw sensor: --';
      }
    }

    // 4. Water-Level Trend (Statistically validated; reports Falling Water without claiming pump state)
    const trendValEl = document.getElementById('dashTrendValue');
    const trendMetaEl = document.getElementById('dashTrendMeta');
    if (trendValEl) {
      trendValEl.className = 'metric-trend-text';
      if (analysis.trend === 'UNAVAILABLE') {
        trendValEl.classList.add('trend-unavailable');
        trendValEl.textContent = 'Unavailable';
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
          analysis.trendLabel === 'Collecting baseline…' ? 'Collecting baseline…' : '? Uncertain';
      }
    }
    if (trendMetaEl) {
      trendMetaEl.textContent = analysis.trendDetail || 'Waiting for timestamped measurements';
    }

    // 5. Rate of Change (cm/min) — shown only when sensor quality is Good and baseline collected
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
      if (telemetryState.mode === 'UNAVAILABLE') {
        rateMetaEl.textContent = 'Causal median & spike rejection active';
      } else if (analysis.sensorQuality === 'OUT_OF_RANGE') {
        rateMetaEl.textContent = 'Rate paused — ultrasonic reading out of range';
      } else if (analysis.sensorQuality === 'UNSTABLE') {
        rateMetaEl.textContent = analysis.sensorQualityReason || 'Rate paused — signal unstable';
      } else if (analysis.rateCmPerMin == null) {
        rateMetaEl.textContent = `Collecting clean window (${Math.min(5, analysis.sampleCount)}/5 samples over 4s)`;
      } else {
        rateMetaEl.textContent = `Window: ${Math.min(10, analysis.sampleCount)} clean · R² = ${analysis.rSquared.toFixed(2)} · t = ${analysis.tStat.toFixed(1)}`;
      }
    }

    // 6. Early-Warning Threshold ETA (Strictly disabled unless Good quality + reliable rise)
    const etaWarnEl = document.getElementById('dashEtaWarnVal');
    const etaCritEl = document.getElementById('dashEtaCritVal');
    const etaNoteEl = document.getElementById('dashEtaNote');
    if (etaWarnEl) {
      etaWarnEl.textContent = analysis.etaWarning.label;
      etaWarnEl.className =
        'eta-val' +
        (analysis.etaWarning.reached
          ? ' eta-reached'
          : analysis.etaWarning.available
          ? ' eta-active'
          : '');
    }
    if (etaCritEl) {
      etaCritEl.textContent = analysis.etaCritical.label;
      etaCritEl.className =
        'eta-val' +
        (analysis.etaCritical.reached
          ? ' eta-reached'
          : analysis.etaCritical.available
          ? ' eta-active'
          : '');
    }
    if (etaNoteEl) {
      if (analysis.sensorQuality === 'OUT_OF_RANGE' || analysis.sensorQuality === 'UNSTABLE') {
        etaNoteEl.textContent = `ETA suppressed while sensor quality is ${analysis.sensorQualityLabel}.`;
      } else {
        etaNoteEl.textContent =
          'Mathematical projection only — shown only when sensor quality is Good and water rises reliably.';
      }
    }

    // 7. Hardware Details Strip
    const hwQuality = document.getElementById('hwSensorQualityVal');
    const hwFilteredDist = document.getElementById('hwFilteredDistanceVal');
    const hwDist = document.getElementById('hwDistanceVal');
    const hwMount = document.getElementById('hwMountHeightVal');
    const hwFloatLow = document.getElementById('hwFloatLowVal');
    const hwFloatHigh = document.getElementById('hwFloatHighVal');
    const hwBarrier = document.getElementById('hwBarrierStateVal');
    const hwSupabase = document.getElementById('hwSupabaseDemoStatus');

    if (hwQuality) {
      hwQuality.textContent = analysis.sensorQualityLabel;
    }
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
      hwMount.textContent = `${Number(analysis.mountHeightCm || cfg.mountHeightCm).toFixed(2)} cm`;
    }

    const formatFloatState = (val) => {
      if (telemetryState.mode === 'UNAVAILABLE' || val === null) return 'Not connected';
      const suffix = telemetryState.mode === 'SIMULATED' ? ' (Simulated)' : '';
      return val ? `Triggered${suffix}` : `Dry${suffix}`;
    };
    if (hwFloatLow) hwFloatLow.textContent = formatFloatState(telemetryState.latestHardware.floatLow);
    if (hwFloatHigh) hwFloatHigh.textContent = formatFloatState(telemetryState.latestHardware.floatHigh);
    if (hwBarrier) {
      const bState = telemetryState.latestHardware.barrierState;
      hwBarrier.textContent =
        bState && bState !== 'not_installed'
          ? `${bState} (Optional)`
          : 'Not installed (Planned optional extension)';
    }
    if (hwSupabase) {
      hwSupabase.textContent = supabaseDemoState.summaryText;
    }

    drawWaterHistoryChart();
  }

  function drawWaterHistoryChart() {
    const canvas = document.getElementById('floodHistoryCanvas');
    const emptyOverlay = document.getElementById('dashChartEmptyOverlay');
    if (!canvas) return;

    const cfg = prototypeSettingsState.values;
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

    const pad = { top: 24, right: 24, bottom: 34, left: 52 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const maxPoint = points.length > 0 ? Math.max(...points.map((p) => p.filteredDepthCm)) : 0;
    const maxY = Math.max(cfg.critThresholdCm * 1.35, maxPoint * 1.15, 16);

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
      ctx.fillText(`${val.toFixed(0)} cm`, 6, y + 4);
    }

    // Warning Threshold Dashed Line (Orange)
    const yWarn = pad.top + plotH - (cfg.warnThresholdCm / maxY) * plotH;
    ctx.save();
    ctx.strokeStyle = '#EA580C';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, yWarn);
    ctx.lineTo(pad.left + plotW, yWarn);
    ctx.stroke();
    ctx.fillStyle = '#C2410C';
    ctx.fillText(`Warning (${cfg.warnThresholdCm.toFixed(1)} cm)`, pad.left + 8, Math.max(pad.top + 12, yWarn - 6));

    // Critical Threshold Dashed Line (Red)
    const yCrit = pad.top + plotH - (cfg.critThresholdCm / maxY) * plotH;
    ctx.strokeStyle = '#DC2626';
    ctx.beginPath();
    ctx.moveTo(pad.left, yCrit);
    ctx.lineTo(pad.left + plotW, yCrit);
    ctx.stroke();
    ctx.fillStyle = '#B91C1C';
    ctx.fillText(`Critical (${cfg.critThresholdCm.toFixed(1)} cm)`, pad.left + 8, Math.max(pad.top + 12, yCrit - 6));
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

    // Subtle area fill under depth curve
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(coords[0].x, pad.top + plotH);
    coords.forEach((c) => ctx.lineTo(c.x, c.y));
    ctx.lineTo(coords[coords.length - 1].x, pad.top + plotH);
    ctx.closePath();
    ctx.fillStyle =
      telemetryState.mode === 'LIVE'
        ? 'rgba(8, 145, 178, 0.14)'
        : 'rgba(234, 88, 12, 0.12)';
    ctx.fill();
    ctx.restore();

    // Water-depth line
    ctx.save();
    ctx.strokeStyle = telemetryState.mode === 'LIVE' ? '#0891B2' : '#EA580C';
    ctx.lineWidth = 2.4;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    coords.forEach((c, idx) => {
      if (idx === 0) ctx.moveTo(c.x, c.y);
      else ctx.lineTo(c.x, c.y);
    });
    ctx.stroke();

    // Point markers
    coords.forEach((c, idx) => {
      const isLast = idx === coords.length - 1;
      ctx.beginPath();
      ctx.arc(c.x, c.y, isLast ? 4.5 : 2.6, 0, Math.PI * 2);
      ctx.fillStyle = isLast ? '#0A192F' : telemetryState.mode === 'LIVE' ? '#0891B2' : '#EA580C';
      ctx.fill();
    });
    ctx.restore();

    // X-axis time labels (first, middle, last)
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

    // Dashboard: Arduino USB Serial & Simulation Backup Controls
    document.getElementById('btnConnectArduino')?.addEventListener('click', async () => {
      if (!isWebSerialSupported()) {
        setDashboardNotice(
          'Web Serial is not supported in this browser. Open NYC FloodGuard in desktop Chrome or Microsoft Edge to connect your Arduino GIGA R1 WiFi over USB, or use Simulation Backup.',
          'warn'
        );
        return;
      }
      await arduinoClient.connect();
    });

    document.getElementById('btnDisconnectArduino')?.addEventListener('click', async () => {
      await arduinoClient.disconnect();
    });

    document.getElementById('btnToggleSimBackup')?.addEventListener('click', () => {
      if (telemetryState.mode === 'SIMULATED') {
        stopSimulationBackup(true);
      } else {
        startSimulationBackup();
      }
    });

    document.getElementById('btnSimRise')?.addEventListener('click', () => {
      telemetryState.simScenario = 'RISING';
      showToast('Backup simulation: Water level rising.', 'WARNING');
    });

    document.getElementById('btnSimDrain')?.addEventListener('click', () => {
      telemetryState.simScenario = 'FALLING';
      if (telemetryState.simCurrentDepthCm < 2.0) {
        telemetryState.simCurrentDepthCm = 10.5;
      }
      showToast('Backup simulation: Water level falling.', 'NORMAL');
    });

    document.getElementById('btnSimSteady')?.addEventListener('click', () => {
      telemetryState.simScenario = 'STEADY';
      showToast('Backup simulation: Water level holding steady.', 'NORMAL');
    });

    document.getElementById('btnSimResetDry')?.addEventListener('click', () => {
      telemetryState.simScenario = 'STEADY';
      telemetryState.simCurrentDepthCm = 0;
      telemetryState.samples = [];
      recalculateTelemetryAndRender();
      showToast('Backup simulation reset to dry floor (0.00 cm).', 'NORMAL');
    });

    document.getElementById('btnClearChartHistory')?.addEventListener('click', () => {
      telemetryState.samples = [];
      recalculateTelemetryAndRender();
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

    document.getElementById('btnResetDefaultSettings')?.addEventListener('click', () => {
      if (!isVerifiedAdmin()) return;
      document.getElementById('cfgMountHeightCm').value = DEFAULT_PROTOTYPE_SETTINGS.mountHeightCm.toFixed(1);
      document.getElementById('cfgWarnThresholdCm').value = DEFAULT_PROTOTYPE_SETTINGS.warnThresholdCm.toFixed(1);
      document.getElementById('cfgCritThresholdCm').value = DEFAULT_PROTOTYPE_SETTINGS.critThresholdCm.toFixed(1);
      document.getElementById('cfgMinRiseRate').value = DEFAULT_PROTOTYPE_SETTINGS.minRiseRateCmPerMin.toFixed(2);
      document.getElementById('cfgBarrierThresholdCm').value = DEFAULT_PROTOTYPE_SETTINGS.barrierThresholdCm.toFixed(1);
      showToast('Default prototype values populated — click Save Settings to persist to Supabase.', 'NORMAL');
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
      if (activeView === 'realdata') {
        loadRealFloodData({ refreshMetadata: !realFloodState.metadataLoaded });
      }
    });
    window.addEventListener('offline', syncOnlineBanner);
    window.addEventListener('resize', () => {
      if (activeView === 'dashboard') drawWaterHistoryChart();
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
    recalculateTelemetryAndRender();
    startLiveStaleWatchdog();
    initAuthentication();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
