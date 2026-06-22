// Background service worker
// START flow: check if logged in → if not, open login page → auto-fill → wait for login → start monitoring
// Monitor flow: periodic alarm → content script checks via same XHR as calendar
// Re-login: session expire → auto re-login using saved credentials

const LOGIN_URL = 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in';
const SITE_URL = 'https://ais.usvisa-info.com/en-ca/niv';

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(restoreIfActive);
}

// Open side panel when extension icon is clicked
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch(function(e) { console.error('sidePanel setup error:', e); });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['credentials', 'config', 'schedule', 'telegram', 'notifications'], (existing) => {
    chrome.storage.local.set({
      monitoring: false,
      config: existing.config || null,
      credentials: existing.credentials || null,
      schedule: existing.schedule || null,
      telegram: existing.telegram || null,
      notifications: existing.notifications || null,
      stats: { checks: 0, slotsFound: 0, lastCheck: null },
      log: [],
      bookingState: null,
      sessionCleared: false,
      loginClearInProgress: false,
      loginInProgress: false,
      freshLoginTabId: null
    });
  });
});

function restoreIfActive() {
  chrome.storage.local.get(['monitoring'], (data) => {
    if (data.monitoring) {
      chrome.alarms.get('check-slots', (a) => {
        if (!a) {
          addLog('Resumed after Chrome restart');
          scheduleNext();
        }
      });
    }
  });
}
restoreIfActive();

// ==================== MESSAGE HANDLING ====================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'START_MONITORING':
      startMonitoring(msg.config);
      sendResponse({ ok: true });
      break;
    case 'STOP_MONITORING':
      stopMonitoring();
      sendResponse({ ok: true });
      break;
    case 'GET_STATUS':
      chrome.storage.local.get(['monitoring', 'config', 'stats', 'log'], (d) => sendResponse(d));
      return true;
    case 'SLOT_FOUND':
      handleSlotFound(msg.data);
      sendResponse({ ok: true });
      break;
    case 'BOOKING_RESULT':
      handleBookingResult(msg.data);
      sendResponse({ ok: true });
      break;
    case 'CHECK_COMPLETE':
      handleCheckComplete(msg.data);
      sendResponse({ ok: true });
      break;
    case 'RATE_LIMITED':
      addLog('Rate limited! Waiting 30 min before next check.');
      sendTelegram('⚠️ <b>Rate Limited!</b>\nPausing for 30 minutes.');
      chrome.alarms.create('check-slots', { delayInMinutes: 30 });
      sendResponse({ ok: true });
      break;
    case 'PAGE_READY':
      handlePageReady(msg, sender);
      sendResponse({ ok: true });
      break;
    case 'LOGIN_SUCCESS':
      handleLoginSuccess();
      sendResponse({ ok: true });
      break;
    case 'LOGIN_FAILED':
      handleLoginFailed(msg.reason);
      sendResponse({ ok: true });
      break;
    case 'LOG':
      addLog(msg.text);
      sendResponse({ ok: true });
      break;
    case 'NATIVE_MOUSE':
      sendNativeMouse(msg.cmd, msg.payload, sendResponse);
      return true;
    default:
      sendResponse({ ok: false });
  }
  return false;
});

// ==================== NATIVE MOUSE BRIDGE ====================
// Communicates with Python native host that controls real OS cursor.
// Native host must be installed via native_host/install.bat

var nativePort = null;
var nativeQueue = [];
var nativeReady = false;

function connectNative() {
  if (nativePort) return;
  try {
    nativePort = chrome.runtime.connectNative('com.sardarji.visa_helper');
    nativePort.onMessage.addListener((response) => {
      if (response.type === 'ready') {
        nativeReady = true;
        addLog('Native mouse host ready (screen ' + response.screen[0] + 'x' + response.screen[1] + ')');
        // Flush queue
        while (nativeQueue.length > 0) {
          const item = nativeQueue.shift();
          item.callback(response);
        }
        return;
      }
      // Match with oldest queued request
      if (nativeQueue.length > 0) {
        const item = nativeQueue.shift();
        item.callback(response);
      }
    });
    nativePort.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'disconnected';
      addLog('Native host disconnected: ' + err);
      nativePort = null;
      nativeReady = false;
      // Reject pending
      while (nativeQueue.length > 0) {
        const item = nativeQueue.shift();
        item.callback({ ok: false, error: 'native_disconnected' });
      }
    });
  } catch (e) {
    addLog('Native connect failed: ' + e.message);
    nativePort = null;
  }
}

function sendNativeMouse(cmd, payload, callback) {
  if (!nativePort) connectNative();
  if (!nativePort) {
    callback({ ok: false, error: 'no_native_host' });
    return;
  }
  const msg = Object.assign({ cmd: cmd }, payload || {});
  nativeQueue.push({ callback: callback });
  try {
    nativePort.postMessage(msg);
  } catch (e) {
    addLog('Native send failed: ' + e.message);
    nativeQueue.pop();
    callback({ ok: false, error: e.message });
  }
}

// Auto-connect on startup
connectNative();

// ==================== START FLOW ====================

function clearVisaSiteData() {
  return new Promise((resolve) => {
    addLog('Clearing cookies & cache...');
    let totalCleared = 0;

    // Safety timeout — never hang forever
    const timeout = setTimeout(() => {
      addLog('Cookie clear timeout, continuing...');
      resolve();
    }, 8000);

    const domains = ['ais.usvisa-info.com', '.ais.usvisa-info.com', 'usvisa-info.com', '.usvisa-info.com'];
    let domainsChecked = 0;

    domains.forEach((domain) => {
      try {
        chrome.cookies.getAll({ domain: domain }, (cookies) => {
          if (chrome.runtime.lastError) {
            addLog('Cookie err (' + domain + '): ' + chrome.runtime.lastError.message);
          }
          if (cookies && cookies.length > 0) {
            cookies.forEach((cookie) => {
              const protocol = cookie.secure ? 'https://' : 'http://';
              const url = protocol + cookie.domain.replace(/^\./, '') + cookie.path;
              chrome.cookies.remove({ url: url, name: cookie.name });
              totalCleared++;
            });
          }
          domainsChecked++;
          if (domainsChecked >= domains.length) {
            addLog('Cleared ' + totalCleared + ' cookies');
            try {
              chrome.browsingData.remove({
                origins: ['https://ais.usvisa-info.com']
              }, {
                cache: true,
                cookies: true,
                localStorage: true
              }, () => {
                clearTimeout(timeout);
                if (chrome.runtime.lastError) {
                  addLog('browsingData err: ' + chrome.runtime.lastError.message);
                }
                addLog('Cache & storage cleared');
                resolve();
              });
            } catch (e) {
              clearTimeout(timeout);
              addLog('browsingData exception: ' + e.message);
              resolve();
            }
          }
        });
      } catch (e) {
        domainsChecked++;
        addLog('Cookie exception (' + domain + '): ' + e.message);
        if (domainsChecked >= domains.length) {
          clearTimeout(timeout);
          resolve();
        }
      }
    });
  });
}

function startMonitoring(config) {
  chrome.storage.local.set({
    monitoring: true,
    config: config,
    stats: { checks: 0, slotsFound: 0, lastCheck: null },
    alertedSlots: {},
    loginAttempts: 0,
    sessionCleared: false,
    loginClearInProgress: false,
    loginInProgress: false,
    freshLoginTabId: null
  });

  addLog('Starting... ' + config.facilityName + ' (' + config.dateFrom + ' → ' + config.dateTo + ')');

  // Don't clear cookies here — only clear before login (new session start)
  beginMonitoringLoop();
}

function findOrCreateVisaTab(callback) {
  chrome.tabs.query({ url: 'https://ais.usvisa-info.com/*' }, (tabs) => {
    if (chrome.runtime.lastError) {
      addLog('Tab query error: ' + chrome.runtime.lastError.message);
    }
    if (tabs && tabs.length > 0) {
      addLog('Found existing visa tab');
      chrome.tabs.update(tabs[0].id, { active: true }, () => {
        callback(tabs[0]);
      });
    } else {
      addLog('Opening visa site...');
      chrome.tabs.create({ url: LOGIN_URL, active: true }, (tab) => {
        if (chrome.runtime.lastError) {
          addLog('Tab create error: ' + chrome.runtime.lastError.message);
          return;
        }
        addLog('Tab created, waiting for load...');
        chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
          if (tabId === tab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            addLog('Page loaded');
            callback(tab);
          }
        });
      });
    }
  });
}

function checkLoginAndProceed(tab) {
  // Ask content script what page we're on
  chrome.tabs.sendMessage(tab.id, { type: 'WHAT_PAGE' }, (resp) => {
    if (chrome.runtime.lastError) {
      // Content script not ready yet, wait and retry
      addLog('Page loading...');
      setTimeout(() => checkLoginAndProceed(tab), 3000);
      return;
    }

    const loggedInPages = ['logged-in', 'appointment', 'groups', 'continue-actions'];
    if (resp && loggedInPages.includes(resp.page)) {
      addLog('Already logged in!');
      ensureScheduleAndMonitor(tab);
    }
    else if (resp && resp.page === 'login') {
      // On login page → auto-fill and submit
      addLog('Login page detected. Auto-filling...');
      chrome.storage.local.get(['credentials'], (data) => {
        if (data.credentials) {
          sendLoginWithRetry(tab.id, data.credentials, 0);
        } else {
          addLog('No credentials saved. Enter email/password in popup.');
        }
      });
    }
    else {
      // Unknown page or redirect needed → go to login
      addLog('Navigating to login page...');
      chrome.tabs.update(tab.id, { url: LOGIN_URL }, () => {
        chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
          if (tabId === tab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            setTimeout(() => checkLoginAndProceed(tab), 2000);
          }
        });
      });
    }
  });
}

function closeOldVisaTabs(freshTabId) {
  chrome.tabs.query({ url: 'https://ais.usvisa-info.com/*' }, (tabs) => {
    if (chrome.runtime.lastError) {
      addLog('Old tab query error: ' + chrome.runtime.lastError.message);
      return;
    }

    const oldTabIds = (tabs || [])
      .map((tab) => tab.id)
      .filter((tabId) => tabId && tabId !== freshTabId);

    if (oldTabIds.length === 0) return;

    chrome.tabs.remove(oldTabIds, () => {
      if (chrome.runtime.lastError) {
        addLog('Old tab close error: ' + chrome.runtime.lastError.message);
      } else {
        addLog('Closed old visa tab(s): ' + oldTabIds.length);
      }
    });
  });
}

// Clean single-step fresh login:
//   clear the visa data ONCE -> reuse one tab (or open one if none) -> load the
//   login page. No double-clearing, no tab open/close flashing. When the login
//   page then loads, handlePageReady sees the cleaned fresh tab and submits.
function openFreshLoginSession(reason) {
  chrome.storage.local.get(['loginClearInProgress', 'loginInProgress', 'credentials'], (data) => {
    if (data.loginClearInProgress || data.loginInProgress) {
      addLog('Login already starting; ignoring duplicate trigger');
      return;
    }
    if (!data.credentials) {
      addLog('No credentials saved. Enter email/password first.');
      scheduleNext();
      return;
    }

    addLog((reason || 'Starting login') + ' — clearing visa data...');
    chrome.storage.local.set({
      sessionCleared: false,
      loginClearInProgress: true,
      loginInProgress: false,
      freshLoginTabId: null
    });

    clearVisaSiteData().then(() => {
      // Open the login page in a single tab (reuse an existing visa tab if any).
      const goToLogin = (tabId) => {
        chrome.storage.local.set({
          sessionCleared: true,
          loginClearInProgress: false,
          loginInProgress: false,
          freshLoginTabId: tabId
        }, () => {
          chrome.tabs.update(tabId, { url: LOGIN_URL, active: true }, () => {
            if (chrome.runtime.lastError) {
              addLog('Login open error: ' + chrome.runtime.lastError.message);
              chrome.storage.local.set({ sessionCleared: false, freshLoginTabId: null });
              scheduleNext();
            }
          });
        });
      };

      chrome.tabs.query({ url: 'https://ais.usvisa-info.com/*' }, (tabs) => {
        if (tabs && tabs.length) {
          // Reuse the first visa tab; close any extras so only one remains.
          const keep = tabs[0].id;
          const extras = tabs.slice(1).map((t) => t.id);
          if (extras.length) chrome.tabs.remove(extras);
          goToLogin(keep);
        } else {
          chrome.tabs.create({ url: 'about:blank', active: true }, (tab) => {
            if (chrome.runtime.lastError || !tab || !tab.id) {
              addLog('Tab create error.');
              chrome.storage.local.set({ loginClearInProgress: false });
              scheduleNext();
              return;
            }
            goToLogin(tab.id);
          });
        }
      });
    });
  });
}

// The session is already clean (openFreshLoginSession handled it). Just send the
// login command. `attempt` is the content-script-readiness retry counter.
function sendLoginWithRetry(tabId, credentials, attempt) {
  if (attempt > 0) {
    actuallySendLogin(tabId, credentials, attempt);
    return;
  }
  chrome.storage.local.get(['loginInProgress'], (data) => {
    if (data.loginInProgress) {
      addLog('Login already in progress; ignoring duplicate trigger');
      return;
    }
    chrome.storage.local.set({ loginInProgress: true }, () => {
      actuallySendLogin(tabId, credentials, 0);
    });
  });
}

function actuallySendLogin(tabId, credentials, attempt) {
  chrome.tabs.sendMessage(tabId, {
    type: 'DO_LOGIN',
    email: credentials.email,
    password: credentials.password
  }, (resp) => {
    if (chrome.runtime.lastError) {
      if (attempt < 5) {
        addLog('Content script not ready, retry ' + (attempt + 1) + '...');
        setTimeout(() => actuallySendLogin(tabId, credentials, attempt + 1), 2000);
      } else {
        addLog('Could not reach content script after retries.');
        chrome.storage.local.set({ loginInProgress: false });
      }
    } else {
      addLog('Login command sent.');
    }
  });
}

function handlePageReady(msg, sender) {
  chrome.storage.local.get(['monitoring'], (data) => {
    if (!data.monitoring) return;

    // Reaching any logged-in page means the login attempt concluded
    // successfully. The submitting content script was destroyed on navigation
    // and could not report it, so clear the flags here.
    const loggedInPages = ['appointment', 'groups', 'continue-actions', 'logged-in'];
    if (loggedInPages.includes(msg.page)) {
      chrome.storage.local.set({ loginInProgress: false, loginClearInProgress: false, loginAttempts: 0 });
    }

    if (msg.page === 'login') {
      addLog('On login page.');
      chrome.storage.local.get(['credentials', 'sessionCleared', 'loginClearInProgress', 'loginInProgress', 'freshLoginTabId'], (d) => {
        // Back on the login page while an attempt was in progress = that attempt
        // failed (submit returned us to login). The content script that
        // submitted was torn down on navigation, so the result is detected here
        // from the fresh page. Clear the stuck flag and handle the failure.
        if (d.loginInProgress) {
          chrome.storage.local.set({ loginInProgress: false });
          // We submitted and landed back on the login page = the website
          // rejected it. Use its exact message if we have one, else say so.
          const reason = msg.captcha ? 'CAPTCHA on login page'
                                     : (msg.loginError || 'Invalid email or password');
          handleLoginFailed(reason);
          return;
        }
        if (!d.credentials) {
          addLog('No credentials saved.');
          return;
        }
        const isFreshLoginTab = d.freshLoginTabId && sender.tab && d.freshLoginTabId === sender.tab.id;
        if (isFreshLoginTab && d.sessionCleared) {
          // Clean, freshly-cleared login page → just log in.
          addLog('Auto-logging in...');
          sendLoginWithRetry(sender.tab.id, d.credentials, 0);
        } else if (d.loginClearInProgress) {
          addLog('Login already starting.');
        } else {
          // Landed on login without a clean session → do the one-time clean.
          openFreshLoginSession('Session expired');
        }
      });
    }
    else if (msg.page === 'groups') {
      addLog('On Groups page. Content script clicking Continue...');
    }
    else if (msg.page === 'continue-actions') {
      addLog('On Continue Actions page. Saving schedule ID & clicking Schedule Appointment...');
      // URL has schedule ID — extract and save while page navigates
      const m = msg.url.match(/schedule\/(\d+)/);
      if (m) {
        chrome.storage.local.get(['config'], (d) => {
          const c = d.config || {};
          c.scheduleId = m[1];
          chrome.storage.local.set({ config: c }, () => {
            addLog('Schedule ID saved: ' + m[1]);
          });
        });
      }
    }
    else if (msg.page === 'appointment') {
      addLog('On Appointment page (calendar ready).');
      const m = msg.url.match(/schedule\/(\d+)/);
      if (m) {
        chrome.storage.local.get(['config'], (d) => {
          const c = d.config || {};
          const wasNew = c.scheduleId !== m[1];
          c.scheduleId = m[1];
          chrome.storage.local.set({ config: c }, () => {
            addLog('Schedule ID: ' + m[1]);
            // Only start loop if not already running
            chrome.alarms.get('check-slots', (a) => {
              if (!a) {
                addLog('Starting monitor loop...');
                beginMonitoringLoop();
              } else {
                addLog('Monitor loop already running.');
              }
            });
          });
        });
      }
    }
    else if (msg.page === 'logged-in') {
      addLog('Logged in. Finding schedule...');
      ensureScheduleAndMonitor(sender.tab);
    }
    else {
      addLog('Unknown page. Redirecting to login...');
      chrome.tabs.update(sender.tab.id, { url: LOGIN_URL });
    }
  });
}

function ensureScheduleAndMonitor(tab) {
  addLog('ensureSchedule: asking content script...');
  chrome.tabs.sendMessage(tab.id, { type: 'FIND_SCHEDULE' }, (resp) => {
    if (chrome.runtime.lastError) {
      addLog('Content script not ready: ' + chrome.runtime.lastError.message);
      setTimeout(() => ensureScheduleAndMonitor(tab), 3000);
      return;
    }

    addLog('FIND_SCHEDULE response: ' + JSON.stringify(resp));

    if (resp && resp.scheduleId) {
      chrome.storage.local.get(['config'], (data) => {
        const config = data.config || {};
        config.scheduleId = resp.scheduleId;
        chrome.storage.local.set({ config }, () => {
          addLog('Schedule ID saved: ' + resp.scheduleId + '. Starting monitor loop...');
          beginMonitoringLoop();
        });
      });
    } else {
      addLog('Schedule ID not found. Trying GO_TO_SCHEDULE...');
      chrome.tabs.sendMessage(tab.id, { type: 'GO_TO_SCHEDULE' }, (r) => {
        if (chrome.runtime.lastError) {
          addLog('GO_TO_SCHEDULE failed: ' + chrome.runtime.lastError.message);
        } else {
          addLog('GO_TO_SCHEDULE sent. Waiting for page navigation...');
        }
      });
    }
  });
}

// Transient login problems (timeout/no response/network) get retried up to
// this many times; credential/captcha rejections never retry.
const MAX_TRANSIENT_RETRIES = 3;

function handleLoginFailed(reason) {
  chrome.storage.local.set({ loginInProgress: false, loginClearInProgress: false });
  const msg = reason || 'Login failed';
  const r = msg.toLowerCase();

  // FATAL: the website rejected the credentials, or a captcha is blocking. No
  // amount of retrying helps, and retrying wrong credentials risks a lockout.
  const fatal =
    r.includes('invalid') || r.includes('incorrect') || r.includes('password') ||
    r.includes('locked') || r.includes('captcha') || r.includes('email or password');
  if (fatal) {
    chrome.storage.local.set({ loginAttempts: 0 });
    if (r.includes('captcha')) {
      addLog('CAPTCHA on login page — cannot log in automatically. Log in manually once, then restart.');
      sendTelegram('🔴 <b>CAPTCHA blocked login</b>\n' + msg + '\nLog in manually, then restart monitoring.');
    } else {
      addLog('STOPPED — login rejected by website: "' + msg + '". No retry. Fix credentials, then start again.');
      sendTelegram('🔴 <b>Login failed</b>\nWebsite said: ' + msg + '\nMonitoring stopped — fix credentials and restart.');
    }
    stopMonitoring();
    return;
  }

  // TRANSIENT: timeout / no response / unexpected page / network. These can
  // clear up, so restart the login process — but cap it so it can't loop forever.
  chrome.storage.local.get(['loginAttempts'], (d) => {
    const attempts = (d.loginAttempts || 0) + 1;
    chrome.storage.local.set({ loginAttempts: attempts });
    if (attempts > MAX_TRANSIENT_RETRIES) {
      addLog('Login kept failing (' + msg + ') after ' + MAX_TRANSIENT_RETRIES + ' retries. Stopping.');
      sendTelegram('🔴 <b>Login keeps timing out</b>\nReason: ' + msg + '\nMonitoring stopped.');
      chrome.storage.local.set({ loginAttempts: 0 });
      stopMonitoring();
      return;
    }
    addLog('Transient login issue ("' + msg + '") — restarting login (try ' + attempts + '/' + MAX_TRANSIENT_RETRIES + ')...');
    setTimeout(() => openFreshLoginSession('Retry after: ' + msg), 5000);
  });
}

function handleLoginSuccess() {
  chrome.storage.local.set({
    loginInProgress: false,
    loginClearInProgress: false,
    sessionCleared: true,
    freshLoginTabId: null,
    loginAttempts: 0
  });
  addLog('Login successful!');
  setTimeout(() => beginMonitoringLoop(), 3000);
}

function beginMonitoringLoop() {
  addLog('Monitoring active');
  // First check right away
  chrome.alarms.create('check-slots', { delayInMinutes: 0.15 });
}

function stopMonitoring() {
  chrome.alarms.clear('check-slots');
  chrome.alarms.clear('keep-alive');
  chrome.storage.local.set({
    monitoring: false,
    bookingState: null,
    loginInProgress: false,
    loginClearInProgress: false,
    loginAttempts: 0,
    freshLoginTabId: null
  });
  // Tell any open visa tab to abort an in-progress login/booking immediately,
  // so the native mouse/keyboard stops the moment STOP is pressed.
  chrome.tabs.query({ url: 'https://ais.usvisa-info.com/*' }, (tabs) => {
    (tabs || []).forEach((t) => {
      try { chrome.tabs.sendMessage(t.id, { type: 'ABORT' }, () => void chrome.runtime.lastError); } catch (e) {}
    });
  });
  addLog('Stopped');
}

// ==================== CHECK CYCLE ====================

// Server session expires after ~20 min of inactivity. If the next check is
// further out than this, we slip in a lightweight keep-alive ping so the
// session is still valid when the real check runs.
const SESSION_KEEPALIVE_MIN = 15;

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'check-slots') triggerCheck();
  else if (alarm.name === 'keep-alive') doKeepAlive();
});

function scheduleNext() {
  chrome.storage.local.get(['config'], (data) => {
    const cfg = data.config || {};
    // Interval is configured in SECONDS now.
    const lo = cfg.intervalMin || 60;
    const hi = cfg.intervalMax || 120;
    const sec = lo + Math.random() * (hi - lo);
    const minutes = sec / 60;   // chrome.alarms takes minutes
    chrome.alarms.create('check-slots', { delayInMinutes: minutes });
    addLog('Next check in ~' + Math.round(sec) + ' sec');

    // Only ping if the gap is big enough that the session could time out.
    chrome.alarms.clear('keep-alive');
    if (minutes > SESSION_KEEPALIVE_MIN) {
      // Fire roughly midway, with a little jitter so it isn't a fixed pattern.
      const ka = (minutes / 2) + (Math.random() - 0.5) * 2;
      chrome.alarms.create('keep-alive', { delayInMinutes: Math.max(8, ka) });
      addLog('Keep-alive ping in ~' + Math.round(ka) + ' min');
    }
  });
}

// Send a quiet request to keep the visa-site session warm. Does NOT count as a
// slot check and only runs while monitoring is active and we're logged in.
function doKeepAlive() {
  chrome.storage.local.get(['monitoring'], (data) => {
    if (!data.monitoring) return;
    chrome.tabs.query({ url: 'https://ais.usvisa-info.com/*' }, (tabs) => {
      if (!tabs.length) return;
      const tab = tabs[0];
      chrome.tabs.sendMessage(tab.id, { type: 'WHAT_PAGE' }, (resp) => {
        if (chrome.runtime.lastError) return;
        const loggedIn = resp &&
          ['logged-in', 'appointment', 'groups', 'continue-actions'].includes(resp.page);
        if (!loggedIn) return; // login/unknown page → leave it for the real check
        chrome.tabs.sendMessage(tab.id, { type: 'KEEP_ALIVE' }, (r) => {
          if (chrome.runtime.lastError) return;
          if (r && r.alive === false) {
            openFreshLoginSession('Session expired (keep-alive)');
          }
        });
      });
    });
  });
}

function isInActiveWindow() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['schedule'], (data) => {
      const s = data.schedule;
      if (!s || !s.enabled) { resolve(true); return; }

      const now = new Date();

      // Weekday check (0=Sun, 6=Sat)
      if (s.weekdaysOnly) {
        const day = now.getDay();
        if (day === 0 || day === 6) {
          resolve(false);
          return;
        }
      }

      const currentMin = now.getHours() * 60 + now.getMinutes();

      function parseTime(t) {
        const [h, m] = t.split(':').map(Number);
        return h * 60 + m;
      }

      function inWindow(from, to) {
        const f = parseTime(from);
        const t = parseTime(to);
        if (f <= t) {
          return currentMin >= f && currentMin <= t;
        } else {
          // Wraps midnight (e.g., 23:00 → 01:00)
          return currentMin >= f || currentMin <= t;
        }
      }

      const active = inWindow(s.win1From, s.win1To) || inWindow(s.win2From, s.win2To);
      resolve(active);
    });
  });
}

function triggerCheck() {
  chrome.storage.local.get(['monitoring'], async (data) => {
    if (!data.monitoring) return;

    const active = await isInActiveWindow();
    if (!active) {
      addLog('Outside active hours. Sleeping...');
      scheduleNext();
      return;
    }

    addLog('Active window! Starting check...');

    // DO NOT clear cookies here — would kill active session!
    // Cookies are only cleared at START. If session expires,
    // the re-login flow handles it via login page detection.

    chrome.tabs.query({ url: 'https://ais.usvisa-info.com/*' }, (tabs) => {
      if (tabs.length === 0) {
        // No tab — start one clean login flow (single tab, single clear).
        addLog('Opening visa site for check...');
        openFreshLoginSession('Starting');
        return;
      }

      const tab = tabs[0];
      // Check if we're logged in or need to re-login
      chrome.tabs.sendMessage(tab.id, { type: 'WHAT_PAGE' }, (resp) => {
        if (chrome.runtime.lastError) {
          // Content script not responding — reload tab
          openFreshLoginSession('Tab not responding');
          // PAGE_READY will handle login after reload
          return;
        }

        if (resp && resp.page === 'login') {
          // Session expired — auto re-login
          openFreshLoginSession('Session expired');
        } else if (resp && ['logged-in', 'appointment', 'groups', 'continue-actions'].includes(resp.page)) {
          // Already logged in — check slots directly
          addLog('Logged in. Checking slots...');
          chrome.tabs.sendMessage(tab.id, { type: 'DO_CHECK' }, (r) => {
            if (chrome.runtime.lastError) {
              addLog('Check failed: ' + chrome.runtime.lastError.message);
              scheduleNext();
            }
          });
        } else {
          // Unknown page — navigate to login
          addLog('Unknown page. Going to login...');
          chrome.tabs.update(tab.id, { url: LOGIN_URL });
        }
      });
    });
  });
}

function handleCheckComplete(data) {
  chrome.storage.local.get(['stats'], (stored) => {
    const stats = stored.stats || { checks: 0, slotsFound: 0 };
    stats.checks++;
    stats.lastCheck = new Date().toISOString();
    if (data.found) stats.slotsFound += data.found;
    chrome.storage.local.set({ stats });
  });

  // Session expired → auto re-login
  if (data.currentPage === 'login') {
    openFreshLoginSession('Session expired');
    return;
  }

  // Rate limited → the RATE_LIMITED handler already set a 30-min backoff alarm.
  // Do NOT reschedule here, or we'd overwrite that pause with a 10-20 min one
  // and keep hammering the server (ban risk).
  if (data.currentPage === 'rate-limited') {
    chrome.alarms.clear('keep-alive');
    return;
  }

  scheduleNext();
}

// ==================== SLOT / BOOKING ====================

// Create a desktop notification only if the user hasn't disabled them in
// settings (notifications.desktop). Telegram/log alerts still go out regardless.
function notifyDesktop(id, opts) {
  chrome.storage.local.get(['notifications'], (d) => {
    if (d.notifications && d.notifications.desktop === false) return;
    chrome.notifications.create(id, opts);
  });
}

// Don't re-alert the same date+facility more than once per hour, so a slot
// that stays available across many check cycles doesn't spam notifications.
const SLOT_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

function handleSlotFound(data) {
  const key = data.date + '|' + data.facility;
  chrome.storage.local.get(['alertedSlots'], (store) => {
    const now = Date.now();
    const alerted = store.alertedSlots || {};
    // Prune stale entries so the map can't grow forever.
    for (const k of Object.keys(alerted)) {
      if (now - alerted[k] > SLOT_ALERT_COOLDOWN_MS) delete alerted[k];
    }

    if (alerted[key] && now - alerted[key] < SLOT_ALERT_COOLDOWN_MS) {
      addLog('Slot still available (already alerted): ' + data.date + ' @ ' + data.facility);
      chrome.storage.local.set({ alertedSlots: alerted });
      return;
    }

    alerted[key] = now;
    chrome.storage.local.set({ alertedSlots: alerted });

    notifyDesktop('slot-' + Date.now(), {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'VISA SLOT AVAILABLE!',
      message: 'Date: ' + data.date + '\nFacility: ' + data.facility,
      priority: 2,
      requireInteraction: true
    });
    addLog('SLOT: ' + data.date + ' @ ' + data.facility);
    sendTelegram('🟢 <b>SLOT AVAILABLE!</b>\n📅 Date: ' + data.date + '\n🏢 Facility: ' + data.facility + '\n📋 All dates: ' + (data.allDates || []).slice(0, 5).join(', '));
    playSound();
  });
}

function handleBookingResult(data) {
  if (data.success) {
    notifyDesktop('booked-' + Date.now(), {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'BOOKED!',
      message: data.date + ' ' + data.time + ' - ' + data.facility,
      priority: 2,
      requireInteraction: true
    });
    addLog('BOOKED: ' + data.date + ' ' + data.time + ' @ ' + data.facility);
    sendTelegram('✅ <b>BOOKED SUCCESSFULLY!</b>\n📅 ' + data.date + ' ' + data.time + '\n🏢 ' + data.facility);
    stopMonitoring();
  } else {
    addLog('Booking failed. Check page.');
  }
  playSound();
}

// ==================== UTILS ====================

async function playSound() {
  try {
    const pref = await chrome.storage.local.get(['notifications']);
    if (pref.notifications && pref.notifications.sound === false) return;
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (ctx.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html', reasons: ['AUDIO_PLAYBACK'], justification: 'Alert'
      });
    }
    chrome.runtime.sendMessage({ type: 'PLAY_SOUND' });
    setTimeout(() => { chrome.offscreen.closeDocument().catch(() => {}); }, 5000);
  } catch (e) {}
}

async function sendTelegram(message) {
  try {
    const data = await chrome.storage.local.get(['telegram']);
    const t = data.telegram;
    if (!t || !t.enabled || !t.token || !t.chatId) return;
    await fetch('https://api.telegram.org/bot' + t.token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: t.chatId, text: message, parse_mode: 'HTML' })
    });
  } catch (e) {}
}

// Serialize log writes through a promise chain. Without this, rapid addLog
// calls each do an independent get→set and can clobber each other (lost lines).
let logWriteChain = Promise.resolve();
function addLog(text) {
  const entry = '[' + new Date().toLocaleTimeString() + '] ' + text;
  logWriteChain = logWriteChain.then(() => new Promise((resolve) => {
    chrome.storage.local.get(['log'], (data) => {
      const log = data.log || [];
      log.push(entry);
      if (log.length > 300) log.splice(0, log.length - 300);
      chrome.storage.local.set({ log }, resolve);
    });
  }));
}
