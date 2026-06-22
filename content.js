// Content script - runs on ais.usvisa-info.com
// Handles: page detection, auto-login, slot checking, booking
// Zero DOM footprint (no injected elements)

(function () {
  'use strict';

  // Set true when the user presses STOP — long-running sequences (login,
  // booking, typing) check this and bail out instead of finishing.
  let aborted = false;

  // On page load: check state and notify background
  chrome.storage.local.get(['bookingState', 'config', 'monitoring'], (data) => {
    // If a booking was mid-flow but the session dropped to the login page,
    // abandon the stale booking so normal re-login/monitoring can take over
    // (otherwise we'd silently stall, never re-logging in).
    if (data.bookingState && detectPage() === 'login') {
      chrome.storage.local.remove('bookingState');
    } else if (data.bookingState && data.config) {
      handleBookingContinuation(data.bookingState, data.config);
      return;
    }
    // If monitoring is active, tell background what page we're on
    if (data.monitoring) {
      const page = detectPage();
      const url = window.location.href;
      log('Page loaded: ' + page + ' (' + url.split('/').slice(-2).join('/') + ')');

      // On Groups page: click Continue to navigate to schedule page
      if (page === 'groups') {
        clickContinueOnGroupsPage().then(() => {
          chrome.runtime.sendMessage({ type: 'PAGE_READY', page, url });
        });
        return;
      }

      // On continue_actions page: click "Schedule Appointment"
      if (page === 'continue-actions') {
        clickScheduleAppointment().then(() => {
          chrome.runtime.sendMessage({ type: 'PAGE_READY', page, url });
        });
        return;
      }

      // For the login page, attach captcha/error info so the background can
      // tell a failed attempt from a fresh one (and stop vs retry correctly).
      if (page === 'login') {
        chrome.runtime.sendMessage({ type: 'PAGE_READY', page, url, captcha: detectCaptcha(), loginError: getLoginError() });
      } else {
        chrome.runtime.sendMessage({ type: 'PAGE_READY', page, url });
      }
    }
  });

  // ==================== MESSAGE HANDLER ====================

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'WHAT_PAGE':
        sendResponse({ page: detectPage() });
        break;
      case 'ABORT':
        aborted = true;
        sendResponse({ ok: true });
        break;
      case 'DO_LOGIN':
        aborted = false;            // fresh operation
        doLogin(msg.email, msg.password);
        sendResponse({ ok: true });
        break;
      case 'FIND_SCHEDULE':
        sendResponse(findScheduleOnPage());
        break;
      case 'GO_TO_SCHEDULE':
        goToSchedulePage();
        sendResponse({ ok: true });
        break;
      case 'DO_CHECK':
        aborted = false;            // fresh operation
        chrome.storage.local.get(['config'], (data) => {
          if (data.config) checkSlots(data.config);
          else log('No config set');
        });
        sendResponse({ ok: true });
        return true;
      case 'KEEP_ALIVE':
        keepSessionAlive().then((alive) => sendResponse({ ok: true, alive }))
          .catch(() => sendResponse({ ok: false }));
        return true;
      case 'DO_BOOK':
        chrome.storage.local.get(['config'], (data) => {
          if (data.config) startBooking(data.config, msg.date);
        });
        sendResponse({ ok: true });
        return true;
      default:
        sendResponse({ ok: false });
    }
    return false;
  });

  // ==================== KEEP-ALIVE ====================

  // Lightweight same-origin request to refresh the server session without
  // doing a full slot check. usvisa-info sessions expire after ~20 min of
  // inactivity; a single quiet GET resets that timer. Returns false if the
  // response looks like the login page (i.e. session already gone).
  async function keepSessionAlive() {
    try {
      const resp = await fetch(window.location.href, {
        credentials: 'include',
        cache: 'no-store',
        headers: { 'X-Requested-With': 'XMLHttpRequest' }
      });
      const stillLoggedIn = resp.ok && !resp.url.includes('/users/sign_in');
      log(stillLoggedIn ? 'Keep-alive ping OK' : 'Keep-alive: session lost');
      return stillLoggedIn;
    } catch (e) {
      log('Keep-alive failed: ' + e.message);
      return false;
    }
  }

  // Detect a CAPTCHA / reCAPTCHA on the current page. The extension cannot
  // solve these — it's used to give a clear reason and alert the user.
  function detectCaptcha() {
    return !!(
      document.querySelector('.g-recaptcha, #g-recaptcha, .h-captcha') ||
      document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"]') ||
      document.querySelector('[data-sitekey]')
    );
  }

  // Read a login error message shown by the website (e.g. "Invalid email or
  // password."). Returns the text, or null if none. Used so we can STOP on a
  // rejected login instead of pointlessly retrying.
  function getLoginError() {
    // 1. Common flash / alert containers (Rails/Devise + this site's markup).
    const els = document.querySelectorAll(
      '.alert, .alert-danger, .alert-error, .flash, .flash-error, .flash_messages, ' +
      '.error, .error-msg, .errors, .notice, [class*="error" i], #flash_messages'
    );
    for (const el of els) {
      const t = (el.textContent || '').trim();
      if (t && t.length < 200 && /invalid|incorrect|password|not match|wrong|error|failed/i.test(t)) {
        return t.substring(0, 120);
      }
    }
    // 2. Fallback: scan the whole page text for the known phrases.
    const body = (document.body && document.body.innerText || '').toLowerCase();
    if (body.includes('invalid email or password') ||
        body.includes('email or password') ||
        body.includes('incorrect')) {
      return 'Invalid email or password';
    }
    return null;
  }

  // ==================== PAGE DETECTION ====================

  function detectPage() {
    const url = window.location.href;
    if (url.includes('/users/sign_in')) return 'login';
    if (url.includes('/groups/')) return 'groups';
    if (url.includes('/continue_actions')) return 'continue-actions';
    if (url.includes('/appointment')) return 'appointment';
    if (url.includes('/schedule/')) return 'logged-in';
    if (url.includes('/niv/') && !url.includes('sign_in')) return 'logged-in';
    if (document.querySelector('a[href*="sign_out"]')) return 'logged-in';
    if (document.querySelector('#user_email')) return 'login';
    return 'unknown';
  }

  // Click "Schedule Appointment" on continue_actions page
  async function clickScheduleAppointment() {
    log('On Continue Actions page — clicking Schedule Appointment...');
    await delay(1500 + Math.random() * 1500);

    // 1. Expand accordion if needed (if it's not already expanded)
    // The header usually has an icon or is an h5/a tag without a specific appointment href
    const allLinks = document.querySelectorAll('a, h5, .accordion-title, .accordion-item');
    for (const el of allLinks) {
      const txt = (el.textContent || '').trim().toLowerCase();
      if (txt === 'schedule appointment' && !el.href?.includes('/appointment')) {
        // Try clicking to expand, but don't wait too long
        try { el.click(); } catch (e) {}
      }
    }
    
    await delay(1000); // Wait for accordion to expand

    // 2. Find the actual Schedule Appointment link (the green button)
    let target = document.querySelector('a.button.primary[href*="/appointment"]') ||
                 document.querySelector('a.btn-primary[href*="/appointment"]') ||
                 document.querySelector('a[href$="/appointment"]') ||
                 document.querySelector('a[href*="/appointment"]');

    // Fallback: any link with text 'schedule appointment' that is not a header
    if (!target) {
      const links = document.querySelectorAll('a');
      for (const a of links) {
        const txt = (a.textContent || '').trim().toLowerCase();
        if (txt.includes('schedule appointment') && a.href && a.href.includes('/appointment')) {
          target = a;
          break;
        }
      }
    }

    // Ultimate fallback: any element (button/link/input) that says 'schedule appointment'
    if (!target) {
      const allEls = document.querySelectorAll('a, button, input[type="submit"], input[type="button"]');
      for (const el of allEls) {
        const txt = (el.textContent || el.value || '').trim().toLowerCase();
        if (txt.includes('schedule appointment') && !el.classList?.contains('accordion-title')) {
          target = el;
          // Don't break, keep looking in case there's a better one
        }
      }
    }

    if (!target) {
      log('Schedule Appointment link not found');
      return false;
    }

    log('Found: ' + target.textContent.trim().substring(0, 30));
    initCursor();
    await macroScrollToAndFocus(target);
    await delay(200 + Math.random() * 300);
    await macroClick(target);
    return true;
  }

  // Click Continue button on Groups page to navigate to schedule
  async function clickContinueOnGroupsPage() {
    log('On Groups page — clicking Continue...');
    await delay(1500 + Math.random() * 1500);

    // Try to find Continue button/link
    const candidates = [
      'a.button.primary',
      'a.button.alert',
      'a[href*="continue_actions"]',
      'a[href*="/schedule/"]',
      'button.button.primary',
      'a.btn-primary',
      'input[value="Continue"]'
    ];

    let btn = null;
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) {
        const txt = (el.textContent || el.value || '').trim().toLowerCase();
        if (txt.includes('continue') || el.href) {
          btn = el;
          break;
        }
      }
    }

    // Fallback: any link with "Continue" text
    if (!btn) {
      const allLinks = document.querySelectorAll('a, button');
      for (const a of allLinks) {
        if ((a.textContent || '').trim().toLowerCase() === 'continue') {
          btn = a;
          break;
        }
      }
    }

    if (!btn) {
      log('Continue button not found on Groups page!');
      return false;
    }

    log('Found Continue: ' + (btn.href || btn.textContent || 'button'));

    // Extract schedule ID from href if available BEFORE clicking
    if (btn.href) {
      const m = btn.href.match(/schedule\/(\d+)/);
      if (m) {
        log('Schedule ID from Continue link: ' + m[1]);
        chrome.storage.local.get(['config'], (d) => {
          const c = d.config || {};
          c.scheduleId = m[1];
          chrome.storage.local.set({ config: c });
        });
      }
    }

    // Macro click via real OS mouse
    initCursor();
    await macroScrollToAndFocus(btn);
    await delay(200 + Math.random() * 300);
    await macroClick(btn);
    log('Continue clicked');
    return true;
  }

  // ==================== AUTO LOGIN ====================

  async function doLogin(email, password) {
    log('=== MACRO LOGIN START ===');

    try {
      if (aborted) { log('Aborted'); return; }
      // ===== STEP 1: Wait for email field =====
      log('Step 1: Find email field');
      await dismissBlockingModal();
      let emailField = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        emailField =
          document.getElementById('user_email') ||
          document.querySelector('input[name="user[email]"]') ||
          document.querySelector('input[type="email"]');
        if (emailField) break;
        await delay(500);
      }

      if (!emailField) {
        log('Email field not found');
        chrome.runtime.sendMessage({ type: 'LOGIN_FAILED', reason: 'Email field not found' });
        return;
      }

      initCursor();

      // Short settle pause
      await delay(150 + Math.random() * 200);

      // ===== STEP 2: Scroll email into view & focus =====
      log('Step 2: Focus email field');
      await macroScrollToAndFocus(emailField);

      // ===== STEP 3: Type email via OS keyboard =====
      log('Step 3: Type email');
      await macroFocusAndType(emailField, email);
      if (!forceInputValue(emailField, email, 'email')) {
        resetCursor();
        chrome.runtime.sendMessage({ type: 'LOGIN_FAILED', reason: 'Could not fill email field' });
        return;
      }
      await delay(150 + Math.random() * 150);

      // ===== STEP 4: Find password field =====
      log('Step 4: Find password field');
      const passField =
        document.getElementById('user_password') ||
        document.querySelector('input[name="user[password]"]') ||
        document.querySelector('input[type="password"]');

      if (!passField) {
        log('Password field not found');
        resetCursor();
        chrome.runtime.sendMessage({ type: 'LOGIN_FAILED', reason: 'Password field not found' });
        return;
      }

      // ===== STEP 5: Type password via OS keyboard =====
      log('Step 5: Type password');
      await macroFocusAndType(passField, password);
      if (!forceInputValue(passField, password, 'password')) {
        resetCursor();
        chrome.runtime.sendMessage({ type: 'LOGIN_FAILED', reason: 'Could not fill password field' });
        return;
      }
      await delay(150 + Math.random() * 150);

      // ===== STEP 6: Dismiss any error modal =====
      log('Step 6: Dismiss modal if present');
      await dismissBlockingModal();

      // ===== STEP 7: Check policy checkbox =====
      log('Step 7: Check policy box');
      const policyOk = await ensurePolicyChecked();
      if (!policyOk) {
        log('Policy checkbox could not be verified; continuing cautiously');
      }

      // ===== STEP 8: Scroll to Sign In button =====
      log('Step 8: Find submit button');
      const submitBtn =
        document.querySelector('input[name="commit"]') ||
        document.querySelector('button[name="commit"]') ||
        document.querySelector('input[type="submit"]') ||
        document.querySelector('button[type="submit"]');

      // Short pause before submitting
      await delay(200 + Math.random() * 200);

      if (submitBtn) {
        if (!forceInputValue(emailField, email, 'email') || !forceInputValue(passField, password, 'password')) {
          resetCursor();
          chrome.runtime.sendMessage({ type: 'LOGIN_FAILED', reason: 'Credentials not filled before submit' });
          return;
        }
        await dismissBlockingModal();
        log('Step 9: Click Sign In');
        await macroScrollToAndFocus(submitBtn);
        await macroClick(submitBtn);

        // Check for modal that says "Please select the checkbox..."
        await delay(1200);
        const errModal = document.querySelector('.swal2-popup, .swal-modal, .modal.in, .modal.show');
        if (errModal) {
          const modalText = (errModal.textContent || '').toLowerCase();
          if (modalText.includes('checkbox') || modalText.includes('select')) {
            log('Modal detected: re-checking policy box & resubmitting');
            // Dismiss modal
            const okBtn = errModal.querySelector('.swal2-confirm, .swal-button--confirm, button, .btn');
            if (okBtn) okBtn.click();
            await delay(600);
            // Force-check policy box again
            await ensurePolicyChecked();
            await delay(800);
            // Submit again
            await macroScrollToAndFocus(submitBtn);
            await macroClick(submitBtn);
          }
        }
      } else {
        // Last resort: submit form directly
        const form = document.querySelector('form#sign_in_form') ||
                     document.querySelector('form[action*="sign_in"]') ||
                     document.querySelector('form');
        if (form) {
          log('Submitting form directly');
          form.submit();
        } else {
          log('No submit button or form found!');
          chrome.runtime.sendMessage({ type: 'LOGIN_FAILED', reason: 'No submit button' });
          return;
        }
      }

      // Remove cursor before navigation
      resetCursor();

      if (aborted) { log('Aborted before result'); return; }

      // The site logs in via AJAX: on success the page navigates away; on
      // failure it shows an inline error WITHOUT navigating. So wait for
      // whichever happens first — navigation, an error, or a captcha.
      // (We do NOT call form.submit() — that bypasses the site's handler and
      // hits a raw endpoint that returns a 404.)
      await waitForLoginResult(15000);
      const page = detectPage();
      const loggedInPages = ['logged-in', 'appointment', 'groups', 'continue-actions'];

      if (loggedInPages.includes(page)) {
        log('Login successful! (page: ' + page + ')');
        chrome.runtime.sendMessage({ type: 'LOGIN_SUCCESS' });
      } else if (detectCaptcha()) {
        log('Login blocked: CAPTCHA present');
        chrome.runtime.sendMessage({ type: 'LOGIN_FAILED', reason: 'CAPTCHA on login page — manual login needed' });
      } else {
        const err = getLoginError();
        if (err) {
          // Website rejected the credentials → background will stop (no retry).
          log('Login failed: ' + err);
          chrome.runtime.sendMessage({ type: 'LOGIN_FAILED', reason: err });
        } else {
          // No navigation and no visible error — the click may not have
          // registered. Report as transient so the background retries.
          log('Login: no response after submit');
          chrome.runtime.sendMessage({ type: 'LOGIN_FAILED', reason: 'No response after submit' });
        }
      }

    } catch (err) {
      resetCursor();
      log('Login error: ' + err.message);
      chrome.runtime.sendMessage({ type: 'LOGIN_FAILED', reason: err.message });
    }
  }

  // ==================== SLOT CHECK ====================

  async function checkSlots(config) {
    const page = detectPage();

    if (page === 'login') {
      log('Session expired.');
      done(0, 'login');
      return;
    }

    const scheduleId = findScheduleId(config);
    if (!scheduleId) {
      log('Schedule ID not found.');
      done(0, 'no-schedule');
      return;
    }

    if (!config.scheduleId) {
      config.scheduleId = scheduleId;
      chrome.storage.local.get(['config'], (d) => {
        const c = d.config || {};
        c.scheduleId = scheduleId;
        chrome.storage.local.set({ config: c });
      });
    }

    // Build facility list (support both old single and new multi format)
    const facilities = config.facilities || [{ id: config.facilityId, name: config.facilityName }];
    let totalFound = 0;
    let bestSlot = null;

    for (const fac of facilities) {
      if (aborted) { log('Aborted'); return; }
      log('Checking ' + fac.name + '...');

      try {
        const resp = await fetch(
          '/en-ca/niv/schedule/' + scheduleId + '/appointment/days/' +
          fac.id + '.json?appointments[expedite]=false',
          {
            credentials: 'same-origin',
            headers: {
              'Accept': 'application/json',
              'X-Requested-With': 'XMLHttpRequest',
              'X-CSRF-Token': getCSRF()
            }
          }
        );

        if (resp.status === 401 || resp.status === 403) {
          log('Auth error. Re-login needed.');
          done(0, 'login');
          return;
        }

        // Session expired: the server often answers the JSON request by
        // redirecting to the sign-in page (sometimes as HTTP 200 with HTML,
        // not a 401). Detect that and trigger re-login instead of failing
        // silently on a JSON parse error.
        if (resp.url.includes('/users/sign_in') || resp.redirected) {
          log('Session expired (redirected to login). Re-login needed.');
          done(0, 'login');
          return;
        }
        const ctype = resp.headers.get('content-type') || '';
        if (!ctype.includes('json')) {
          log('Non-JSON response (likely session lost). Re-login needed.');
          done(0, 'login');
          return;
        }

        if (resp.status === 429) {
          log('RATE LIMITED! Pausing checks for 30 min.');
          chrome.runtime.sendMessage({ type: 'RATE_LIMITED' });
          done(0, 'rate-limited');
          return;
        }

        if (!resp.ok) {
          log(fac.name + ': Server ' + resp.status);
          continue;
        }

        const data = await resp.json();
        if (!Array.isArray(data) || data.length === 0) {
          log(fac.name + ': No dates.');
          // Small delay between facility checks to look human
          await delay(1500 + Math.random() * 2000);
          continue;
        }

        // Keep only well-formed YYYY-MM-DD dates, then sort chronologically.
        const allDates = data
          .map(d => d && d.date)
          .filter(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
          .sort();
        const matching = allDates.filter(d => d >= config.dateFrom && d <= config.dateTo);

        if (matching.length === 0) {
          log(fac.name + ': Earliest ' + (allDates[0] || 'none') + ' (out of range)');
          await delay(1500 + Math.random() * 2000);
          continue;
        }

        // A day can be listed with zero bookable times. Verify the actual times
        // (earliest matching day first) so alerts/booking are accurate and we
        // don't raise false "slot found" for an un-bookable day.
        let confirmedDate = null;
        let confirmedTimes = null;
        for (const d of matching) {
          const t = await getTimesForDate(scheduleId, fac.id, d);
          if (t && t.length) { confirmedDate = d; confirmedTimes = t; break; }
          await delay(800 + Math.random() * 700);
        }

        if (!confirmedDate) {
          log(fac.name + ': Days listed but no bookable time. Skipping.');
          await delay(1500 + Math.random() * 2000);
          continue;
        }

        totalFound += 1;
        log('FOUND (bookable) ' + fac.name + ': ' + confirmedDate + ' @ ' + confirmedTimes[0]);

        chrome.runtime.sendMessage({
          type: 'SLOT_FOUND',
          data: { date: confirmedDate, time: confirmedTimes[0], facility: fac.name, facilityId: fac.id, allDates: matching }
        });

        // Track earliest confirmed-bookable slot across all facilities
        if (!bestSlot || confirmedDate < bestSlot.date) {
          bestSlot = { date: confirmedDate, time: confirmedTimes[0], facilityId: fac.id, facilityName: fac.name };
        }

      } catch (err) {
        if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
          log(fac.name + ': Network error. Check internet.');
        } else {
          log(fac.name + ': Error - ' + err.message);
        }
      }

      // Delay between facilities
      if (facilities.indexOf(fac) < facilities.length - 1) {
        await delay(2000 + Math.random() * 3000);
      }
    }

    if (bestSlot && config.autoBook) {
      // Book the earliest slot found across all facilities
      const bookConfig = { ...config, facilityId: bestSlot.facilityId, facilityName: bestSlot.facilityName };
      startBooking(bookConfig, bestSlot.date);
    } else {
      done(totalFound);
    }
  }

  // ==================== BOOKING ====================

  async function startBooking(config, date) {
    log('Booking ' + date + '...');
    const scheduleId = config.scheduleId || findScheduleId(config);
    if (!scheduleId) { log('No schedule ID'); return; }

    try {
      // Get times
      const resp = await fetch(
        '/en-ca/niv/schedule/' + scheduleId + '/appointment/times/' +
        config.facilityId + '.json?date=' + date + '&appointments[expedite]=false',
        {
          credentials: 'same-origin',
          headers: {
            'Accept': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'X-CSRF-Token': getCSRF()
          }
        }
      );

      const data = await resp.json();
      const times = data.available_times || data.business_times || (Array.isArray(data) ? data : []);

      if (times.length === 0) {
        log('No times for ' + date);
        done(1);
        return;
      }

      const time = times[0];
      log('Time: ' + time + '. Going to form...');

      // Save state and navigate
      chrome.storage.local.set({
        bookingState: {
          step: 'fill-form',
          date, time,
          facilityId: config.facilityId,
          facilityName: config.facilityName,
          scheduleId
        }
      });

      window.location.href = '/en-ca/niv/schedule/' + scheduleId + '/appointment';

    } catch (err) {
      log('Booking error: ' + err.message);
      chrome.storage.local.remove('bookingState');
      done(1);
    }
  }

  function handleBookingContinuation(state, config) {
    const url = window.location.href;

    if (state.step === 'fill-form' && url.includes('/appointment')) {
      log('Filling booking form...');
      waitForEl('#appointments_consulate_appointment_facility_id', 10000)
        .then(() => fillBookingForm(state))
        .catch(() => setTimeout(() => fillBookingForm(state), 3000));
    }
    else if (state.step === 'confirm') {
      log('Confirming...');
      setTimeout(() => clickConfirm(state), 1500 + Math.random() * 1000);
    }
    else if (state.step === 'done') {
      chrome.storage.local.remove('bookingState');
    }
  }

  async function fillBookingForm(state) {
    try {
      const facSelect = document.getElementById('appointments_consulate_appointment_facility_id');
      if (facSelect && facSelect.value !== state.facilityId) {
        facSelect.value = state.facilityId;
        facSelect.dispatchEvent(new Event('change', { bubbles: true }));
        await delay(2000 + Math.random() * 1500);
      }

      await waitForEl('#appointments_consulate_appointment_date', 8000);
      await delay(600 + Math.random() * 600);

      const dateInput = document.getElementById('appointments_consulate_appointment_date');
      dateInput.click();
      await delay(800 + Math.random() * 700);

      const [yr, mo, dy] = state.date.split('-').map(Number);
      await navigateToMonth(yr, mo - 1);
      await delay(300 + Math.random() * 300);

      if (!clickDay(dy, yr, mo - 1)) {
        log('Date ' + state.date + ' gone from calendar.');
        chrome.storage.local.remove('bookingState');
        done(0);
        return;
      }

      log('Date clicked: ' + state.date);
      await delay(1500 + Math.random() * 1000);

      await waitForEl('#appointments_consulate_appointment_time', 8000);
      await delay(400 + Math.random() * 400);

      const timeSelect = document.getElementById('appointments_consulate_appointment_time');
      let picked = false;
      for (const opt of timeSelect.options) {
        if (opt.value === state.time) { timeSelect.value = state.time; picked = true; break; }
      }
      if (!picked) {
        for (const opt of timeSelect.options) {
          if (opt.value) { timeSelect.value = opt.value; state.time = opt.value; break; }
        }
      }
      timeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      log('Time: ' + state.time);

      await delay(800 + Math.random() * 700);

      chrome.storage.local.set({ bookingState: { ...state, step: 'confirm' } });

      const submitBtn = document.getElementById('appointments_submit');
      if (submitBtn) {
        submitBtn.click();
        log('Submitted. Waiting for confirm page...');
      }

    } catch (err) {
      log('Form error: ' + err.message);
      chrome.storage.local.remove('bookingState');
    }
  }

  function clickConfirm(state) {
    const btn = document.querySelector(
      'a[href*="confirm"], input[value="Confirm"], a.button.alert'
    );
    if (btn) {
      btn.click();
      log('CONFIRMED! ' + state.date + ' ' + state.time);
      chrome.storage.local.set({ bookingState: { step: 'done' } });
      chrome.runtime.sendMessage({
        type: 'BOOKING_RESULT',
        data: { success: true, date: state.date, time: state.time, facility: state.facilityName }
      });
    } else {
      log('Confirm button not found. Confirm manually!');
      chrome.storage.local.remove('bookingState');
    }
  }

  // ==================== SCHEDULE NAVIGATION ====================

  function findScheduleOnPage() {
    // 1. Check current URL for schedule ID
    const urlMatch = window.location.href.match(/schedule\/(\d+)/);
    if (urlMatch) return { scheduleId: urlMatch[1] };

    // 2. Check current URL for group ID (often same as schedule ID)
    const groupMatch = window.location.href.match(/groups\/(\d+)/);

    // 3. Check all links on page for schedule ID
    const links = document.querySelectorAll('a[href*="/schedule/"]');
    for (const link of links) {
      const match = link.href.match(/schedule\/(\d+)/);
      if (match) return { scheduleId: match[1] };
    }

    // 4. Check continue_actions links
    const contLinks = document.querySelectorAll('a[href*="continue_actions"]');
    for (const link of contLinks) {
      const match = link.href.match(/schedule\/(\d+)/);
      if (match) return { scheduleId: match[1] };
    }

    // 5. If on groups page, use group ID as schedule ID
    if (groupMatch) {
      log('Using group ID as schedule ID: ' + groupMatch[1]);
      return { scheduleId: groupMatch[1] };
    }

    return { scheduleId: null };
  }

  function goToSchedulePage() {
    // Try multiple selectors for the "Continue" or navigation links
    const selectors = [
      'a[href*="continue_actions"]',
      'a[href*="/schedule/"]',
      '.button.primary',
      'a.btn-primary',
      'a[href*="appointment"]'
    ];

    for (const sel of selectors) {
      const link = document.querySelector(sel);
      if (link && link.href) {
        log('Clicking: ' + link.textContent.trim().substring(0, 30));
        link.click();
        return;
      }
    }

    // Fallback: look for any link with "Continue" text
    const allLinks = document.querySelectorAll('a');
    for (const a of allLinks) {
      const txt = a.textContent.trim().toLowerCase();
      if (txt.includes('continue') || txt.includes('schedule') || txt.includes('appointment')) {
        log('Clicking link: ' + a.textContent.trim().substring(0, 30));
        a.click();
        return;
      }
    }

    log('No navigation link found on this page');
  }

  // ==================== HELPERS ====================

  function findScheduleId(config) {
    if (config.scheduleId) return config.scheduleId;
    const m = window.location.href.match(/schedule\/(\d+)/);
    if (m) return m[1];
    const g = window.location.href.match(/groups\/(\d+)/);
    if (g) return g[1];
    const links = document.querySelectorAll('a[href*="/schedule/"]');
    for (const l of links) {
      const match = l.href.match(/schedule\/(\d+)/);
      if (match) return match[1];
    }
    const contLinks = document.querySelectorAll('a[href*="continue_actions"]');
    for (const l of contLinks) {
      const match = l.href.match(/schedule\/(\d+)/);
      if (match) return match[1];
    }
    return null;
  }

  function getCSRF() {
    const el = document.querySelector('meta[name="csrf-token"]');
    return el ? el.getAttribute('content') : '';
  }

  // Fetch the actual bookable times for a given date. Returns [] on any error
  // or if the session redirected to login. Used to confirm a day is really
  // bookable before alerting/booking.
  async function getTimesForDate(scheduleId, facilityId, date) {
    try {
      const resp = await fetch(
        '/en-ca/niv/schedule/' + scheduleId + '/appointment/times/' +
        facilityId + '.json?date=' + date + '&appointments[expedite]=false',
        {
          credentials: 'same-origin',
          headers: {
            'Accept': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'X-CSRF-Token': getCSRF()
          }
        }
      );
      if (!resp.ok || resp.url.includes('/users/sign_in')) return [];
      const ctype = resp.headers.get('content-type') || '';
      if (!ctype.includes('json')) return [];
      const d = await resp.json();
      return d.available_times || d.business_times || (Array.isArray(d) ? d : []);
    } catch (e) {
      return [];
    }
  }

  function done(found, page) {
    chrome.runtime.sendMessage({ type: 'CHECK_COMPLETE', data: { found: found || 0, currentPage: page || 'ok' } });
  }

  function log(text) {
    try { chrome.runtime.sendMessage({ type: 'LOG', text }); } catch (e) {}
  }

  function delay(ms) {
    // Abort-aware: a long pause ends early if STOP was pressed, so sequences
    // don't keep running for seconds after the user stops them.
    return new Promise((resolve) => {
      if (aborted) { resolve(); return; }
      let waited = 0;
      const step = 200;
      const iv = setInterval(() => {
        waited += step;
        if (aborted || waited >= ms) { clearInterval(iv); resolve(); }
      }, step);
    });
  }

  // ==================== MACRO STEP HELPERS ====================
  // Each "step" is one logical action: focus a field, click button, etc.
  // Uses native OS mouse/keyboard via the visa_mouse.py host.

  async function macroClick(el, opts) {
    opts = opts || {};
    if (!el || aborted) return false;
    initCursor();
    await moveCursorTo(el);
    await delay(40 + Math.random() * 80);
    await clickAtCursor(el);
    if (opts.fallbackClick !== false) el.click();
    await delay((opts.after || 100) + Math.random() * 100);
    return true;
  }

  async function macroFocusAndType(el, text) {
    if (!el) return false;
    await macroClick(el, { after: 250 });
    await typeHuman(el, text);
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }

  async function macroPressEnter() {
    await pressKey('enter');
  }

  async function macroPressTab() {
    await pressKey('tab');
  }

  async function macroScrollDown(clicks) {
    await osScroll(-(clicks || 3));
  }

  async function macroScrollUp(clicks) {
    await osScroll(clicks || 3);
  }

  // Scroll element into view, then move real cursor to it
  async function macroScrollToAndFocus(el) {
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await delay(120 + Math.random() * 120);
    initCursor();
    await moveCursorTo(el);
    await delay(60 + Math.random() * 80);
  }

  // ==================== POLICY CHECKBOX ====================

  async function ensurePolicyChecked() {
    var cb = document.getElementById('policy_confirmed') ||
             document.querySelector('input[name="policy_confirmed"]');
    if (!cb) { log('No policy checkbox'); return true; }
    if (cb.checked) { log('Checkbox already checked'); return true; }

    log('Force-checking policy box (all methods)...');

    var wrapper = cb.closest('[class*="icheckbox"], [class*="iCheck"]');
    log('Wrapper: ' + (wrapper ? wrapper.className : 'NONE'));

    // METHOD 1: Native setter — bypasses iCheck's defenses on the input
    try {
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked').set;
      setter.call(cb, true);
    } catch (e) {
      cb.checked = true;
    }

    // METHOD 2: Update iCheck visual state via wrapper class
    if (wrapper) {
      wrapper.classList.add('checked');
      wrapper.classList.remove('hover');
    }

    // METHOD 3: Dispatch ALL events iCheck/jQuery might listen for
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    cb.dispatchEvent(new Event('input', { bubbles: true }));
    cb.dispatchEvent(new Event('ifChecked', { bubbles: true }));
    cb.dispatchEvent(new Event('ifChanged', { bubbles: true }));
    cb.dispatchEvent(new Event('ifClicked', { bubbles: true }));

    // NOTE: We used to inject an inline <script> here to call jQuery/iCheck in
    // the page world, but usvisa-info's Content Security Policy blocks inline
    // scripts. It's not needed anyway — the form submits the input's actual
    // checked state (set via the native setter above), so the server receives
    // the accepted policy regardless of iCheck's visual wrapper.

    await delay(300);

    // Fallback: if the input still isn't checked, do a real click. iCheck
    // toggles, so only click when it's currently unchecked.
    if (!cb.checked) {
      log('Still unchecked, trying native click...');
      try { cb.click(); } catch (e) {}
      await delay(300);
    }

    var wrapperChecked = wrapper ? wrapper.classList.contains('checked') : false;
    log('Result: cb.checked=' + cb.checked + ', wrapper.checked=' + wrapperChecked);
    return cb.checked || wrapperChecked;
  }

  // ==================== REAL OS MOUSE (via Native Host) ====================
  // Sends mouse commands to background → native messaging host (Python)
  // → Windows API SetCursorPos / mouse_event. Real cursor moves on screen.

  var lastX = 0;
  var lastY = 0;
  var cursorInit = false;
  var nativeOk = true;
  // Native OS mouse AND keyboard are DISABLED on purpose:
  //  - Mouse: page→screen coordinate mapping is unreliable (side panel / DPI),
  //    so the cursor flew off to empty areas.
  //  - Keyboard: OS keystrokes go to whatever has OS focus, which turned out to
  //    be the address bar / Google search instead of the visa field — that could
  //    leak the password. Synthetic input writes straight into the right field.
  var useNativeMouse = false;
  var useNativeKeyboard = false;

  function initCursor() {
    if (cursorInit) return;
    lastX = Math.random() * window.innerWidth * 0.4;
    lastY = Math.random() * window.innerHeight * 0.4;
    cursorInit = true;
  }

  function resetCursor() {
    cursorInit = false;
  }

  // Convert viewport coords (inside the webpage) to physical screen coords for
  // the native host. The native host moves the OS cursor in PHYSICAL pixels,
  // but everything in JS is in CSS (logical) pixels — so on a scaled display
  // (125% / 150% etc.) we must multiply by devicePixelRatio, otherwise the
  // cursor lands too far up-left in empty space. Results are clamped to the
  // screen so the cursor never flies off to nothing.
  function viewportToScreen(vx, vy) {
    const dpr = window.devicePixelRatio || 1;
    let x = (window.screenX + (window.outerWidth - window.innerWidth) / 2 + vx) * dpr;
    let y = (window.screenY + (window.outerHeight - window.innerHeight) + vy) * dpr;
    const maxX = (window.screen.width || 1920) * dpr - 1;
    const maxY = (window.screen.height || 1080) * dpr - 1;
    x = Math.max(0, Math.min(x, maxX));
    y = Math.max(0, Math.min(y, maxY));
    return { x, y };
  }

  function nativeCall(cmd, payload) {
    return new Promise((resolve) => {
      // Stop driving the real mouse/keyboard the instant STOP is pressed.
      if (aborted) { resolve(null); return; }
      try {
        chrome.runtime.sendMessage({ type: 'NATIVE_MOUSE', cmd: cmd, payload: payload }, (resp) => {
          if (chrome.runtime.lastError || !resp || !resp.ok) {
            nativeOk = false;
            resolve(null);
            return;
          }
          resolve(resp);
        });
      } catch (e) {
        nativeOk = false;
        resolve(null);
      }
    });
  }

  async function moveCursorTo(el) {
    if (!el) return;
    initCursor();

    var rect = el.getBoundingClientRect();
    var vx = rect.left + rect.width * (0.25 + Math.random() * 0.5);
    var vy = rect.top + rect.height * (0.25 + Math.random() * 0.5);

    lastX = vx;
    lastY = vy;

    // Real OS cursor movement is disabled (unreliable screen mapping). Use
    // synthetic events on the exact element instead.
    if (nativeOk && useNativeMouse) {
      var screen = viewportToScreen(vx, vy);
      var resp = await nativeCall('move', { x: Math.round(screen.x), y: Math.round(screen.y) });
      if (resp && resp.ok) {
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: vx, clientY: vy, view: window }));
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: vx, clientY: vy, view: window }));
        el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: vx, clientY: vy, view: window }));
        return;
      }
    }

    // Synthetic events only (no real cursor) — clicks land on the exact element
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: vx, clientY: vy, view: window }));
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: vx, clientY: vy, view: window }));
    el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: vx, clientY: vy, view: window }));
  }

  async function clickAtCursor(el) {
    var x = lastX;
    var y = lastY;

    // Real OS click disabled (cursor mapping unreliable). The synthetic click
    // below acts on the exact element, so the action still happens correctly.
    if (nativeOk && useNativeMouse) {
      await nativeCall('click', {});
    }

    // Always dispatch synthetic events (page JS listens for these)
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, view: window }));
    await delay(50 + Math.random() * 60);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, view: window }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, view: window }));
  }

  // Set input value using native setter (works with all frameworks)
  var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

  function forceInputValue(el, text, label) {
    if (!el) return false;
    try {
      nativeSetter.call(el, text);
    } catch (e) {
      el.value = text;
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: text }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Tab' }));

    if (el.value !== text) {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const ok = el.value === text;
    log((label || 'input') + ' value ' + (ok ? 'verified' : 'mismatch after fill'));
    return ok;
  }

  async function dismissBlockingModal() {
    const modal =
      document.querySelector('.swal2-popup, .swal-modal, .modal.in, .modal.show') ||
      document.querySelector('[role="dialog"]');
    if (!modal) return false;

    const btn =
      modal.querySelector('.swal2-confirm, .swal-button--confirm, button.confirm, .btn-success, button') ||
      document.querySelector('.swal2-confirm, .swal-button--confirm, button.confirm, .modal .btn-success');
    if (!btn) return false;

    log('Dismissing blocking modal');
    try {
      await macroClick(btn, { after: 500 });
    } catch (e) {
      try { btn.click(); } catch (_) {}
      await delay(500);
    }
    return true;
  }

  // Type text — uses real OS keyboard via native host if available,
  // falls back to synthetic events otherwise.
  async function typeHuman(el, text) {
    el.setAttribute('autocomplete', 'off');
    el.focus();
    el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    await delay(100 + Math.random() * 150);

    // Clear field first
    nativeSetter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));

    // Native OS keyboard is disabled: it types into whatever has OS focus,
    // which can be the address bar / Google search instead of this field
    // (leaking the password). Type with synthetic events straight into el.
    if (nativeOk && useNativeKeyboard) {
      await nativeCall('key', { keys: ['ctrl', 'a'] });
      await delay(80);
      await nativeCall('key', { key: 'delete' });
      await delay(80);
      var resp = await nativeCall('type', { text: text });
      if (resp && resp.ok) {
        await delay(200);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        if (el.value === text) {
          log('Typed via native OS keyboard');
          return;
        }
        log('Native type produced "' + el.value + '" expected "' + text + '" — using fallback');
      }
    }

    // Synthetic key events + nativeSetter (reliable, stays in this field)
    for (var i = 0; i < text.length; i++) {
      if (aborted) return;
      var char = text[i];
      var keyOpts = { key: char, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
      el.dispatchEvent(new KeyboardEvent('keypress', keyOpts));
      nativeSetter.call(el, text.substring(0, i + 1));
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: char }));
      el.dispatchEvent(new KeyboardEvent('keyup', keyOpts));

      // Very fast typing with a touch of variation (quick but not robotic).
      var baseDelay = 12 + Math.random() * 28;
      if ('@.-_!#$%'.includes(char)) baseDelay += 15 + Math.random() * 30;
      if (char >= '0' && char <= '9') baseDelay += 8 + Math.random() * 15;
      if (Math.random() < 0.08) baseDelay += 50 + Math.random() * 80;
      await delay(baseDelay);
    }

    el.dispatchEvent(new Event('change', { bubbles: true }));
    await delay(100);
    if (el.value !== text) {
      nativeSetter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (el.value !== text) {
        el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }

  // Press a key (Enter, Tab, etc.). Native keyboard is disabled (focus leaks),
  // so this is a no-op unless explicitly re-enabled — login uses a button click.
  async function pressKey(keyName) {
    if (nativeOk && useNativeKeyboard) {
      await nativeCall('key', { key: keyName });
      await delay(50 + Math.random() * 80);
    }
  }

  // Scroll the page. Use the page's own scroll (not the native OS wheel, which
  // could scroll the wrong window).
  async function osScroll(amount) {
    window.scrollBy({ top: amount * -100, behavior: 'smooth' });
    await delay(100 + Math.random() * 200);
  }

  function waitForEl(selector, timeout) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) { resolve(el); return; }
      const obs = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) { obs.disconnect(); resolve(el); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); reject(new Error('timeout')); }, timeout);
    });
  }

  // Wait until login resolves: either the page navigates away from /sign_in
  // (success), or an inline error / captcha appears (AJAX failure) — whichever
  // comes first, or until timeout.
  function waitForLoginResult(timeout) {
    return new Promise((resolve) => {
      const start = Date.now();
      const iv = setInterval(() => {
        const settled = !window.location.href.includes('/sign_in') ||
                        detectCaptcha() || !!getLoginError();
        if (settled || Date.now() - start >= timeout) {
          clearInterval(iv);
          resolve();
        }
      }, 400);
    });
  }

  function waitForNavigation(timeout) {
    return new Promise((resolve) => {
      let resolved = false;
      const check = setInterval(() => {
        if (!window.location.href.includes('/sign_in') || resolved) {
          clearInterval(check);
          if (!resolved) { resolved = true; resolve(); }
        }
      }, 500);
      // Also resolve on full page load event
      window.addEventListener('load', () => {
        if (!resolved) { resolved = true; clearInterval(check); resolve(); }
      }, { once: true });
      setTimeout(() => {
        if (!resolved) { resolved = true; clearInterval(check); resolve(); }
      }, timeout);
    });
  }

  async function navigateToMonth(yr, mo) {
    for (let i = 0; i < 24; i++) {
      const monthEl = document.querySelector('.ui-datepicker-month');
      const yearEl = document.querySelector('.ui-datepicker-year');
      if (!monthEl || !yearEl) return;
      const months = ['January','February','March','April','May','June',
                      'July','August','September','October','November','December'];
      const monTxt = monthEl.textContent.trim();
      let curMo = months.indexOf(monTxt);
      if (curMo < 0) curMo = months.findIndex(m => m.slice(0, 3) === monTxt.slice(0, 3));
      const curYr = parseInt(yearEl.textContent.trim());
      if (curMo < 0) return; // unknown month label — avoid blind navigation
      if (curYr === yr && curMo === mo) return;
      const btn = (new Date(yr, mo) > new Date(curYr, curMo))
        ? document.querySelector('.ui-datepicker-next')
        : document.querySelector('.ui-datepicker-prev');
      if (btn) btn.click();
      await delay(400 + Math.random() * 400);
    }
  }

  // Click a day, scoped to the correct month panel. The datepicker can show
  // two months at once, so matching by day-number alone could click the same
  // day in the wrong month. When yr/mo are given, only click inside the panel
  // whose header matches.
  function clickDay(day, yr, mo) {
    const months = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];
    const groups = document.querySelectorAll('.ui-datepicker-group');
    const scopes = groups.length
      ? Array.from(groups)
      : [document.querySelector('.ui-datepicker') || document];

    for (const scope of scopes) {
      if (yr != null && mo != null) {
        const moEl = scope.querySelector('.ui-datepicker-month');
        const yrEl = scope.querySelector('.ui-datepicker-year');
        if (moEl && yrEl) {
          let curMo = months.indexOf(moEl.textContent.trim());
          if (curMo < 0) {
            curMo = months.findIndex(m => m.slice(0, 3) === moEl.textContent.trim().slice(0, 3));
          }
          const curYr = parseInt(yrEl.textContent.trim());
          if (curMo !== mo || curYr !== yr) continue; // wrong panel, skip
        }
      }
      const links = scope.querySelectorAll('td:not(.ui-datepicker-unselectable) a.ui-state-default');
      for (const l of links) {
        if (parseInt(l.textContent.trim()) === day) { l.click(); return true; }
      }
    }
    return false;
  }

})();
