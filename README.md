<p align="center">
  <img src="icons/icon128.png" alt="SardarJi logo" width="120" height="120">
</p>

<h1 align="center">SardarJi Appointment Scheduler</h1>

A Chrome/Chromium extension that monitors US visa appointment slots on
`ais.usvisa-info.com` (Canada / `en-ca`), auto-logs in, alerts you when a slot in
your date range opens, and can optionally auto-book it.

Works on **Windows and macOS**, in any Chromium browser (Chrome, Edge, Brave).

---

## 🔒 Privacy & Trust

**We never steal your login credentials. This is trusted software.**

- Your **email and password are stored only on your own computer** (in the
  browser's local extension storage) — they are **never** sent to us or any
  third‑party server.
- Your credentials are used for **one purpose only**: to log in to the official
  visa website (`ais.usvisa-info.com`), exactly as you would yourself.
- The only network requests the extension makes are to the **visa website** and,
  *if you choose to enable it*, to **your own Telegram bot** for alerts (which
  receives slot notifications — never your password).
- The full source code is **open and public in this repository** — you can read
  exactly what it does.

---

## 1. Install the extension

1. Download the code:
   - Green **Code** button on
     https://github.com/Satnamtoor12/sardarji-visa-scheduler → **Download ZIP**,
     then unzip. *(Or `git clone https://github.com/Satnamtoor12/sardarji-visa-scheduler.git`)*
2. Open `chrome://extensions` (Edge: `edge://extensions`).
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked**.
5. Select the `sardarji-visa-scheduler` folder (the one containing `manifest.json`).
6. **SardarJi Appointment Scheduler** appears in the list — done.

### Keep it loaded permanently (optional)

"Load unpacked" already survives restarts. For a cleaner setup that auto-loads
the extension every time without the developer-mode prompt, launch the browser
with the extension flag:

```
chrome.exe --load-extension="C:\path\to\sardarji-visa-scheduler"
```

Make a desktop shortcut with that flag (a dedicated `--user-data-dir` keeps it in
its own profile). Chromium/Brave/ungoogled-chromium do this the most cleanly.

---

## 2. Set it up & run

1. Click the extension icon to open the **side panel**.
2. Fill in:
   - **Email / Password** — your usvisa-info login (saved locally in the browser).
   - **Facility** — the consulate(s) to watch (one, or several via *Advanced*).
   - **Date range** — earliest and latest acceptable appointment dates.
   - **Check every (sec)** — how often to check, in seconds (a live "= X min"
     hint shows the equivalent). Keep it sensible (see the warning below).
   - **Auto-book** — tick to book automatically when a matching slot is found.
3. *(Optional)* In **Advanced** set **active hours**, **Telegram alerts**
   (bot token + chat ID), and **sound / desktop notification** toggles.
4. Press **START**. Press **STOP** to halt immediately (it also aborts an
   in-progress login/booking).

The extension logs in on its own, then keeps checking. If the session expires it
detects the login screen and logs back in automatically. If your credentials are
wrong or a CAPTCHA appears, it stops and tells you (no pointless retries).

---

## ⚠️ Important warnings

- **Terms of Service / risk** — automating `usvisa-info` may violate its terms,
  and aggressive use can get your **account or IP temporarily blocked**. Use at
  your own risk on your own account.
- **Don't check too fast** — a very small interval = high block risk. Keep
  **"Check every"** at a reasonable value; do not hammer the server.
- **CAPTCHA / new-device verification** can't be solved automatically. If one
  appears, log in manually once, then start monitoring again.

---

## Files

> 📖 For an A–Z description of **every function**, see [FUNCTIONS.md](FUNCTIONS.md).
> 🛠️ For known issues, dead code, and cleanup items found in the last audit, see [TODO.md](TODO.md).

| File / folder    | Purpose                                                                 |
|------------------|--------------------------------------------------------------------------|
| `manifest.json`  | Extension manifest (MV3) — includes the fixed `key`/ID                   |
| `background.js`  | Service worker — login flow, monitoring loop, alerts                     |
| `content.js`     | Runs on `ais.usvisa-info.com` — login, slot check, booking                |
| `sidebar.*`      | Side panel UI — the screen you actually see (opens on icon click)        |
| `popup.*`        | Toolbar popup UI — **currently unreachable** (no popup is wired up in the manifest; see [TODO.md](TODO.md)) |
| `options.*`      | Settings page (`chrome://extensions` → Details → Extension options)      |
| `offscreen.html` | Plays the alert sound                                                    |
| `build.js`       | Packages/obfuscates the extension into `../sardarji-dist` (not needed for normal use — see [TODO.md](TODO.md) for a known gap) |

---

## Troubleshooting

- **Nothing happens after START** — make sure email/password are saved and you're
  not outside the configured *active hours* (disable Schedule for 24/7).
- **Stops with "Invalid email or password"** — fix the saved credentials, then
  start again. (Test with a fake email if you just want to see the flow.)
- **Stops with "CAPTCHA"** — log in manually once in the browser, then start.
- **See logs** — the side panel's **Activity Log**, or `chrome://extensions` →
  *Inspect views: service worker*.
