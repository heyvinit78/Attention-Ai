# AttentionAI (web app / PWA)

Same attention estimation as the Python version, but it runs **fully in the phone's browser** (MediaPipe Face
Landmarker in WebAssembly). No server, no video upload. Results are estimates, not a medical or validated measurement.

Files: `index.html`, `style.css`, `app.js` (UI + camera), `engine.js` (attention rules, session stats, CSV),
`sw.js` (offline cache), `manifest.webmanifest`, `icons/`.

## 1. Quick test on a laptop
```
cd AttentionAI-PWA
python -m http.server 8000
```
Open http://localhost:8000 in Chrome (camera works on localhost) and press Start session.
The first run downloads the AI files (about 15 MB) from jsDelivr and Google, so internet is needed once.

## 2. Host it free on GitHub Pages (needed for phone: camera requires HTTPS)
1. Create a GitHub account and a new **public** repository, e.g. `attentionai`.
2. Upload **the contents** of this folder (index.html, app.js, ... and the `icons` folder) to the repository root.
3. Repository Settings > Pages > Source: "Deploy from a branch", branch `main`, folder `/ (root)`, Save.
4. After about a minute your site is at `https://YOUR-NAME.github.io/attentionai/`.
5. Open that link on your phone in Chrome, allow the camera, test it once while online.

## 3. Get the APK
Option 1, no APK needed: in Chrome on Android open the site, menu (three dots) > **Install app** / **Add to Home screen**.

Option 2, real APK with PWABuilder:
1. Open https://www.pwabuilder.com and paste your GitHub Pages URL, then Start.
2. When the report shows the manifest and service worker as found, choose **Package for stores > Android**.
3. Set a package ID such as `io.github.yourname.attentionai`, keep the other defaults, Generate, and download the zip.
4. The zip holds an `.apk` (for installing directly) and an `.aab` (for Play Store). Copy the `.apk` to your phone,
   allow "Install unknown apps" for your file manager, and install. Keep the signing key file from the zip safe.

PWABuilder's screens change over time, so follow its on-screen labels if they differ from the above.

## How status is decided (edit in `engine.js` > CONFIG)
| Status | Rule |
|---|---|
| Drowsy | eyes closed (EAR < 0.21) for 1.5 s in a row, or closed for 40% of the last 30 s |
| Distracted | head turned/tilted more than 25 degrees from your "forward", or iris looking sideways, for 2 s |
| Focused | face visible and neither rule applies |
| No Face | no face for 1 s; this time is not counted as focused |

- New status must hold 0.4 s before it shows. The attention % is a smoothed score.
- The first ~1.5 s of a session (look at the screen) calibrate your "forward" head pose.
- Focus % = focused time / (focused + distracted + drowsy). No-face time is excluded.
- Alerts: beep and vibration (if the phone supports it), at most once every 10 s. Mute button included.
- Keep the screen on and the app in front: browsers pause camera processing when the app is in the background.
  The app asks the phone to keep the screen awake during a session.

## Troubleshooting
| Problem | Fix |
|---|---|
| "Could not load the AI model" | Connect to internet once, reload, press Start again |
| Camera permission denied | Android Settings > Apps > (Chrome or AttentionAI) > Permissions > Camera > Allow |
| Camera not available | The page must be HTTPS (GitHub Pages) or localhost |
| Always Distracted | Look straight at the screen during calibration; hold the phone steady, face lit from the front |
| Eyes flagged closed too often | Lower `earClosed` in `engine.js` (try 0.18) |
| Updated files but app looks old | Change `CACHE` name in `sw.js` (e.g. v2), redeploy, reopen the app twice |
