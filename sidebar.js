// Sidebar UI — all functions wired with null guards.
// Persists across reloads, auto-refreshes stats/log.

document.addEventListener('DOMContentLoaded', function() {
  try { init(); } catch (e) { console.error('Sidebar init error:', e); }
});

var FACILITY_NAMES = {
  '89': 'Calgary', '90': 'Halifax', '91': 'Montreal',
  '92': 'Ottawa', '93': 'Quebec City', '94': 'Toronto', '95': 'Vancouver'
};

function $(id) { return document.getElementById(id); }
function $$(sel) { return document.querySelectorAll(sel); }

// Which mode tab is showing: 'new' (fresh booking) or 'reschedule'
// (move an existing booking to an earlier date).
var activeTab = 'new';

// Local YYYY-MM-DD (toISOString shifts the date on non-UTC timezones).
function localISODate(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

// The day before a YYYY-MM-DD date, done in local components so month/year
// rollover is handled without any UTC conversion.
function dayBefore(iso) {
  var p = iso.split('-').map(Number);
  return localISODate(new Date(p[0], p[1] - 1, p[2] - 1));
}

function sanitizeHeader() {
  document.title = 'SardarJi Scheduler';
  var h1 = document.querySelector('.brand h1');
  if (h1) h1.textContent = 'SardarJi Scheduler';
  var stale = $('updateStatus');
  if (stale) stale.remove();
  var footer = $('footerVersion');
  if (footer) footer.textContent = 'SardarJi v' + ((chrome.runtime.getManifest() || {}).version || '');
}

function init() {
  sanitizeHeader();
  wireTabs();
  wireFetchBooked();
  wireBookedDateListener();
  wireAdvancedToggle();
  wireConditionalFields();
  wirePasswordToggle();
  wireTestTelegram();
  wireTestSound();
  wireSaveAdvanced();
  wireExportImport();
  wireResumeCaptcha();
  wireClearHistory();
  wireCopyLog();
  wireStartButton();
  wireStopButton();
  wireIntervalHints();
  wireBookingCelebration();
  wireJumpToBottom();
  setDateDefaults();
  loadSavedData();
  startAutoRefresh();
  startCountdownTimer();
}

// ===== Mode tabs =====
function wireTabs() {
  var btnNew = $('tabBtnNew');
  var btnRs = $('tabBtnReschedule');
  if (btnNew) btnNew.addEventListener('click', function() { setActiveTab('new'); });
  if (btnRs) btnRs.addEventListener('click', function() { setActiveTab('reschedule'); });
}

function setActiveTab(tab, skipSave) {
  var isRs = tab === 'reschedule';
  activeTab = isRs ? 'reschedule' : 'new';

  var btnNew = $('tabBtnNew');
  var btnRs = $('tabBtnReschedule');
  var panelNew = $('tabNew');
  var panelRs = $('tabReschedule');
  if (btnNew) btnNew.classList.toggle('active', !isRs);
  if (btnRs) btnRs.classList.toggle('active', isRs);
  if (panelNew) panelNew.style.display = isRs ? 'none' : 'block';
  if (panelRs) panelRs.style.display = isRs ? 'block' : 'none';

  var startBtn = $('startBtn');
  if (startBtn) startBtn.textContent = isRs ? 'START RESCHEDULE' : 'START';

  if (!skipSave) chrome.storage.local.set({ activeTab: activeTab });
}

// ===== Booked date: auto-detect after login + optional manual re-fetch =====
function updateBookedDateStatus(state, detail) {
  var el = $('rsBookedStatus');
  if (!el) return;
  el.className = 'booked-status';
  if (state === 'pending') {
    el.classList.add('pending');
    el.textContent = 'Will be auto-detected after login…';
  } else if (state === 'detected') {
    el.classList.add('detected');
    el.textContent = '✓ Auto-detected' + (detail ? ': ' + detail : '');
  } else if (state === 'error') {
    el.classList.add('error');
    el.textContent = detail || 'Could not detect booked date';
  } else {
    el.textContent = '';
  }
}

function applyDetectedBookedDate(date, opts) {
  opts = opts || {};
  var rb = $('rsBookedDate');
  if (rb) rb.value = date;
  updateBookedDateStatus('detected', date);
  chrome.storage.local.get(['reschedule', 'config'], function(d) {
    var rs = d.reschedule || {};
    rs.bookedDate = date;
    var toSet = { reschedule: rs };
    var c = d.config || {};
    if (c.mode === 'reschedule' && (opts.force || !c.bookedDate)) {
      c.bookedDate = date;
      c.dateTo = dayBefore(date);
      toSet.config = c;
    }
    chrome.storage.local.set(toSet);
  });
}

function wireBookedDateListener() {
  chrome.runtime.onMessage.addListener(function(msg) {
    if (msg && msg.type === 'BOOKED_DATE_DETECTED' && msg.date) {
      applyDetectedBookedDate(msg.date);
    }
  });
}

function wireFetchBooked() {
  var btn = $('rsFetchBooked');
  if (!btn) return;

  function reset() {
    setTimeout(function() { btn.textContent = '⟳ Re-fetch'; }, 2500);
  }

  btn.addEventListener('click', function() {
    btn.textContent = 'Fetching...';
    chrome.tabs.query({ url: 'https://ais.usvisa-info.com/*' }, function(tabs) {
      if (!tabs || !tabs.length) {
        btn.textContent = '✗ Site not open';
        reset();
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_BOOKED_DATE' }, function(resp) {
        if (chrome.runtime.lastError || !resp) {
          btn.textContent = '✗ Page not ready';
        } else if (resp.date) {
          applyDetectedBookedDate(resp.date, { force: true });
          btn.textContent = '✓ Found';
        } else {
          updateBookedDateStatus('error', 'Not found on page — log in first');
          btn.textContent = '✗ Not found';
        }
        reset();
      });
    });
  });
}

// ===== Booking celebration banner =====
// Only auto-shown for a RECENT booking (avoids surfacing a stale one from
// days ago just because the sidebar was reopened). A live push from the
// background script (BOOKING_CONFIRMED) always shows immediately regardless.
var BOOKING_CELEBRATION_WINDOW_MS = 5 * 60 * 1000;
var lastShownBookingTs = 0;

function wireBookingCelebration() {
  var closeBtn = $('closeCelebration');
  if (closeBtn) {
    closeBtn.addEventListener('click', function() {
      var el = $('bookingCelebration');
      if (el) el.style.display = 'none';
    });
  }

  chrome.runtime.onMessage.addListener(function(msg) {
    if (msg && msg.type === 'BOOKING_CONFIRMED' && msg.data) {
      lastShownBookingTs = msg.data.ts || Date.now();
      showBookingCelebration(msg.data);
    }
  });
}

function showBookingCelebration(b) {
  var el = $('bookingCelebration');
  var details = $('bookingCelebration') && document.querySelector('#bookingCelebration .bc-details');
  if (!el || !details) return;
  var title = document.querySelector('#bookingCelebration .celebration-title');
  if (title) {
    title.textContent = b.rescheduled ? 'Rescheduled to an Earlier Date!' : 'Congratulations! Slot Booked';
  }
  var text = (b.date || '') + ' ' + (b.time || '') + ' — ' + (b.facility || '');
  if (b.rescheduled && b.prevDate) text += ' (was ' + b.prevDate + ')';
  details.textContent = text;
  el.style.display = 'flex';
}

function maybeShowBookingCelebration(lastBooking) {
  if (!lastBooking || lastBooking.ts === lastShownBookingTs) return;
  if (Date.now() - lastBooking.ts > BOOKING_CELEBRATION_WINDOW_MS) return;
  lastShownBookingTs = lastBooking.ts;
  showBookingCelebration(lastBooking);
}

// Live "= X min" hint next to the seconds inputs, updates as you type.
function wireIntervalHints() {
  function update() {
    [['intervalMin', 'intervalMinHint'], ['intervalMax', 'intervalMaxHint'],
     ['rsIntervalMin', 'rsIntervalMinHint'], ['rsIntervalMax', 'rsIntervalMaxHint']].forEach(function(p) {
      var inp = document.getElementById(p[0]);
      var hint = document.getElementById(p[1]);
      if (!inp || !hint) return;
      var sec = parseFloat(inp.value);
      hint.textContent = (sec > 0) ? '= ' + (Math.round(sec / 60 * 100) / 100) + ' min' : '';
    });
  }
  ['intervalMin', 'intervalMax', 'rsIntervalMin', 'rsIntervalMax'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('input', update);
  });
  update();
  setTimeout(update, 300);  // re-run after saved values load
}

// ===== Advanced Settings Collapse/Expand =====
function wireAdvancedToggle() {
  var toggle = $('toggleAdvanced');
  var panel = $('advancedPanel');
  if (!toggle || !panel) return;

  toggle.addEventListener('click', function() {
    var isOpen = panel.style.display === 'block';
    panel.style.display = isOpen ? 'none' : 'block';
    toggle.classList.toggle('open', !isOpen);
    var label = toggle.querySelector('span');
    if (label) label.textContent = (isOpen ? '▸ ' : '▾ ') + 'Advanced Settings';
  });
}

// ===== Show/hide dependent fields =====
function wireConditionalFields() {
  var schedEnabled = $('scheduleEnabled');
  var schedWindows = $('scheduleWindows');
  if (schedEnabled && schedWindows) {
    schedEnabled.addEventListener('change', function() {
      schedWindows.style.display = schedEnabled.checked ? 'block' : 'none';
    });
  }

  var tgEnabled = $('telegramEnabled');
  var tgFields = $('telegramFields');
  if (tgEnabled && tgFields) {
    tgEnabled.addEventListener('change', function() {
      tgFields.style.display = tgEnabled.checked ? 'block' : 'none';
    });
  }
}

// ===== Password show/hide =====
function wirePasswordToggle() {
  var toggle = $('togglePassword');
  if (!toggle) return;

  toggle.addEventListener('click', function() {
    var pw = $('password');
    var icon = $('eyeIcon');
    if (!pw || !icon) return;

    if (pw.type === 'password') {
      pw.type = 'text';
      icon.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>'
        + '<path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>'
        + '<line x1="1" y1="1" x2="23" y2="23"/>';
    } else {
      pw.type = 'password';
      icon.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>'
        + '<circle cx="12" cy="12" r="3"/>';
    }
  });
}

// ===== Sound test =====
function wireTestSound() {
  var btn = $('testSound');
  if (!btn) return;
  btn.addEventListener('click', function() {
    btn.textContent = 'Playing...';
    chrome.runtime.sendMessage({ type: 'TEST_SOUND' }, function() {
      btn.textContent = '✓ Played';
      setTimeout(function() { btn.textContent = 'Test Sound'; }, 2000);
    });
  });
}

// ===== Export / import settings =====
function wireExportImport() {
  var exportBtn = $('exportSettings');
  var importInput = $('importSettings');

  if (exportBtn) {
    exportBtn.addEventListener('click', function() {
      chrome.storage.local.get(
        ['credentials', 'config', 'schedule', 'telegram', 'notifications', 'reschedule', 'activeTab'],
        function(data) {
          var payload = {
            version: 1,
            exportedAt: new Date().toISOString(),
            credentials: data.credentials || null,
            config: data.config || null,
            schedule: data.schedule || null,
            telegram: data.telegram || null,
            notifications: data.notifications || null,
            reschedule: data.reschedule || null,
            activeTab: data.activeTab || 'new'
          };
          var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = 'sardarji-settings-' + localISODate(new Date()) + '.json';
          a.click();
          URL.revokeObjectURL(url);
          exportBtn.textContent = '✓ Exported';
          setTimeout(function() { exportBtn.textContent = 'Export Settings'; }, 2000);
        }
      );
    });
  }

  if (importInput) {
    importInput.addEventListener('change', function(e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function() {
        try {
          var data = JSON.parse(reader.result);
          if (!data || typeof data !== 'object') throw new Error('Invalid file');
          if (!confirm('Import settings? This will overwrite your saved credentials and preferences.')) return;
          var toSet = {};
          if (data.credentials) toSet.credentials = data.credentials;
          if (data.config) toSet.config = data.config;
          if (data.schedule) toSet.schedule = data.schedule;
          if (data.telegram) toSet.telegram = data.telegram;
          if (data.notifications) toSet.notifications = data.notifications;
          if (data.reschedule) toSet.reschedule = data.reschedule;
          if (data.activeTab) toSet.activeTab = data.activeTab;
          chrome.storage.local.set(toSet, function() {
            loadSavedData();
            alert('Settings imported successfully.');
          });
        } catch (err) {
          alert('Import failed: ' + (err.message || 'invalid JSON'));
        }
        importInput.value = '';
      };
      reader.readAsText(file);
    });
  }
}

// ===== CAPTCHA resume =====
function wireResumeCaptcha() {
  var btn = $('resumeBtn');
  if (!btn) return;
  btn.addEventListener('click', function() {
    btn.disabled = true;
    btn.textContent = 'Resuming...';
    chrome.runtime.sendMessage({ type: 'RESUME_MONITORING' }, function() {
      chrome.storage.local.get(['monitoring', 'config', 'pausedState'], function(d) {
        updateStatus(d.monitoring, d.config);
        updateCaptchaBanner(d.pausedState);
        btn.disabled = false;
        btn.textContent = 'RESUME MONITORING';
      });
    });
  });
}

function updateCaptchaBanner(pausedState) {
  var banner = $('captchaBanner');
  if (!banner) return;
  if (pausedState && pausedState.reason === 'captcha') {
    banner.style.display = 'block';
  } else {
    banner.style.display = 'none';
  }
}

// ===== Slot history =====
function wireClearHistory() {
  var btn = $('clearHistory');
  if (!btn) return;
  btn.addEventListener('click', function() {
    if (!confirm('Clear slot history?')) return;
    chrome.storage.local.set({ slotHistory: [] }, function() {
      updateSlotHistory([]);
    });
  });
}

function updateSlotHistory(history) {
  var box = $('slotHistoryBox');
  if (!box) return;
  if (!history || !history.length) {
    box.textContent = 'No slots detected yet.';
    return;
  }
  var html = '';
  var start = Math.max(0, history.length - 10);
  for (var i = history.length - 1; i >= start; i--) {
    var e = history[i];
    var when = new Date(e.ts).toLocaleString();
    var timePart = e.time ? ' @ ' + e.time : '';
    html += '<div class="hist-entry">' + e.date + timePart + ' — ' + e.facility +
            ' <span style="color:#6c7086">(' + when + ')</span></div>';
  }
  box.innerHTML = html;
}

function formatCountdown(ms) {
  if (ms <= 0) return 'now';
  var sec = Math.ceil(ms / 1000);
  if (sec < 60) return sec + 's';
  var min = Math.floor(sec / 60);
  var rem = sec % 60;
  if (min < 60) return min + 'm ' + rem + 's';
  var hr = Math.floor(min / 60);
  min = min % 60;
  return hr + 'h ' + min + 'm';
}

function updateNextCheck(monitoring, nextCheckAt) {
  var row = $('nextCheckRow');
  if (!row) return;
  if (!monitoring || !nextCheckAt) {
    row.textContent = 'Next check: --';
    return;
  }
  var left = nextCheckAt - Date.now();
  row.textContent = 'Next check: ' + (left > 0 ? formatCountdown(left) : 'now...');
}

function startCountdownTimer() {
  setInterval(function() {
    chrome.storage.local.get(['monitoring', 'nextCheckAt'], function(d) {
      updateNextCheck(d.monitoring, d.nextCheckAt);
    });
  }, 1000);
}

// ===== Telegram test =====
function wireTestTelegram() {
  var btn = $('testTelegram');
  if (!btn) return;

  btn.addEventListener('click', function() {
    var token = ($('telegramToken') || {}).value;
    var chatId = ($('telegramChatId') || {}).value;
    token = (token || '').trim();
    chatId = (chatId || '').trim();
    if (!token || !chatId) { alert('Please enter Token and Chat ID'); return; }

    btn.textContent = 'Sending...';
    fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '✅ SardarJi Scheduler connected!',
        parse_mode: 'HTML'
      })
    }).then(function(r) { return r.json(); })
      .then(function(d) {
        btn.textContent = d.ok ? '✓ Sent!' : '✗ Failed';
      })
      .catch(function() { btn.textContent = '✗ Error'; })
      .finally(function() {
        setTimeout(function() { btn.textContent = 'Test Message'; }, 2000);
      });
  });
}

// ===== Save advanced settings =====
function wireSaveAdvanced() {
  var btn = $('saveAdvanced');
  if (!btn) return;

  btn.addEventListener('click', function() {
    var schedule = {
      enabled: ($('scheduleEnabled') || {}).checked || false,
      win1From: ($('win1From') || {}).value || '05:00',
      win1To: ($('win1To') || {}).value || '08:00',
      win2From: ($('win2From') || {}).value || '23:00',
      win2To: ($('win2To') || {}).value || '01:00',
      weekdaysOnly: ($('weekdaysOnly') || {}).checked || false
    };

    var telegram = {
      enabled: ($('telegramEnabled') || {}).checked || false,
      token: (($('telegramToken') || {}).value || '').trim(),
      chatId: (($('telegramChatId') || {}).value || '').trim()
    };

    var notifications = {
      sound: ($('soundEnabled') || {}).checked !== false,
      desktop: ($('desktopNotif') || {}).checked !== false
    };

    var facilities = [];
    var checks = $$('#facilityGrid input:checked');
    for (var i = 0; i < checks.length; i++) {
      facilities.push({ id: checks[i].value, name: checks[i].dataset.name });
    }

    chrome.storage.local.get(['config'], function(d) {
      var config = d.config || {};
      config.facilities = facilities;
      config.timeFrom = ($('timeFrom') || {}).value || '';
      config.timeTo = ($('timeTo') || {}).value || '';
      chrome.storage.local.set({
        config: config,
        schedule: schedule,
        telegram: telegram,
        notifications: notifications
      }, function() {
        var msg = $('savedMsg');
        if (msg) {
          msg.style.display = 'block';
          setTimeout(function() { msg.style.display = 'none'; }, 2000);
        }
      });
    });
  });
}

// ===== Copy log =====
function wireCopyLog() {
  var btn = $('copyLog');
  if (!btn) return;

  btn.addEventListener('click', function() {
    var box = $('logBox');
    if (!box) return;
    var text = box.innerText || box.textContent || '';
    navigator.clipboard.writeText(text).then(function() {
      btn.textContent = '✓ Copied!';
      setTimeout(function() { btn.textContent = '📋 Copy'; }, 1500);
    }).catch(function() {
      btn.textContent = '✗ Failed';
      setTimeout(function() { btn.textContent = '📋 Copy'; }, 1500);
    });
  });
}

// ===== START button =====
function wireStartButton() {
  var btn = $('startBtn');
  if (!btn) return;

  btn.addEventListener('click', function() {
    if (activeTab === 'reschedule') startReschedule();
    else startNewBooking();
  });
}

// Shared pre-start step: validate credentials, clear leftover celebration,
// save credentials. Returns null if validation failed.
function prepareStart() {
  var email = (($('email') || {}).value || '').trim();
  var password = (($('password') || {}).value || '').trim();
  if (!email || !password) { alert('Please enter email and password'); return null; }

  // Starting a fresh search — hide any leftover celebration from a prior run.
  var celebration = $('bookingCelebration');
  if (celebration) celebration.style.display = 'none';
  chrome.storage.local.remove('lastBooking');

  chrome.storage.local.set({
    credentials: { email: email, password: password }
  });
  return { email: email, password: password };
}

// Merge the primary facility with the Advanced multi-facility selection.
function buildFacilityList(oldConfig, primaryId) {
  var advFacilities = oldConfig.facilities || [];
  var primary = { id: primaryId, name: FACILITY_NAMES[primaryId] || primaryId };
  var facilities = [primary];
  for (var i = 0; i < advFacilities.length; i++) {
    if (advFacilities[i].id !== primary.id) {
      facilities.push(advFacilities[i]);
    }
  }
  return facilities;
}

function startNewBooking() {
  var facility = ($('facility') || {}).value || '';
  var dateFrom = ($('dateFrom') || {}).value || '';
  var dateTo = ($('dateTo') || {}).value || '';
  var minInt = parseFloat(($('intervalMin') || {}).value) || 60;
  var maxInt = parseFloat(($('intervalMax') || {}).value) || 120;
  var autoBook = ($('autoBook') || {}).checked || false;

  if (!facility) { alert('Please select a facility'); return; }
  if (!dateFrom || !dateTo) { alert('Please set the date range'); return; }
  if (dateFrom > dateTo) { alert('From date must be before To date'); return; }
  // No lower limit — fractional minutes allowed.

  if (!prepareStart()) return;

  chrome.storage.local.get(['config'], function(stored) {
    var oldConfig = stored.config || {};
    var facilities = buildFacilityList(oldConfig, facility);

    var config = {
      mode: 'new',
      facilities: facilities,
      facilityId: facilities[0].id,
      facilityName: facilities.map(function(f) { return f.name; }).join(', '),
      scheduleId: oldConfig.scheduleId || null,
      dateFrom: dateFrom,
      dateTo: dateTo,
      intervalMin: minInt,
      intervalMax: Math.max(maxInt, minInt),
      autoBook: autoBook,
      timeFrom: ($('timeFrom') || {}).value || oldConfig.timeFrom || '',
      timeTo: ($('timeTo') || {}).value || oldConfig.timeTo || ''
    };

    chrome.runtime.sendMessage({ type: 'START_MONITORING', config: config }, function() {
      updateStatus(true, config);
    });
  });
}

// Reschedule mode: hunt for dates strictly BEFORE the currently booked date and
// (optionally) auto-book — the site's appointment form moves the existing
// booking, so "booking" an earlier date IS the reschedule.
function startReschedule() {
  var facility = ($('rsFacility') || {}).value || '';
  var bookedDate = ($('rsBookedDate') || {}).value || '';
  var fromDate = ($('rsFromDate') || {}).value || '';
  var minInt = parseFloat(($('rsIntervalMin') || {}).value) || 60;
  var maxInt = parseFloat(($('rsIntervalMax') || {}).value) || 120;
  var autoBook = ($('rsAutoBook') || {}).checked || false;

  var today = localISODate(new Date());
  if (!facility) { alert('Please select a facility'); return; }
  if (!fromDate) fromDate = today;

  // Booked date is optional: leave it empty and the content script reads it
  // off the site after login (Groups page shows the appointment).
  var dateTo = null;
  if (bookedDate) {
    if (bookedDate <= today) { alert('Booked date must be in the future'); return; }
    // Search window: [earliest acceptable] → [day before the booking].
    dateTo = dayBefore(bookedDate);
    if (fromDate > dateTo) { alert('Earliest acceptable date must be before your booked date'); return; }
  }

  if (!prepareStart()) return;

  // Remember the reschedule form so it survives sidebar reloads.
  chrome.storage.local.set({
    reschedule: {
      facilityId: facility,
      bookedDate: bookedDate,
      fromDate: fromDate,
      intervalMin: minInt,
      intervalMax: maxInt,
      autoBook: autoBook
    }
  });

  chrome.storage.local.get(['config'], function(stored) {
    var oldConfig = stored.config || {};
    var facilities = buildFacilityList(oldConfig, facility);

    var config = {
      mode: 'reschedule',
      bookedDate: bookedDate || null,
      facilities: facilities,
      facilityId: facilities[0].id,
      facilityName: facilities.map(function(f) { return f.name; }).join(', '),
      scheduleId: oldConfig.scheduleId || null,
      dateFrom: fromDate,
      dateTo: dateTo,
      intervalMin: minInt,
      intervalMax: Math.max(maxInt, minInt),
      autoBook: autoBook,
      timeFrom: ($('timeFrom') || {}).value || oldConfig.timeFrom || '',
      timeTo: ($('timeTo') || {}).value || oldConfig.timeTo || ''
    };

    chrome.runtime.sendMessage({ type: 'START_MONITORING', config: config }, function() {
      updateStatus(true, config);
      if (!bookedDate) updateBookedDateStatus('pending');
    });
  });
}

// ===== STOP button =====
function wireStopButton() {
  var btn = $('stopBtn');
  if (!btn) return;

  btn.addEventListener('click', function() {
    chrome.runtime.sendMessage({ type: 'STOP_MONITORING' }, function() {
      updateStatus(false);
      updateCaptchaBanner(null);
      updateNextCheck(false, null);
    });
  });
}

// ===== Date defaults =====
function setDateDefaults() {
  var df = $('dateFrom');
  var dt = $('dateTo');
  if (df && !df.value) df.value = new Date().toISOString().split('T')[0];
  if (dt && !dt.value) {
    var future = new Date();
    future.setDate(future.getDate() + 90);
    dt.value = future.toISOString().split('T')[0];
  }
  var rf = $('rsFromDate');
  if (rf && !rf.value) rf.value = localISODate(new Date());
}

// ===== Load saved data =====
function loadSavedData() {
  chrome.storage.local.get(
    ['monitoring', 'config', 'stats', 'log', 'credentials', 'schedule', 'telegram', 'notifications', 'lastBooking', 'reschedule', 'activeTab', 'pausedState', 'slotHistory', 'nextCheckAt'],
    function(data) {
      if (data.credentials) {
        if ($('email')) $('email').value = data.credentials.email || '';
        if ($('password')) $('password').value = data.credentials.password || '';
      }

      if (data.config) {
        if ($('facility')) $('facility').value = data.config.facilityId || '';
        if ($('dateFrom') && data.config.dateFrom) $('dateFrom').value = data.config.dateFrom;
        if ($('dateTo') && data.config.dateTo) $('dateTo').value = data.config.dateTo;
        if ($('intervalMin')) $('intervalMin').value = data.config.intervalMin || 60;
        if ($('intervalMax')) $('intervalMax').value = data.config.intervalMax || 120;
        if ($('autoBook')) $('autoBook').checked = !!data.config.autoBook;
        if ($('timeFrom')) $('timeFrom').value = data.config.timeFrom || '';
        if ($('timeTo')) $('timeTo').value = data.config.timeTo || '';

        if (data.config.facilities) {
          var ids = data.config.facilities.map(function(f) { return f.id; });
          var checks = $$('#facilityGrid input');
          for (var i = 0; i < checks.length; i++) {
            checks[i].checked = ids.indexOf(checks[i].value) !== -1;
          }
        }
      }

      if (data.schedule) {
        if ($('scheduleEnabled')) $('scheduleEnabled').checked = data.schedule.enabled !== false;
        if ($('win1From')) $('win1From').value = data.schedule.win1From || '05:00';
        if ($('win1To')) $('win1To').value = data.schedule.win1To || '08:00';
        if ($('win2From')) $('win2From').value = data.schedule.win2From || '23:00';
        if ($('win2To')) $('win2To').value = data.schedule.win2To || '01:00';
        if ($('weekdaysOnly')) $('weekdaysOnly').checked = !!data.schedule.weekdaysOnly;
      }

      if (data.telegram) {
        if ($('telegramEnabled')) $('telegramEnabled').checked = !!data.telegram.enabled;
        if ($('telegramToken')) $('telegramToken').value = data.telegram.token || '';
        if ($('telegramChatId')) $('telegramChatId').value = data.telegram.chatId || '';
      }

      if (data.notifications) {
        if ($('soundEnabled')) $('soundEnabled').checked = data.notifications.sound !== false;
        if ($('desktopNotif')) $('desktopNotif').checked = data.notifications.desktop !== false;
      }

      if (data.reschedule) {
        if ($('rsFacility')) $('rsFacility').value = data.reschedule.facilityId || '';
        if ($('rsBookedDate') && data.reschedule.bookedDate) {
          $('rsBookedDate').value = data.reschedule.bookedDate;
          updateBookedDateStatus('detected', data.reschedule.bookedDate);
        }
        if ($('rsFromDate') && data.reschedule.fromDate) $('rsFromDate').value = data.reschedule.fromDate;
        if ($('rsIntervalMin')) $('rsIntervalMin').value = data.reschedule.intervalMin || 60;
        if ($('rsIntervalMax')) $('rsIntervalMax').value = data.reschedule.intervalMax || 120;
        if ($('rsAutoBook')) $('rsAutoBook').checked = data.reschedule.autoBook !== false;
      }

      setActiveTab(data.activeTab === 'reschedule' ? 'reschedule' : 'new', true);

      // Sync conditional field visibility
      var sw = $('scheduleWindows');
      var se = $('scheduleEnabled');
      if (sw && se) sw.style.display = se.checked ? 'block' : 'none';

      var tf = $('telegramFields');
      var te = $('telegramEnabled');
      if (tf && te) tf.style.display = te.checked ? 'block' : 'none';

      updateStatus(data.monitoring, data.config);
      updateStats(data.stats);
      updateLog(data.log);
      updateSlotHistory(data.slotHistory);
      updateCaptchaBanner(data.pausedState);
      updateNextCheck(data.monitoring, data.nextCheckAt);
      maybeShowBookingCelebration(data.lastBooking);
    }
  );
}

// ===== UI updates =====
function updateStatus(monitoring, config) {
  var bar = $('status-bar');
  var txt = $('status-text');
  var startBtn = $('startBtn');
  var stopBtn = $('stopBtn');

  if (monitoring) {
    var isRs = config && config.mode === 'reschedule';
    if (bar) bar.className = 'status active';
    if (txt) txt.textContent = isRs ? 'Monitoring (Reschedule)...' : 'Monitoring...';
    if (startBtn) startBtn.disabled = true;
    if (stopBtn) stopBtn.disabled = false;
  } else {
    if (bar) bar.className = 'status idle';
    if (txt) txt.textContent = 'Idle';
    if (startBtn) startBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;
  }
}

function updateStats(stats) {
  if (!stats) return;
  var c = $('checksCount');
  var f = $('slotsFound');
  var l = $('lastCheck');
  if (c) c.textContent = 'Checks: ' + (stats.checks || 0);
  if (f) f.textContent = 'Found: ' + (stats.slotsFound || 0);
  if (stats.lastCheck && l) {
    l.textContent = 'Last: ' + new Date(stats.lastCheck).toLocaleTimeString();
  }
}

function updateLog(log) {
  var box = $('logBox');
  var jumpBtn = $('jumpToBottom');
  if (!log || !box) return;

  // Only auto-scroll to the bottom if the user was already at (or near) the
  // bottom. If they scrolled up to read older entries, leave them where they
  // are instead of yanking the view back down on every refresh — but show a
  // "jump to latest" button since new logs are still landing below.
  var wasAtBottom = box.scrollHeight - box.scrollTop - box.clientHeight <= 4;
  var prevScrollTop = box.scrollTop;

  var html = '';
  for (var i = 0; i < log.length; i++) {
    var d = document.createElement('div');
    d.textContent = log[i];
    html += '<div>' + d.innerHTML + '</div>';
  }
  box.innerHTML = html;

  if (wasAtBottom) {
    box.scrollTop = box.scrollHeight;
    if (jumpBtn) jumpBtn.style.display = 'none';
  } else {
    box.scrollTop = prevScrollTop;
    if (jumpBtn) jumpBtn.style.display = 'block';
  }
}

// ===== Jump-to-latest button on the log box =====
function wireJumpToBottom() {
  var btn = $('jumpToBottom');
  var box = $('logBox');
  if (!btn || !box) return;

  btn.addEventListener('click', function() {
    box.scrollTop = box.scrollHeight;
    btn.style.display = 'none';
  });

  // Manually scrolling back to the bottom also dismisses the button.
  box.addEventListener('scroll', function() {
    var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight <= 4;
    if (atBottom) btn.style.display = 'none';
  });
}

// ===== Auto refresh =====
function startAutoRefresh() {
  setInterval(function() {
    chrome.storage.local.get(['monitoring', 'stats', 'log', 'lastBooking', 'config', 'reschedule', 'pausedState', 'slotHistory', 'nextCheckAt'], function(data) {
      updateStatus(data.monitoring, data.config);
      updateStats(data.stats);
      updateLog(data.log);
      updateSlotHistory(data.slotHistory);
      updateCaptchaBanner(data.pausedState);
      updateNextCheck(data.monitoring, data.nextCheckAt);
      maybeShowBookingCelebration(data.lastBooking);

      // If the booked date was auto-detected mid-run, surface it in the form.
      var rb = $('rsBookedDate');
      if (rb && data.reschedule && data.reschedule.bookedDate) {
        if (!rb.value) rb.value = data.reschedule.bookedDate;
        if (data.config && data.config.mode === 'reschedule' && data.config.bookedDate) {
          updateBookedDateStatus('detected', data.config.bookedDate);
        }
      } else if (data.config && data.config.mode === 'reschedule' && data.monitoring && !data.config.bookedDate) {
        updateBookedDateStatus('pending');
      }
    });
  }, 3000);
}
