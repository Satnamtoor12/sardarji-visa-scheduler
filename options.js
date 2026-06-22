document.addEventListener('DOMContentLoaded', () => {
  const els = {
    scheduleEnabled: document.getElementById('scheduleEnabled'),
    win1From: document.getElementById('win1From'),
    win1To: document.getElementById('win1To'),
    win2From: document.getElementById('win2From'),
    win2To: document.getElementById('win2To'),
    weekdaysOnly: document.getElementById('weekdaysOnly'),
    scheduleWindows: document.getElementById('scheduleWindows'),
    telegramEnabled: document.getElementById('telegramEnabled'),
    telegramToken: document.getElementById('telegramToken'),
    telegramChatId: document.getElementById('telegramChatId'),
    telegramFields: document.getElementById('telegramFields'),
    testBtn: document.getElementById('testTelegram'),
    soundEnabled: document.getElementById('soundEnabled'),
    desktopNotif: document.getElementById('desktopNotif'),
    saveBtn: document.getElementById('saveBtn'),
    savedMsg: document.getElementById('savedMsg')
  };

  // Toggles
  els.scheduleEnabled.addEventListener('change', () => {
    els.scheduleWindows.style.display = els.scheduleEnabled.checked ? 'block' : 'none';
  });
  els.telegramEnabled.addEventListener('change', () => {
    els.telegramFields.style.display = els.telegramEnabled.checked ? 'block' : 'none';
  });

  function getSelectedFacilities() {
    const checks = document.querySelectorAll('#facilityGrid input:checked');
    return Array.from(checks).map(c => ({ id: c.value, name: c.dataset.name }));
  }

  function setSelectedFacilities(ids) {
    document.querySelectorAll('#facilityGrid input').forEach(c => {
      c.checked = ids.includes(c.value);
    });
  }

  // Load saved settings
  chrome.storage.local.get(['schedule', 'telegram', 'notifications', 'config'], (data) => {
    if (data.config && data.config.facilities) {
      setSelectedFacilities(data.config.facilities.map(f => f.id));
    }
    if (data.schedule) {
      els.scheduleEnabled.checked = data.schedule.enabled !== false;
      els.win1From.value = data.schedule.win1From || '05:00';
      els.win1To.value = data.schedule.win1To || '08:00';
      els.win2From.value = data.schedule.win2From || '23:00';
      els.win2To.value = data.schedule.win2To || '01:00';
      els.weekdaysOnly.checked = data.schedule.weekdaysOnly || false;
    }
    if (data.telegram) {
      els.telegramEnabled.checked = data.telegram.enabled || false;
      els.telegramToken.value = data.telegram.token || '';
      els.telegramChatId.value = data.telegram.chatId || '';
    }
    if (data.notifications) {
      els.soundEnabled.checked = data.notifications.sound !== false;
      els.desktopNotif.checked = data.notifications.desktop !== false;
    }
    els.scheduleWindows.style.display = els.scheduleEnabled.checked ? 'block' : 'none';
    els.telegramFields.style.display = els.telegramEnabled.checked ? 'block' : 'none';
  });

  // Test telegram
  els.testBtn.addEventListener('click', async () => {
    const token = els.telegramToken.value.trim();
    const chatId = els.telegramChatId.value.trim();
    if (!token || !chatId) { alert('Please enter Token and Chat ID'); return; }
    els.testBtn.textContent = 'Sending...';
    try {
      const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: '✅ SardarJi Appointment Scheduler connected!', parse_mode: 'HTML' })
      });
      const d = await r.json();
      els.testBtn.textContent = d.ok ? 'Sent!' : 'Failed!';
    } catch (e) {
      els.testBtn.textContent = 'Error!';
    }
    setTimeout(() => { els.testBtn.textContent = 'Test Message'; }, 2000);
  });

  // Save
  els.saveBtn.addEventListener('click', () => {
    const schedule = {
      enabled: els.scheduleEnabled.checked,
      win1From: els.win1From.value,
      win1To: els.win1To.value,
      win2From: els.win2From.value,
      win2To: els.win2To.value,
      weekdaysOnly: els.weekdaysOnly.checked
    };
    const telegram = {
      enabled: els.telegramEnabled.checked,
      token: els.telegramToken.value.trim(),
      chatId: els.telegramChatId.value.trim()
    };
    const notifications = {
      sound: els.soundEnabled.checked,
      desktop: els.desktopNotif.checked
    };

    const facilities = getSelectedFacilities();

    // Update config with new facilities
    chrome.storage.local.get(['config'], (d) => {
      const config = d.config || {};
      config.facilities = facilities;
      config.facilityName = facilities.map(f => f.name).join(', ');
      if (facilities.length > 0) config.facilityId = facilities[0].id;
      chrome.storage.local.set({ config });
    });

    chrome.storage.local.set({ schedule, telegram, notifications }, () => {
      els.savedMsg.style.display = 'inline';
      setTimeout(() => { els.savedMsg.style.display = 'none'; }, 2000);
    });
  });
});
