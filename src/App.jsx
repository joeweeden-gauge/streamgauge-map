// ===== STREAM GAUGE MAP v1.0.6 =====
// File: src/App.jsx
// Changes from v1.0.5:
//   - STARTUP VIEW: every gauge now shows feet (height), regardless of whether
//     it reports discharge. Colors are based on current height vs the gauge's
//     own 7-day average (red = unusually low, green = normal, purple = high).
//   - "Use My Location" stays as CFS-only, unchanged.

import { useEffect, useState, useCallback, useMemo } from 'react'
import { MapContainer, TileLayer, Marker, useMap } from 'react-leaflet'
import L from 'leaflet'
import {
  getCurrentReadings,
  getDailyValueFallback,
  getHeightReading,
  selectUpstreamGauges,
  selectUpstreamGaugesIncludingHeightOnly,
  selectUpstreamFromLocation,
  classifyFlow,
  classifyHeight,
  getMedianFlow,
  FLOW_COLORS,
  FLOW_LABELS,
} from './usgs'
import GaugeDetail from './GaugeDetail'

const DEFAULT_START = {
  siteNo: '07176500',
  name: 'Bird Creek at Avant, OK',
  lat: 36.4850,
  lon: -96.0603,
  huc: '11070107',
  drainageArea: 369,
  altitude: 646.39,
}

const EXCLUDED_SITES = new Set([
  '07176950',
  '07177650',
  '07177800',
])

const NUM_GAUGES = 8

function buildMarkerIcon(reading, classification) {
  const isHeight = reading?.source === 'height'
  const color = FLOW_COLORS[classification] || FLOW_COLORS['no-data']

  let mainText
  if (isHeight && reading?.feet != null) {
    mainText = `${reading.feet.toFixed(1)}ft`
  } else if (reading?.cfs == null) {
    mainText = '—'
  } else if (reading.cfs >= 1000) {
    mainText = `${(reading.cfs / 1000).toFixed(1)}k`
  } else if (reading.cfs >= 10) {
    mainText = Math.round(reading.cfs).toString()
  } else {
    mainText = reading.cfs.toFixed(1)
  }

  let arrow
  if (reading?.source === 'dv') arrow = '◷'
  else if (reading?.trend === 'rising') arrow = '▲'
  else if (reading?.trend === 'falling') arrow = '▼'
  else arrow = '●'

  const unitLabel = isHeight ? 'ft' : 'cfs'

  const html = `
    <div class="pin" style="background:${color}">
      <div class="cfs">${mainText}</div>
      <div class="arrow" style="color:#fff">${arrow}</div>
    </div>
    <div class="label">${unitLabel}</div>
  `
  return L.divIcon({
    className: 'gauge-marker',
    html,
    iconSize: [56, 56],
    iconAnchor: [28, 28],
  })
}

function userLocationIcon() {
  return L.divIcon({
    className: '',
    html: '<div class="user-marker"></div>',
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  })
}

function FitToBounds({ gauges, userLoc }) {
  const map = useMap()
  useEffect(() => {
    if (gauges.length === 0) return
    const points = gauges.map((g) => [g.lat, g.lon])
    if (userLoc) points.push([userLoc.lat, userLoc.lon])
    const bounds = L.latLngBounds(points)
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 11 })
  }, [gauges, userLoc, map])
  return null
}

// Mode flag tells classifyMarker which path to take
const MODE_HEIGHT = 'height'
const MODE_FLOW = 'flow'

export default function App() {
  const [gauges, setGauges] = useState([])
  const [readings, setReadings] = useState({})
  const [medians, setMedians] = useState({})
  const [mode, setMode] = useState(MODE_HEIGHT) // startup view = height
  const [selected, setSelected] = useState(null)
  const [status, setStatus] = useState('Loading default gauges...')
  const [error, setError] = useState(null)
  const [userLoc, setUserLoc] = useState(null)
  const [loading, setLoading] = useState(true)

  // === STARTUP VIEW (height mode) ===
  const loadGaugesFor = useCallback(async (referenceGauge, label) => {
    setLoading(true)
    setError(null)
    setMode(MODE_HEIGHT)
    setStatus(label || 'Finding upstream gauges...')
    try {
      const upstream = await selectUpstreamGaugesIncludingHeightOnly(
        referenceGauge,
        NUM_GAUGES + EXCLUDED_SITES.size
      )
      const filtered = upstream.filter((g) => !EXCLUDED_SITES.has(g.siteNo))
      const all = [referenceGauge, ...filtered].slice(0, NUM_GAUGES)
      setGauges(all)
      setStatus(`Loading gauge heights for ${all.length} gauges...`)
      // Pull height reading for every gauge
      const heightResults = await Promise.all(
        all.map((g) => getHeightReading(g.siteNo))
      )
      const r = {}
      all.forEach((g, i) => {
        if (heightResults[i]) r[g.siteNo] = heightResults[i]
      })
      setReadings(r)
      // Medians don't apply in height mode
      setMedians({})
      setStatus(null)
      setLoading(false)
    } catch (e) {
      console.error(e)
      setError(e.message || 'Failed to load gauges')
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadGaugesFor(DEFAULT_START, 'Loading Bird Creek and upstream gauges...')
  }, [loadGaugesFor])

  // === USE MY LOCATION (flow mode) — unchanged behavior ===
  const handleUseMyLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setError('Geolocation is not supported by your browser.')
      return
    }
    setStatus('Getting your location...')
    setLoading(true)
    setMode(MODE_FLOW)
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords
        setUserLoc({ lat: latitude, lon: longitude })
        try {
          setStatus('Finding gauges upstream of you...')
          const list = await selectUpstreamFromLocation(
            latitude,
            longitude,
            NUM_GAUGES + EXCLUDED_SITES.size
          )
          const filtered = list
            .filter((g) => !EXCLUDED_SITES.has(g.siteNo))
            .slice(0, NUM_GAUGES)
          setGauges(filtered)
          setStatus(`Loading current flows for ${filtered.length} gauges...`)
          const siteNos = filtered.map((g) => g.siteNo)
          let r = await getCurrentReadings(siteNos)
          // DV fallback only — no height fallback in this mode
          const missing = siteNos.filter((s) => !r[s])
          if (missing.length) {
            const dv = await Promise.all(missing.map((s) => getDailyValueFallback(s)))
            missing.forEach((s, i) => { if (dv[i]) r[s] = dv[i] })
          }
          setReadings(r)
          setStatus(null)
          setLoading(false)
          const meds = {}
          await Promise.all(
            filtered.map(async (g) => {
              const m = await getMedianFlow(g.siteNo)
              if (m != null) meds[g.siteNo] = m
            })
          )
          setMedians(meds)
        } catch (e) {
          setError(e.message || 'Failed to find upstream gauges from your location.')
          setLoading(false)
        }
      },
      (err) => {
        setError(`Location error: ${err.message}`)
        setLoading(false)
      },
      { enableHighAccuracy: true, timeout: 15000 }
    )
  }, [])

  const handleResetDefault = useCallback(() => {
    setUserLoc(null)
    loadGaugesFor(DEFAULT_START, 'Loading Bird Creek and upstream gauges...')
  }, [loadGaugesFor])

  const markers = useMemo(() => {
    return gauges.map((g) => {
      const reading = readings[g.siteNo]
      const median = medians[g.siteNo]
      let classification
      if (mode === MODE_HEIGHT) {
        classification = classifyHeight(reading?.feet, reading?.sevenDayAvg)
      } else {
        classification = classifyFlow(reading?.cfs, median)
      }
      return { gauge: g, reading, median, classification }
    })
  }, [gauges, readings, medians, mode])

  const legendTitle = mode === MODE_HEIGHT
    ? 'Height vs. 7-day avg'
    : 'Flow vs. typical'

  return (
    <div className="app">
      <div className="header">
        <div>
          <h1>🌊 Stream Gauge Map <span style={{fontSize:10,opacity:0.6}}>v1.0.6</span></h1>
          <div className="sub">
            {gauges.length > 0
              ? `${gauges.length} gauges · ${mode === MODE_HEIGHT ? 'height (ft)' : 'flow (cfs)'} · ${gauges[0]?.name?.split(',')[0] || ''}`
              : 'Loading...'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn secondary" onClick={handleResetDefault} disabled={loading}>
            Reset
          </button>
          <button className="btn" onClick={handleUseMyLocation} disabled={loading}>
            📍 Use My Location
          </button>
        </div>
      </div>

      <div className="map-wrap">
        <MapContainer
          center={[DEFAULT_START.lat, DEFAULT_START.lon]}
          zoom={9}
          scrollWheelZoom
          style={{ height: '100%', width: '100%' }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <FitToBounds gauges={gauges} userLoc={userLoc} />
          {markers.map(({ gauge, reading, classification }) => (
            <Marker
              key={gauge.siteNo}
              position={[gauge.lat, gauge.lon]}
              icon={buildMarkerIcon(reading, classification)}
              eventHandlers={{
                click: () => setSelected({ gauge, reading, median: medians[gauge.siteNo], classification, mode }),
              }}
            />
          ))}
          {userLoc && (
            <Marker
              position={[userLoc.lat, userLoc.lon]}
              icon={userLocationIcon()}
              interactive={false}
            />
          )}
        </MapContainer>

        {status && <div className="status">{status}</div>}
        {error && (
          <div className="status error" onClick={() => setError(null)}>
            ⚠️ {error} (tap to dismiss)
          </div>
        )}

        <div className="legend">
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{legendTitle}</div>
          {['very-low', 'low', 'normal', 'high', 'very-high'].map((k) => (
            <div className="row" key={k}>
              <div className="swatch" style={{ background: FLOW_COLORS[k] }} />
              <span>{FLOW_LABELS[k]}</span>
            </div>
          ))}
          <div style={{ marginTop: 6, fontSize: 10, color: '#64748b' }}>
            ▲ rising · ▼ falling · ● steady{mode === MODE_FLOW ? ' · ◷ daily' : ''}
          </div>
        </div>

        {selected && (
          <GaugeDetail
            gauge={selected.gauge}
            reading={selected.reading}
            median={selected.median}
            classification={selected.classification}
            mode={selected.mode}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  )
}
