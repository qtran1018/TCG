# PriceCharting API Investigation

## Goal

Find a way to access PriceCharting pricing data via a clean JSON API instead of HTML scraping, ideally without paying $49/month for their Pro API tier.

## PriceCharting API Tiers

- **$5/month**: Basic API — `?t=TOKEN&id=PRODUCT_ID`, returns one `graded-price` bucket, no grade breakdown, no sales history, no chart data
- **$49/month**: Full price data API — likely same or similar endpoint with more fields
- **Our scraper**: Returns more data than either paid tier (PSA 7/8/9/10 breakdown, recent sales, chart history), cached 24h in Redis

## Approach 1 — Static Key in APK (jadx)

**Tool:** jadx-gui (Java decompiler for Android APKs)

**Finding:** Located a Bearer token in `strings.xml`:

```
793bab7386654a5b2e99885d8101b889c6df0747f0be2d54c9ff7c0046df166e80b711c19a385dae4f1b82585e3b15d49f630f3d
```

96-char hex string (not a JWT). Also found a Google API key (unrelated — Firebase/Analytics).

**Test:**

```
curl "https://www.pricecharting.com/api/product?t=793bab...&id=6910"
curl -H "Authorization: Bearer 793bab..." "https://www.pricecharting.com/api/product?id=6910"
```

**Result:** `unknown token` — server recognizes the format but the token is not registered. Likely a dev/test key that was revoked or never activated in production.

---

## Approach 2 — Traffic Interception (mitmproxy)

**Goal:** Intercept live app traffic to find real API endpoints and auth tokens.

**Tool:** mitmproxy / mitmweb

### Setup Steps Completed

1. Installed mitmproxy via winget
2. mitmweb runs on port 8080, web UI at `http://localhost:8081`
3. Windows Firewall rule added for port 8080 (`-Profile Any` required for hotspot/Public networks)

### Android Emulator Attempt

- Created Pixel 4 XL emulator (API 29, no Google Play) in Android Studio
- Set proxy via `adb -e shell settings put global http_proxy 10.0.2.2:8080`
- Installed mitmproxy cert via `http://mitm.it` → CA Certificate → VPN and apps
- **Problem:** PriceCharting app requires Google Play Services → redirects to Play Store on launch
- Browsed website via emulator Chrome → only HTML page requests visible, no JSON API calls (site is server-rendered)

### apk-mitm Patch Attempt

- Patched XAPK with `apk-mitm` (run as Administrator) to trust user certs
- Output: `PriceCharting_1.8.11_APKPure-patched.xapk`
- Extracted and installed all splits on emulator:
  ```
  adb -e install-multiple base.apk config.arm64_v8a.apk config.en.apk config.xxhdpi.apk
  ```
- **Problem:** Patched APK still requires Google Play Services → same Play Store redirect

### Real Phone Attempt

- Used `adb reverse tcp:8080 tcp:8080` for USB tunnel (returned 8080 — confirmed active)
- Pi-hole paused to eliminate DNS interference
- Switched to PC hotspot to bypass router AP isolation
- Windows Firewall was blocking → disabled firewall → connection worked
- Added permanent firewall rule: `New-NetFirewallRule -Profile Any -LocalPort 8080`
- Installed mitmproxy cert on phone: CA Certificate → VPN and apps
- Opened official Play Store PriceCharting app with proxy active
- **Result:** `java.security.cert.CertPathValidatorException: trust anchor for certification path not found`
  - App uses **certificate pinning** — rejects the mitmproxy cert even though it's installed system-wide
- Tried installing patched APK on phone via `adb -d install-multiple`
- **Result:** App redirects to Play Store (same Google Play Services check as emulator)

### Round 2 — Google APIs Emulator + System Cert (2026-05-23)

**Goal:** Use a rootable Google APIs emulator (no Play Store, no Play Integrity) + install mitmproxy cert as system cert to bypass both defenses simultaneously.

**Emulator proxy setup:**
- `adb -e shell settings put global http_proxy 10.0.2.2:8080` → no internet (emulator can't reach host via 10.0.2.2)
- `adb -e reverse tcp:8080 tcp:8080` + proxy `127.0.0.1:8080` → no flows in mitmweb (Chrome ignores system proxy)
- **Fix:** Launch emulator with `-http-proxy 192.168.1.2:8080` (host LAN IP, not 127.0.0.1) — routes all VM traffic through mitmproxy at network layer

**System cert install (Android 14+):**
- `adb root` + `adb remount` requires `-writable-system` emulator flag
- `/system/etc/security/cacerts/` is no longer used on API 35 — Android 14+ reads from `/apex/com.android.conscrypt/cacerts/`
- Mounted tmpfs over apex cacerts dir and copied cert there — file present but not reflected in Settings UI
- Real test: install app and check mitmweb for flows

**Google APIs emulator (Pixel 6 Pro, API 35):**
- `adb root` works ✓
- App launches but shows "check that Google Play is enabled" — Google APIs image has GMS APIs but not the full Play environment the app requires
- Could not get the app running on any emulator configuration

**Static analysis fallback (jadx):**
- Searched decompiled APK for `api/product`, `pricecharting.com`, `?t=`, `retrofit`, `@GET`, `vgpc` — no useful results
- Network layer is obfuscated; URLs are built dynamically at runtime, not present as string literals

---

## Conclusion ✓

**API endpoints are not statically or dynamically discoverable** without a rooted physical device running the official app.

All approaches exhausted:
1. Static key in APK → token found but server-rejected
2. Traffic interception → blocked by cert pinning + Play Integrity on every configuration tried
3. Google APIs emulator → app requires full Play environment, won't launch
4. jadx static analysis → network layer obfuscated, no endpoints found

The existing HTML scraper already returns more data than PriceCharting's paid API tiers:

- PSA 7/8/9/10 grade breakdown
- Recent sales list (100 fetched, filtered by grade, top 10 displayed)
- Price history for chart
- Cached 24h in Redis at 0.5s rate limit

Investigation closed.

## What Was Learned

- mitmproxy setup on Windows with Android (emulator + real device)
- Emulator proxy: must use host LAN IP (not 127.0.0.1 or 10.0.2.2) with `-http-proxy` flag
- APK patching with apk-mitm (network security config modification)
- adb commands: install-multiple, reverse, root, remount, -writable-system
- Android certificate trust chain: user certs → system certs → APEX certs (Android 14+)
- `/apex/com.android.conscrypt/cacerts/` is the system trust store on Android 14+; use tmpfs mount to modify
- Certificate pinning and why it blocks mitmproxy
- Google Play Services vs Google APIs vs Google Play emulator images
- Play Integrity API blocks re-signed APKs even with Play Protect disabled
- Router AP isolation vs PC hotspot workaround
- Windows Firewall profile scoping (Private vs Public/Any)
- jadx obfuscation: Kotlin-compiled apps often have no readable string literals for API URLs
