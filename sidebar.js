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

function init() {
  wireAdvancedToggle();
  wireConditionalFields();
  wirePasswordToggle();
  wireTestTelegram();
  wireSaveAdvanced();
  wireCopyLog();
  wireStartButton();
  wireStopButton();
  wireIntervalHints();
  wireBookingCelebration();
  wireJumpToBottom();
  setDateDefaults();
  loadSavedData();
  startAutoRefresh();
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
  details.textContent = (b.date || '') + ' ' + (b.time || '') + ' — ' + (b.facility || '');
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
    [['intervalMin', 'intervalMinHint'], ['intervalMax', 'intervalMaxHint']].forEach(function(p) {
      var inp = document.getElementById(p[0]);
      var hint = document.getElementById(p[1]);
      if (!inp || !hint) return;
      var sec = parseFloat(inp.value);
      hint.textContent = (sec > 0) ? '= ' + (Math.round(sec / 60 * 100) / 100) + ' min' : '';
    });
  }
  ['intervalMin', 'intervalMax'].forEach(function(id) {
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
    var email = (($('email') || {}).value || '').trim();
    var password = (($('password') || {}).value || '').trim();
    var facility = ($('facility') || {}).value || '';
    var dateFrom = ($('dateFrom') || {}).value || '';
    var dateTo = ($('dateTo') || {}).value || '';
    var minInt = parseFloat(($('intervalMin') || {}).value) || 60;
    var maxInt = parseFloat(($('intervalMax') || {}).value) || 120;
    var autoBook = ($('autoBook') || {}).checked || false;

    if (!email || !password) { alert('Please enter email and password'); return; }
    if (!facility) { alert('Please select a facility'); return; }
    if (!dateFrom || !dateTo) { alert('Please set the date range'); return; }
    if (dateFrom > dateTo) { alert('From date must be before To date'); return; }
    // No lower limit — fractional minutes allowed.

    // Starting a fresh search — hide any leftover celebration from a prior run.
    var celebration = $('bookingCelebration');
    if (celebration) celebration.style.display = 'none';
    chrome.storage.local.remove('lastBooking');

    chrome.storage.local.set({
      credentials: { email: email, password: password }
    });

    chrome.storage.local.get(['config'], function(stored) {
      var oldConfig = stored.config || {};
      var advFacilities = oldConfig.facilities || [];

      var primary = { id: facility, name: FACILITY_NAMES[facility] || facility };
      var facilities = [primary];
      for (var i = 0; i < advFacilities.length; i++) {
        if (advFacilities[i].id !== primary.id) {
          facilities.push(advFacilities[i]);
        }
      }

      var config = {
        facilities: facilities,
        facilityId: primary.id,
        facilityName: facilities.map(function(f) { return f.name; }).join(', '),
        scheduleId: oldConfig.scheduleId || null,
        dateFrom: dateFrom,
        dateTo: dateTo,
        intervalMin: minInt,
        intervalMax: Math.max(maxInt, minInt),
        autoBook: autoBook
      };

      chrome.runtime.sendMessage({ type: 'START_MONITORING', config: config }, function() {
        updateStatus(true);
      });
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
}

// ===== Load saved data =====
function loadSavedData() {
  chrome.storage.local.get(
    ['monitoring', 'config', 'stats', 'log', 'credentials', 'schedule', 'telegram', 'notifications', 'lastBooking'],
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

      // Sync conditional field visibility
      var sw = $('scheduleWindows');
      var se = $('scheduleEnabled');
      if (sw && se) sw.style.display = se.checked ? 'block' : 'none';

      var tf = $('telegramFields');
      var te = $('telegramEnabled');
      if (tf && te) tf.style.display = te.checked ? 'block' : 'none';

      updateStatus(data.monitoring);
      updateStats(data.stats);
      updateLog(data.log);
      maybeShowBookingCelebration(data.lastBooking);
    }
  );
}

// ===== UI updates =====
function updateStatus(monitoring) {
  var bar = $('status-bar');
  var txt = $('status-text');
  var startBtn = $('startBtn');
  var stopBtn = $('stopBtn');

  if (monitoring) {
    if (bar) bar.className = 'status active';
    if (txt) txt.textContent = 'Monitoring...';
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
    chrome.storage.local.get(['monitoring', 'stats', 'log', 'lastBooking'], function(data) {
      updateStatus(data.monitoring);
      updateStats(data.stats);
      updateLog(data.log);
      maybeShowBookingCelebration(data.lastBooking);
    });
  }, 3000);
}
