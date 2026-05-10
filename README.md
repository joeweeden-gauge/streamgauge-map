# Stream Gauge Map

Interactive map of USGS stream gauges showing live discharge (CFS), rising/falling trend, and 7-day history. Defaults to **USGS 07176500 Bird Creek at Avant, OK** plus 7 upstream gauges. A "Use My Location" button re-centers the map on 8 gauges upstream of your current GPS position.

Data: [USGS Water Services API](https://waterservices.usgs.gov/) — public, no API key needed.

---

## Features

- **8 gauges** plotted at once: starting gauge + 7 upstream selected by HUC watershed, drainage area, and elevation
- **Color-coded markers** by flow vs. typical: red (very low) → orange → green (normal) → blue → purple (very high / flood). Coloring uses the gauge's own historical median for the day, so it's meaningful for both creeks and big rivers
- **Trend arrows** ▲ rising / ▼ falling / ● steady (3-hr comparison)
- **Click a marker** → 7-day flow chart + drainage area + median reference line + link to full USGS page
- **"Use My Location"** button: gets your GPS, finds the nearest reporting gauge, and pulls 8 upstream from there
- **Mobile-first**: looks great on iPhone Safari, side panel on desktop, bottom sheet on mobile
- **Auto-deploys** to GitHub Pages on every push

---

## Quick start (Chromebook → GitHub → iPhone)

### 1. Get the code on GitHub

The fastest path on a Chromebook is to use **github.dev** (the web-based VS Code editor — no Linux setup needed):

1. Create an empty public repo on github.com — call it `streamgauge-map`
2. Drop these files in (use the GitHub web UI's "Add file → Upload files", or push from your Chromebook's terminal if you have Linux/Crostini enabled)
3. Press `.` (period) on your repo's GitHub page to open it in github.dev for in-browser editing

### 2. Configure the base path

Open `vite.config.js` and make sure `base` matches your repo name:

```js
base: '/streamgauge-map/',  // must match repo name exactly, with leading + trailing slash
```

If you named your repo something else, change this line. Commit it.

### 3. Enable GitHub Pages

1. In your repo on github.com → **Settings → Pages**
2. Under "Build and deployment", set **Source** to **GitHub Actions**
3. Push any change (or just edit the README) — the workflow in `.github/workflows/deploy.yml` will build and deploy

After ~1 minute, your site is live at:

```
https://<your-username>.github.io/streamgauge-map/
```

Open that URL on your iPhone and add to Home Screen for an app-like icon.

### 4. Iterating on Chromebook

You have three good options:

**Option A — github.dev (zero setup, easiest)**
- Press `.` on any GitHub repo page to launch a full VS Code in your browser
- Edit, commit, push — every push triggers a fresh deploy. Refresh your phone to see changes.
- Limitation: no terminal, no `npm run dev`, no live preview. You see results only after the GitHub Action builds.

**Option B — GitHub Codespaces (best dev experience, free tier)**
- On your repo: **Code → Codespaces → Create codespace on main**
- Full Linux VM in the browser. Run:
  ```
  npm install
  npm run dev
  ```
- Codespaces forwards the dev port and gives you a public preview URL you can open on your phone for live testing.

**Option C — Local with Linux (Crostini)**
- Enable Linux in Chromebook Settings → Advanced → Developers → Linux dev environment
- Install Node:
  ```
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs git
  ```
- Clone and run locally:
  ```
  git clone https://github.com/<you>/streamgauge-map.git
  cd streamgauge-map
  npm install
  npm run dev
  ```
- Visit `http://localhost:5173/streamgauge-map/`

---

## How upstream selection works

There's no single API for "give me the gauges upstream of point X." The app uses a heuristic that works well in practice:

1. The **starting gauge's HUC8** (8-digit Hydrologic Unit Code, e.g. `11070107` for Bird Creek) defines the watershed. Look up all active stream gauges in that HUC8.
2. Score each candidate:
   - **+50 points** if its drainage area is *smaller* than the starting gauge (smaller drainage = further upstream in the network)
   - **+30 points** if its elevation is *higher* than the starting gauge
   - **+20 points** if it's in the same HUC8
   - **distance penalty** (½ point per km)
3. If HUC8 doesn't yield enough candidates, expand to HUC6 then HUC4.
4. Take the top 7 (plus the starting gauge = 8 total).

For "Use My Location": find the nearest reporting stream gauge to your GPS, then run the same upstream selection from there.

This isn't perfect — true upstream determination needs the NHD flowline graph, which is heavyweight. But for typical use (watching upstream gauges before water reaches you), this approach gives sensible results in most basins.

---

## File map

```
streamgauge-map/
├── .github/workflows/deploy.yml   # auto-deploy on push
├── index.html                     # entry point
├── package.json
├── vite.config.js                 # ← set `base` to match your repo name
├── src/
│   ├── main.jsx                   # React mount
│   ├── App.jsx                    # map + markers + buttons + state
│   ├── GaugeDetail.jsx            # popup with 7-day chart
│   ├── usgs.js                    # all USGS API calls + upstream algorithm
│   └── index.css
└── README.md
```

The two files you'll touch most:
- **`src/App.jsx`** — header, buttons, marker icons, default starting gauge
- **`src/usgs.js`** — API endpoints and the `selectUpstreamGauges` scoring function

To change the default gauge, edit `DEFAULT_START` at the top of `App.jsx`.

---

## Troubleshooting

- **Blank page at `username.github.io/streamgauge-map/`** → `base` in `vite.config.js` doesn't match the repo name. They must match exactly, including the trailing slash.
- **"Use My Location" doesn't work** → iOS Safari requires HTTPS for geolocation. GitHub Pages serves HTTPS, so this works on the deployed URL but *not* on `http://localhost`. To test locally on your phone, use a Codespace's HTTPS preview URL.
- **Some gauges show "—" with a gray pin** → the gauge has no recent IV (instantaneous values) reading. USGS gauges occasionally drop offline.
- **"No stream gauges found within ~110 km of your location"** → expand the bounding box in `selectUpstreamFromLocation` in `usgs.js` (currently ±1° lat/lon).

---

## License

MIT. Stream data is public domain (USGS).
