document.addEventListener('DOMContentLoaded', function() {
  try { init(); } catch(e) { console.error('Popup init error:', e); }
});

function init() {
  var slider = document.querySelector('.slider');
  var facilityNames = {
    '89': 'Calgary', '90': 'Halifax', '91': 'Montreal',
    '92': 'Ottawa', '93': 'Quebec City', '94': 'Toronto', '95': 'Vancouver'
  };

  // Live "= X min" hint next to the seconds inputs, updates as you type.
  function updateIntervalHints() {
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
    if (el) el.addEventListener('input', updateIntervalHints);
  });
  updateIntervalHints();
  setTimeout(updateIntervalHints, 300);  // re-run after saved values load

  // ===== SLIDER NAVIGATION =====
  var openBtn = document.getElementById('openAdvanced');
  var backBtn = document.getElementById('backBtn');

  if (openBtn) {
    openBtn.addEventListener('click', function(e) {
      e.preventDefault();
      if (slider) slider.classList.add('show-advanced');
    });
  }

  if (backBtn) {
    backBtn.addEventListener('click', function(e) {
      e.preventDefault();
      if (slider) slider.classList.remove('show-advanced');
    });
  }

  // ===== ADVANCED TOGGLES =====
  var scheduleEnabledEl = document.getElementById('scheduleEnabled');
  var scheduleWindowsEl = document.getElementById('scheduleWindows');
  var telegramEnabledEl = document.getElementById('telegramEnabled');
  var telegramFieldsEl = document.getElementById('telegramFields');

  if (scheduleEnabledEl) {
    scheduleEnabledEl.addEventListener('change', function() {
      if (scheduleWindowsEl) scheduleWindowsEl.style.display = scheduleEnabledEl.checked ? 'block' : 'none';
    });
  }

  if (telegramEnabledEl) {
    telegramEnabledEl.addEventListener('change', function() {
      if (telegramFieldsEl) telegramFieldsEl.style.display = telegramEnabledEl.checked ? 'block' : 'none';
    });
  }

  // ===== TEST TELEGRAM =====
  var testTelegramBtn = document.getElementById('testTelegram');
  if (testTelegramBtn) {
    testTelegramBtn.addEventListener('click', function() {
      var tokenEl = document.getElementById('telegramToken');
      var chatIdEl = document.getElementById('telegramChatId');
      var token = tokenEl ? tokenEl.value.trim() : '';
      var chatId = chatIdEl ? chatIdEl.value.trim() : '';
      if (!token || !chatId) { alert('Please enter Token and Chat ID'); return; }
      testTelegramBtn.textContent = 'Sending...';
      fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: '✅ SardarJi Appointment Scheduler connected!', parse_mode: 'HTML' })
      }).then(function(r) { return r.json(); }).then(function(d) {
        testTelegramBtn.textContent = d.ok ? 'Sent!' : 'Failed!';
      }).catch(function() {
        testTelegramBtn.textContent = 'Error!';
      }).finally(function() {
        setTimeout(function() { testTelegramBtn.textContent = 'Test Message'; }, 2000);
      });
    });
  }

  // ===== SAVE ADVANCED =====
  var saveBtn = document.getElementById('saveAdvanced');
  if (saveBtn) {
    saveBtn.addEventListener('click', function() {
      var se = document.getElementById('scheduleEnabled');
      var w1f = document.getElementById('win1From');
      var w1t = document.getElementById('win1To');
      var w2f = document.getElementById('win2From');
      var w2t = document.getElementById('win2To');
      var wd = document.getElementById('weekdaysOnly');
      var te = document.getElementById('telegramEnabled');
      var tt = document.getElementById('telegramToken');
      var tc = document.getElementById('telegramChatId');
      var snd = document.getElementById('soundEnabled');
      var desk = document.getElementById('desktopNotif');

      var schedule = {
        enabled: se ? se.checked : false,
        win1From: w1f ? w1f.value : '05:00',
        win1To: w1t ? w1t.value : '08:00',
        win2From: w2f ? w2f.value : '23:00',
        win2To: w2t ? w2t.value : '01:00',
        weekdaysOnly: wd ? wd.checked : false
      };
      var telegram = {
        enabled: te ? te.checked : false,
        token: tt ? tt.value.trim() : '',
        chatId: tc ? tc.value.trim() : ''
      };
      var notifications = {
        sound: snd ? snd.checked : true,
        desktop: desk ? desk.checked : true
      };

      var checks = document.querySelectorAll('#facilityGrid input:checked');
      var facilities = [];
      for (var i = 0; i < checks.length; i++) {
        facilities.push({ id: checks[i].value, name: checks[i].dataset.name });
      }

      chrome.storage.local.get(['config'], function(d) {
        var config = d.config || {};
        config.facilities = facilities;
        chrome.storage.local.set({ config: config, schedule: schedule, telegram: telegram, notifications: notifications }, function() {
          var msg = document.getElementById('savedMsg');
          if (msg) {
            msg.style.display = 'block';
            setTimeout(function() { msg.style.display = 'none'; }, 2000);
          }
        });
      });
    });
  }

  // ===== COPY LOG =====
  var copyLogBtn = document.getElementById('copyLog');
  if (copyLogBtn) {
    copyLogBtn.addEventListener('click', function() {
      var logBox = document.getElementById('logBox');
      if (!logBox) return;
      var text = logBox.innerText || logBox.textContent || '';
      navigator.clipboard.writeText(text).then(function() {
        copyLogBtn.textContent = '✓ Copied!';
        setTimeout(function() { copyLogBtn.innerHTML = '&#128203; Copy'; }, 1500);
      });
    });
  }

  // ===== PASSWORD TOGGLE =====
  var togglePw = document.getElementById('togglePassword');
  if (togglePw) {
    togglePw.addEventListener('click', function() {
      var pw = document.getElementById('password');
      var icon = document.getElementById('eyeIcon');
      if (!pw || !icon) return;
      if (pw.type === 'password') {
        pw.type = 'text';
        icon.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>';
      } else {
        pw.type = 'password';
        icon.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
      }
    });
  }

  // ===== DEFAULTS =====
  var dateFromEl = document.getElementById('dateFrom');
  var dateToEl = document.getElementById('dateTo');
  var today = new Date();
  if (dateFromEl) dateFromEl.value = today.toISOString().split('T')[0];
  var future = new Date(today);
  future.setDate(future.getDate() + 90);
  if (dateToEl) dateToEl.value = future.toISOString().split('T')[0];

  // ===== LOAD SAVED DATA =====
  chrome.storage.local.get(['monitoring', 'config', 'stats', 'log', 'credentials', 'schedule', 'telegram', 'notifications'], function(data) {
    var emailEl = document.getElementById('email');
    var passwordEl = document.getElementById('password');
    var facilityEl = document.getElementById('facility');
    var intervalMinEl = document.getElementById('intervalMin');
    var intervalMaxEl = document.getElementById('intervalMax');
    var autoBookEl = document.getElementById('autoBook');

    if (data.credentials) {
      if (emailEl) emailEl.value = data.credentials.email || '';
      if (passwordEl) passwordEl.value = data.credentials.password || '';
    }
    if (data.config) {
      if (facilityEl) facilityEl.value = data.config.facilityId || '';
      if (dateFromEl) dateFromEl.value = data.config.dateFrom || dateFromEl.value;
      if (dateToEl) dateToEl.value = data.config.dateTo || dateToEl.value;
      if (intervalMinEl) intervalMinEl.value = data.config.intervalMin || 60;
      if (intervalMaxEl) intervalMaxEl.value = data.config.intervalMax || 120;
      if (autoBookEl) autoBookEl.checked = data.config.autoBook || false;

      if (data.config.facilities) {
        var ids = data.config.facilities.map(function(f) { return f.id; });
        var gridChecks = document.querySelectorAll('#facilityGrid input');
        for (var i = 0; i < gridChecks.length; i++) {
          gridChecks[i].checked = ids.indexOf(gridChecks[i].value) !== -1;
        }
      }
    }

    if (data.schedule) {
      var se = document.getElementById('scheduleEnabled');
      var w1f = document.getElementById('win1From');
      var w1t = document.getElementById('win1To');
      var w2f = document.getElementById('win2From');
      var w2t = document.getElementById('win2To');
      var wd = document.getElementById('weekdaysOnly');
      if (se) se.checked = data.schedule.enabled !== false;
      if (w1f) w1f.value = data.schedule.win1From || '05:00';
      if (w1t) w1t.value = data.schedule.win1To || '08:00';
      if (w2f) w2f.value = data.schedule.win2From || '23:00';
      if (w2t) w2t.value = data.schedule.win2To || '01:00';
      if (wd) wd.checked = data.schedule.weekdaysOnly || false;
    }
    if (data.telegram) {
      var te = document.getElementById('telegramEnabled');
      var tt = document.getElementById('telegramToken');
      var tc = document.getElementById('telegramChatId');
      if (te) te.checked = data.telegram.enabled || false;
      if (tt) tt.value = data.telegram.token || '';
      if (tc) tc.value = data.telegram.chatId || '';
    }
    if (data.notifications) {
      var snd = document.getElementById('soundEnabled');
      var desk = document.getElementById('desktopNotif');
      if (snd) snd.checked = data.notifications.sound !== false;
      if (desk) desk.checked = data.notifications.desktop !== false;
    }

    var swEl = document.getElementById('scheduleWindows');
    var seEl = document.getElementById('scheduleEnabled');
    var tfEl = document.getElementById('telegramFields');
    var teEl = document.getElementById('telegramEnabled');
    if (swEl) swEl.style.display = (seEl && seEl.checked) ? 'block' : 'none';
    if (tfEl) tfEl.style.display = (teEl && teEl.checked) ? 'block' : 'none';

    updateUI(data.monitoring);
    updateStats(data.stats);
    updateLog(data.log);
  });

  // ===== START =====
  var startBtn = document.getElementById('startBtn');
  if (startBtn) {
    startBtn.addEventListener('click', function() {
      var emailEl = document.getElementById('email');
      var passwordEl = document.getElementById('password');
      var facilityEl = document.getElementById('facility');
      var dateFromEl = document.getElementById('dateFrom');
      var dateToEl = document.getElementById('dateTo');
      var intervalMinEl = document.getElementById('intervalMin');
      var intervalMaxEl = document.getElementById('intervalMax');
      var autoBookEl = document.getElementById('autoBook');

      var email = emailEl ? emailEl.value.trim() : '';
      var password = passwordEl ? passwordEl.value.trim() : '';
      if (!email || !password) { alert('Please enter email and password'); return; }
      if (!facilityEl || !facilityEl.value) { alert('Please select a facility'); return; }
      if (!dateFromEl || !dateFromEl.value || !dateToEl || !dateToEl.value) { alert('Please set the date range'); return; }
      if (dateFromEl.value > dateToEl.value) { alert('From date must be before To date'); return; }

      var minInt = parseFloat(intervalMinEl ? intervalMinEl.value : '60') || 60;
      var maxInt = parseFloat(intervalMaxEl ? intervalMaxEl.value : '120') || 120;
      // Values are in SECONDS. No lower limit.

      chrome.storage.local.set({ credentials: { email: email, password: password } });

      chrome.storage.local.get(['config'], function(stored) {
        var oldConfig = stored.config || {};
        var advancedFacilities = oldConfig.facilities || [];

        var primaryFac = { id: facilityEl.value, name: facilityNames[facilityEl.value] };
        var facilities = [primaryFac];
        for (var i = 0; i < advancedFacilities.length; i++) {
          if (advancedFacilities[i].id !== primaryFac.id) facilities.push(advancedFacilities[i]);
        }

        var config = {
          facilities: facilities,
          facilityId: primaryFac.id,
          facilityName: facilities.map(function(f) { return f.name; }).join(', '),
          scheduleId: oldConfig.scheduleId || null,
          dateFrom: dateFromEl.value,
          dateTo: dateToEl.value,
          intervalMin: minInt,
          intervalMax: Math.max(maxInt, minInt),
          autoBook: autoBookEl ? autoBookEl.checked : false
        };

        chrome.runtime.sendMessage({ type: 'START_MONITORING', config: config }, function() {
          updateUI(true);
        });
      });
    });
  }

  // ===== STOP =====
  var stopBtn = document.getElementById('stopBtn');
  if (stopBtn) {
    stopBtn.addEventListener('click', function() {
      chrome.runtime.sendMessage({ type: 'STOP_MONITORING' }, function() {
        updateUI(false);
      });
    });
  }

  // ===== AUTO REFRESH =====
  setInterval(function() {
    chrome.storage.local.get(['monitoring', 'stats', 'log'], function(data) {
      updateUI(data.monitoring);
      updateStats(data.stats);
      updateLog(data.log);
    });
  }, 3000);
}

function updateUI(monitoring) {
  var bar = document.getElementById('status-bar');
  var txt = document.getElementById('status-text');
  var startBtn = document.getElementById('startBtn');
  var stopBtn = document.getElementById('stopBtn');

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
  var c = document.getElementById('checksCount');
  var f = document.getElementById('slotsFound');
  var l = document.getElementById('lastCheck');
  if (c) c.textContent = 'Checks: ' + (stats.checks || 0);
  if (f) f.textContent = 'Found: ' + (stats.slotsFound || 0);
  if (stats.lastCheck && l) {
    l.textContent = 'Last: ' + new Date(stats.lastCheck).toLocaleTimeString();
  }
}

function updateLog(log) {
  var box = document.getElementById('logBox');
  if (!log || !box) return;
  var html = '';
  for (var i = 0; i < log.length; i++) {
    var d = document.createElement('div');
    d.textContent = log[i];
    html += '<div>' + d.innerHTML + '</div>';
  }
  box.innerHTML = html;
  box.scrollTop = box.scrollHeight;
}
