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

      // Reschedule auto-detect: booked date still unknown → try reading it off
      // this page (the Groups page shows it right after login).
      if (data.config && data.config.mode === 'reschedule' && !data.config.bookedDate &&
          page !== 'login' && page !== 'unknown') {
        detectBookedDateIfNeeded();
      }

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
      case 'GET_BOOKED_DATE':
        sendResponse({ date: extractBookedDate() });
        break;
      case 'DETECT_BOOKED_DATE':
        chrome.storage.local.get(['config'], (d) => {
          const c = d.config || {};
          let date = null;
          if (c.mode === 'reschedule' && !c.bookedDate) {
            date = extractBookedDate();
            if (date) saveDetectedBookedDate(date);
          }
          sendResponse({ date });
        });
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
    // The header usually has an icon or is an h5/a tag without a specific appointment href.
    // With an existing booking the site labels it "Reschedule Appointment" instead.
    const allLinks = document.querySelectorAll('a, h5, .accordion-title, .accordion-item');
    for (const el of allLinks) {
      const txt = (el.textContent || '').trim().toLowerCase();
      if ((txt === 'schedule appointment' || txt === 'reschedule appointment') && !el.href?.includes('/appointment')) {
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
    // Read booked date from the Groups page before navigation wipes it.
    await detectBookedDateIfNeeded();
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

  // ==================== PREFERRED TIME ====================

  function timeToMinutes(t) {
    if (!t) return null;
    const s = String(t).trim();
    const m24 = s.match(/^(\d{1,2}):(\d{2})$/);
    if (m24) return parseInt(m24[1], 10) * 60 + parseInt(m24[2], 10);
    const m12 = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (m12) {
      let h = parseInt(m12[1], 10);
      const min = parseInt(m12[2], 10);
      if (m12[3].toUpperCase() === 'PM' && h < 12) h += 12;
      if (m12[3].toUpperCase() === 'AM' && h === 12) h = 0;
      return h * 60 + min;
    }
    return null;
  }

  function filterTimesByPreference(times, config) {
    if (!config || (!config.timeFrom && !config.timeTo)) return times;
    const from = config.timeFrom ? timeToMinutes(config.timeFrom) : 0;
    const to = config.timeTo ? timeToMinutes(config.timeTo) : 24 * 60;
    if (from == null || to == null) return times;
    const filtered = times.filter((t) => {
      const m = timeToMinutes(t);
      return m != null && m >= from && m <= to;
    });
    return filtered.length ? filtered : times;
  }

  function pickPreferredTime(times, config) {
    const pool = filterTimesByPreference(times, config);
    return pool[0] || null;
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

    // Reschedule auto-detect: without the booked date there is no upper bound,
    // so try reading it from the current page; if it still can't be found,
    // skip this check (the next page navigation usually picks it up).
    if (config.mode === 'reschedule' && !config.bookedDate) {
      const found = extractBookedDate();
      if (found) {
        config.bookedDate = found;
        config.dateTo = dayBeforeISO(found);
        saveDetectedBookedDate(found);
      } else {
        log('Reschedule: booked date not detected yet — visit the Groups page once, or enter it manually.');
        done(0);
        return;
      }
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

        // Log whenever the earliest available date MOVES — this is how you see
        // cancellations happening (a date opening/closing), even out of range.
        await noteEarliest(fac.id, fac.name, allDates[0] || null);

        let matching = allDates.filter(d => d >= config.dateFrom && d <= config.dateTo);
        // Reschedule mode safety net: only dates strictly BEFORE the existing
        // booking count (dateTo already enforces this; double-guard anyway so a
        // stale/edited config can never "reschedule" to a later date).
        if (config.bookedDate) matching = matching.filter(d => d < config.bookedDate);

        if (matching.length === 0) {
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
          const preferred = t && t.length ? pickPreferredTime(t, config) : null;
          if (preferred) { confirmedDate = d; confirmedTimes = filterTimesByPreference(t, config); break; }
          await delay(800 + Math.random() * 700);
        }

        if (!confirmedDate) {
          log(fac.name + ': Days listed but no bookable time. Skipping.');
          await delay(1500 + Math.random() * 2000);
          continue;
        }

        const slotTime = confirmedTimes[0];
        totalFound += 1;
        log('FOUND (bookable) ' + fac.name + ': ' + confirmedDate + ' @ ' + slotTime);

        chrome.runtime.sendMessage({
          type: 'SLOT_FOUND',
          data: { date: confirmedDate, time: slotTime, facility: fac.name, facilityId: fac.id, allDates: matching }
        });

        // Track earliest confirmed-bookable slot across all facilities
        if (!bestSlot || confirmedDate < bestSlot.date) {
          bestSlot = { date: confirmedDate, time: slotTime, facilityId: fac.id, facilityName: fac.name };
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
      startBooking(bookConfig, bestSlot.date, bestSlot.time);
    } else {
      done(totalFound);
    }
  }

  // ==================== BOOKING ====================

  async function startBooking(config, date, preferredTime) {
    // Reschedule mode: never book a date that isn't earlier than the current
    // appointment — that would move the booking BACKWARD.
    if (config.bookedDate && date >= config.bookedDate) {
      log('Skip booking ' + date + ' — not earlier than current booking ' + config.bookedDate);
      done(0);
      return;
    }
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

      const time = preferredTime && times.indexOf(preferredTime) !== -1
        ? preferredTime
        : pickPreferredTime(times, config);
      if (!time) {
        log('No preferred time for ' + date);
        done(1);
        return;
      }
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
        .then(() => fillBookingForm(state, config))
        .catch(() => fillBookingForm(state, config));   // try anyway if selector differs
    }
    else if (state.step === 'confirm') {
      log('Confirming booking...');
      clickConfirm(state);   // waits for the confirm button itself
    }
    else if (state.step === 'done') {
      // Confirm was clicked on the previous page and navigation destroyed that
      // script before it could verify/report — do it here, on whichever page
      // we landed on, using the details carried over in bookingState.
      log('Verifying booking result on new page...');
      delay(400 + Math.random() * 400).then(() => finalizeBooking(state));
    }
  }

  // Abandon the current booking and let monitoring keep looking for slots.
  function abortBooking(reason) {
    log('Booking aborted: ' + reason);
    chrome.storage.local.remove('bookingState');
    chrome.runtime.sendMessage({ type: 'BOOKING_RESULT', data: { success: false, reason: reason } });
  }

  async function fillBookingForm(state, config) {
    try {
      if (aborted) return;

      // 1. Facility dropdown (if present and not already set).
      const facSelect = document.getElementById('appointments_consulate_appointment_facility_id');
      if (facSelect && state.facilityId && facSelect.value !== state.facilityId) {
        facSelect.value = state.facilityId;
        facSelect.dispatchEvent(new Event('change', { bubbles: true }));
        await delay(1500 + Math.random() * 1000);
      }

      // 2. Open the date picker.
      await waitForEl('#appointments_consulate_appointment_date', 8000);
      await delay(300 + Math.random() * 300);
      if (aborted) return;
      const dateInput = document.getElementById('appointments_consulate_appointment_date');
      dateInput.click();
      await delay(400 + Math.random() * 400);

      // 3. Navigate to the month and click the day.
      const [yr, mo, dy] = state.date.split('-').map(Number);
      await navigateToMonth(yr, mo - 1);
      await delay(200 + Math.random() * 200);

      // Cross-check: what dates does the calendar DOM actually show as open?
      logCalendarDates(yr, mo - 1);

      if (!clickDay(dy, yr, mo - 1)) {
        // The date was taken between finding it and booking it — keep monitoring.
        abortBooking('date ' + state.date + ' no longer in calendar');
        done(0);
        return;
      }
      log('Date clicked: ' + state.date);
      await delay(800 + Math.random() * 600);
      if (aborted) return;

      // 4. Time dropdown.
      await waitForEl('#appointments_consulate_appointment_time', 8000);
      await delay(300 + Math.random() * 300);
      const timeSelect = document.getElementById('appointments_consulate_appointment_time');

      // Collect real (non-empty) options.
      const realTimes = Array.from(timeSelect.options).map(o => o.value).filter(Boolean);
      if (realTimes.length === 0) {
        // No times left for this date — slot taken. Keep monitoring.
        abortBooking('no times left for ' + state.date);
        done(0);
        return;
      }
      // Prefer the exact time we found, else the best match in the preferred window.
      const inWindow = filterTimesByPreference(realTimes, config);
      const chosen = realTimes.indexOf(state.time) !== -1
        ? state.time
        : (inWindow[0] || realTimes[0]);
      timeSelect.value = chosen;
      state.time = chosen;
      timeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      log('Time: ' + chosen);
      await delay(500 + Math.random() * 500);
      if (aborted) return;

      // 5. Submit the appointment form.
      chrome.storage.local.set({ bookingState: { ...state, step: 'confirm' } });
      const submitBtn = document.getElementById('appointments_submit') ||
                        document.querySelector('input[name="commit"], button[name="commit"], input[type="submit"]');
      if (submitBtn) {
        submitBtn.click();
        log('Submitted booking. Waiting for confirmation...');
      } else {
        abortBooking('submit button not found');
      }

    } catch (err) {
      abortBooking('form error: ' + err.message);
    }
  }

  async function clickConfirm(state) {
    if (aborted) return;

    // usvisa-info asks for a final confirmation — usually a SweetAlert modal
    // ("You're about to schedule…") with a Confirm button, sometimes a plain
    // Confirm link/button.
    let btn = null;
    try {
      btn = await waitForEl('.swal2-confirm, a[href*="confirm"], input[value="Confirm"], button[name="commit"], a.button.alert', 8000);
    } catch (e) { btn = null; }

    if (!btn) {
      // No confirm button found — could genuinely be stuck, or the site may
      // have already booked without one. Check for a positive signal first
      // instead of assuming failure (which would wrongly resume monitoring).
      if (pageIndicatesBooked()) {
        log('No confirm button, but page shows the booking succeeded.');
        await finalizeBooking(state);
        return;
      }
      log('Confirm button not found — please confirm manually!');
      chrome.storage.local.remove('bookingState');
      chrome.runtime.sendMessage({
        type: 'BOOKING_RESULT',
        data: { success: false, reason: 'confirm button not found', date: state.date, time: state.time, facility: state.facilityName }
      });
      return;
    }

    // Save full details BEFORE clicking — the click likely navigates the page
    // (real form submit), which destroys this script mid-flight before it can
    // verify/report. If that happens, the next page load's
    // handleBookingContinuation (step 'done') picks up right here with the
    // same date/time/facility instead of losing them.
    chrome.storage.local.set({ bookingState: { ...state, step: 'done' } });
    btn.click();
    log('Clicked Confirm — verifying...');
    await delay(2500 + Math.random() * 1500);
    if (aborted) return;

    // Still here → the click didn't navigate away. Verify on this same page.
    await finalizeBooking(state);
  }

  // A page-level positive signal that the appointment was actually scheduled
  // (used to avoid false "failed" reports when failure-keyword matching alone
  // is ambiguous, or when no confirm button exists because it already booked).
  function pageIndicatesBooked() {
    const body = (document.body && document.body.innerText || '').toLowerCase();
    return body.includes('has been scheduled') || body.includes('successfully scheduled') ||
           body.includes('confirmation number') || body.includes('appointment confirmation') ||
           body.includes('you have successfully');
  }

  // Verify the booking result on whatever page we're currently on and report
  // it exactly once. Clears bookingState first so a stray extra page load
  // can't re-report the same result.
  async function finalizeBooking(state) {
    chrome.storage.local.remove('bookingState');

    const body = (document.body && document.body.innerText || '').toLowerCase();
    const failed =
      (body.includes('no longer available') || body.includes('not available') ||
       body.includes('could not') || body.includes('try again') ||
       !!document.querySelector('.alert-danger, .flash-error')) &&
      !pageIndicatesBooked();

    if (failed) {
      log('Confirmation failed — slot likely taken. Resuming monitoring.');
      chrome.runtime.sendMessage({
        type: 'BOOKING_RESULT',
        data: { success: false, reason: 'slot taken at confirm', date: state.date, time: state.time, facility: state.facilityName }
      });
    } else {
      log('BOOKED! ' + state.date + ' ' + state.time);
      chrome.runtime.sendMessage({
        type: 'BOOKING_RESULT',
        data: { success: true, date: state.date, time: state.time, facility: state.facilityName }
      });
    }
  }

  // ==================== BOOKED-DATE DETECTION ====================
  // Reads the CURRENTLY BOOKED appointment date off the page, so reschedule
  // mode can auto-fill it instead of the user typing it in.

  const MONTH_NUM = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
  };

  function monthFromName(name) {
    const key = (name || '').toLowerCase();
    if (MONTH_NUM[key]) return MONTH_NUM[key];
    const abbr = key.slice(0, 3);
    for (const m of Object.keys(MONTH_NUM)) {
      if (m.slice(0, 3) === abbr) return MONTH_NUM[m];
    }
    return null;
  }

  function fmtDate(y, mo, d) {
    return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  function dayBeforeISO(iso) {
    const p = iso.split('-').map(Number);
    const dt = new Date(p[0], p[1] - 1, p[2] - 1);
    return fmtDate(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
  }

  // Pull a "26 October, 2027" / "October 26, 2027" / "2027-10-26" style date
  // out of a blob of text. Returns YYYY-MM-DD or null.
  function parseApptDate(text) {
    if (!text) return null;
    let m = text.match(/(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(\d{4})/);
    if (m) {
      const mo = monthFromName(m[2]);
      if (mo) return fmtDate(+m[3], mo, +m[1]);
    }
    m = text.match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/);
    if (m) {
      const mo = monthFromName(m[1]);
      if (mo) return fmtDate(+m[3], mo, +m[2]);
    }
    m = text.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[0];
    return null;
  }

  // Find the booked appointment date on the current page. Most reliable on the
  // Groups page (".consular-appt": "Consular Appointment: 26 October, 2027,
  // 08:30 Toronto local time"), with text fallbacks for other logged-in pages.
  // Only FUTURE dates are accepted (a booked appointment is always ahead).
  function extractBookedDate() {
    const now = new Date();
    const today = fmtDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
    const candidates = [];

    // 1. Known appointment elements (Groups page cards).
    document.querySelectorAll('.consular-appt, .appointment-date, [class*="appt"]').forEach((el) => {
      candidates.push(el.textContent || '');
    });

    // 2. Page-text lines, most specific phrase first.
    const lines = ((document.body && document.body.innerText) || '').split('\n');
    for (const line of lines) {
      if (/consular appointment/i.test(line)) candidates.push(line);
    }
    for (const line of lines) {
      if (/appointment|scheduled/i.test(line)) candidates.push(line);
    }

    for (const text of candidates) {
      const d = parseApptDate(text);
      if (d && d >= today) return d;
    }
    return null;
  }

  // Try reading the booked date when reschedule mode is active and unknown.
  function detectBookedDateIfNeeded() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['config'], (d) => {
        const c = d.config || {};
        if (c.mode !== 'reschedule' || c.bookedDate) { resolve(null); return; }
        const found = extractBookedDate();
        if (found) saveDetectedBookedDate(found);
        resolve(found);
      });
    });
  }

  // Persist an auto-detected booked date: it becomes the reschedule upper
  // bound (dateTo = day before), and the sidebar form field gets filled too.
  function saveDetectedBookedDate(found) {
    chrome.storage.local.get(['config', 'reschedule'], (d) => {
      const c = d.config || {};
      if (c.bookedDate) return;   // already known — don't overwrite
      c.bookedDate = found;
      c.dateTo = dayBeforeISO(found);
      const rs = d.reschedule || {};
      rs.bookedDate = found;
      chrome.storage.local.set({ config: c, reschedule: rs }, () => {
        log('Detected booked appointment: ' + found + ' — hunting dates before it.');
        chrome.runtime.sendMessage({ type: 'BOOKED_DATE_DETECTED', date: found }, () => void chrome.runtime.lastError);
      });
    });
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

  // Log when a facility's earliest available date changes, so cancellation
  // movement is visible in the log (e.g. "Toronto: Earliest 2027-10-26 -> 2027-09-15").
  // Stays quiet when nothing changed, to avoid log spam.
  async function noteEarliest(facId, facName, earliest) {
    try {
      const store = await chrome.storage.local.get(['lastEarliest']);
      const map = store.lastEarliest || {};
      const prev = map[facId];
      if (earliest !== prev) {
        if (!earliest) log(facName + ': no dates open now (was ' + prev + ')');
        else if (!prev) log(facName + ': earliest ' + earliest);
        else log(facName + ': earliest ' + prev + ' -> ' + earliest + ' (changed)');
        map[facId] = earliest || null;
        await chrome.storage.local.set({ lastEarliest: map });
      }
    } catch (e) { /* ignore */ }
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

  // Scroll element into view, then move synthetic cursor to it
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

  // ==================== SYNTHETIC CURSOR (in-page events) ====================

  var lastX = 0;
  var lastY = 0;
  var cursorInit = false;

  function initCursor() {
    if (cursorInit) return;
    lastX = Math.random() * window.innerWidth * 0.4;
    lastY = Math.random() * window.innerHeight * 0.4;
    cursorInit = true;
  }

  function resetCursor() {
    cursorInit = false;
  }

  async function moveCursorTo(el) {
    if (!el) return;
    initCursor();

    var rect = el.getBoundingClientRect();
    var vx = rect.left + rect.width * (0.25 + Math.random() * 0.5);
    var vy = rect.top + rect.height * (0.25 + Math.random() * 0.5);

    lastX = vx;
    lastY = vy;

    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: vx, clientY: vy, view: window }));
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: vx, clientY: vy, view: window }));
    el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: vx, clientY: vy, view: window }));
  }

  async function clickAtCursor(el) {
    var x = lastX;
    var y = lastY;

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

  // Type text with synthetic events (stays in the target field).
  async function typeHuman(el, text) {
    el.setAttribute('autocomplete', 'off');
    el.focus();
    el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    await delay(100 + Math.random() * 150);

    // Clear field first
    nativeSetter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));

    // Synthetic key events + nativeSetter
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

  const MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];

  // Does this datepicker panel show the given year/month? (handles full or
  // abbreviated month labels)
  function panelMatches(scope, yr, mo) {
    if (yr == null || mo == null) return true;
    const moEl = scope.querySelector('.ui-datepicker-month');
    const yrEl = scope.querySelector('.ui-datepicker-year');
    if (!moEl || !yrEl) return true;
    const txt = moEl.textContent.trim();
    let curMo = MONTHS.indexOf(txt);
    if (curMo < 0) curMo = MONTHS.findIndex(m => m.slice(0, 3) === txt.slice(0, 3));
    return curMo === mo && parseInt(yrEl.textContent.trim()) === yr;
  }

  // All clickable (available) day-numbers in a panel. Available days are <a>
  // links inside cells that are NOT marked unselectable/disabled; blocked days
  // are plain <span>, so they're naturally excluded.
  function availableDaysIn(scope) {
    const links = scope.querySelectorAll(
      'td:not(.ui-datepicker-unselectable):not(.ui-state-disabled) a'
    );
    return Array.from(links)
      .map(a => parseInt(a.textContent.trim(), 10))
      .filter(n => !isNaN(n));
  }

  // Read the available dates straight from the calendar DOM for the target
  // month, and log them — a cross-check against the JSON the API returned.
  function logCalendarDates(yr, mo) {
    const groups = document.querySelectorAll('.ui-datepicker-group');
    const scopes = groups.length
      ? Array.from(groups)
      : [document.querySelector('.ui-datepicker') || document];
    for (const scope of scopes) {
      if (panelMatches(scope, yr, mo)) {
        const days = availableDaysIn(scope);
        log('Calendar open days (' + (mo + 1) + '/' + yr + '): ' +
            (days.length ? days.join(', ') : 'none'));
        return days;
      }
    }
    log('Calendar: target month panel not visible');
    return [];
  }

  // Click a day, scoped to the correct month panel (the datepicker can show two
  // months at once). Only clicks a genuinely available (clickable) day.
  function clickDay(day, yr, mo) {
    const groups = document.querySelectorAll('.ui-datepicker-group');
    const scopes = groups.length
      ? Array.from(groups)
      : [document.querySelector('.ui-datepicker') || document];

    for (const scope of scopes) {
      if (!panelMatches(scope, yr, mo)) continue;
      const links = scope.querySelectorAll(
        'td:not(.ui-datepicker-unselectable):not(.ui-state-disabled) a'
      );
      for (const l of links) {
        if (parseInt(l.textContent.trim(), 10) === day) { l.click(); return true; }
      }
    }
    return false;
  }

})();
