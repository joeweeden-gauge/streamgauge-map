// ===== STREAM GAUGE MAP v1.0.2 =====
// File: src/App.jsx
// Changes from v1.0.1:
//   - EXCLUDED_SITES: blacklist of gauge IDs to never show on startup
//   - Default exclusions: Hominy Creek, Flat Rock, Coal Creek
//   - "Use My Location" now filters out gauges downstream of the user
// If you can see this comment in GitHub after pasting, the paste worked.

import { useEffect, useState, useCallback, useMemo } from 'react'
import { MapContainer, TileLayer, Marker, useMap } from 'react-leaflet'
import L from 'leaflet'
import {
  getSitesInHUC,
  getCurrentReadings,
  selectUpstreamGauges,
  selectUpstreamFromLocation,
  classifyFlow,
  getMedianFlow,
  FLOW_COLORS,
  FLOW_LABELS,
} from './usgs'
import GaugeDetail from './GaugeDetail'

// Default starting gauge: USGS 07176500 Bird Creek at Avant, OK
const DEFAULT_START = {
  siteNo: '07176500',
  name: 'Bird Creek at Avant, OK',
  lat: 36.4850,
  lon: -96.0603,
  huc: '11070107',
  drainageArea: 369,
  altitude: 646.39,
}

// Gauges to never show on the map, even if the algorithm picks them.
// Add or remove site numbers here to customize.
const EXCLUDED_SITES = new Set([
  '07176950', // Hominy Creek
  '07177650', // Flat Rock
  '07177800', // Coal Creek
])

const NUM_GAUGES = 8

function buildMarkerIcon(reading, classification) {
  const color = FLOW_COLORS[classification]
  const cfsText =
    reading?.cfs == null
      ? '—'
      : reading.cfs >= 1000
      ? `${(reading.cfs / 1000).toFixed(1)}k`
      : reading.cfs >= 10
      ? Math.round(reading.cfs).toString()
      : reading.cfs.toFixed(1)
  const arrow =
    reading?.trend === 'rising' ? '▲' : reading?.trend === 'falling' ? '▼' : '●'
  const arrowColor =
    reading?.trend === 'rising'
      ? '#fff'
      : reading?.trend === 'falling'
      ? '#fff'
      : '#fff'

  const html = `
    <div class="pin" style="background:${color}">
      <div class="cfs">${cfsText}</div>
      <div class="arrow" style="color:${arrowColor}">${arrow}</div>
    </div>
    <div class="label">cfs</div>
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

/** Imperatively fits the map to the gauge bounds whenever the list changes. */
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

export default function App() {
  const [gauges, setGauges] = useState([])
  const [readings, setReadings] = useState({})
  const [medians, setMedians] = useState({})
  const [selected, setSelected] = useState(null)
  const [status, setStatus] = useState('Loading default gauges...')
  const [error, setError] = useState(null)
  const [userLoc, setUserLoc] = useState(null)
  const [loading, setLoading] = useState(true)

  const loadGaugesFor = useCallback(async (referenceGauge, label) => {
    setLoading(true)
    setError(null)
    setStatus(label || 'Finding upstream gauges...')
    try {
      // Ask for more than we need so we have replacements after filtering
      const upstream = await selectUpstreamGauges(referenceGauge, NUM_GAUGES + EXCLUDED_SITES.size)
      // Remove excluded sites
      const filtered = upstream.filter((g) => !EXCLUDED_SITES.has(g.siteNo))
      const all = [referenceGauge, ...filtered].slice(0, NUM_GAUGES)
      setGauges(all)
      setStatus(`Loading current flows for ${all.length} gauges...`)
      const r = await getCurrentReadings(all.map((g) => g.siteNo))
      setReadings(r)
      setStatus(null)
      setLoading(false)
      const meds = {}
      await Promise.all(
        all.map(async (g) => {
          const m = await getMedianFlow(g.siteNo)
          if (m != null) meds[g.siteNo] = m
        })
      )
      setMedians(meds)
    } catch (e) {
      console.error(e)
      setError(e.message || 'Failed to load gauges')
      setLoading(false)
    }
  }, [])

  // Initial load: default starting gauge
  useEffect(() => {
    loadGaugesFor(DEFAULT_START, 'Loading Bird Creek and upstream gauges...')
  }, [loadGaugesFor])

  const handleUseMyLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setError('Geolocation is not supported by your browser.')
      return
    }
    setStatus('Getting your location...')
    setLoading(true)
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords
        setUserLoc({ lat: latitude, lon: longitude })
        try {
          setStatus('Finding gauges upstream of you...')
          // Ask for extras so filtering doesn't leave us short
          const list = await selectUpstreamFromLocation(
            latitude,
            longitude,
            NUM_GAUGES + EXCLUDED_SITES.size
          )
          // Also apply the exclusion list here
          const filtered = list.filter((g) => !EXCLUDED_SITES.has(g.siteNo)).slice(0, NUM_GAUGES)
          setGauges(filtered)
          setStatus(`Loading current flows for ${filtered.length} gauges...`)
          const r = await getCurrentReadings(filtered.map((g) => g.siteNo))
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
      const classification = classifyFlow(reading?.cfs, median)
      return { gauge: g, reading, median, classification }
    })
  }, [gauges, readings, medians])

  return (
    <div className="app">
      <div className="header">
        <div>
          <h1>🌊 Stream Gauge Map <span style={{fontSize:10,opacity:0.6}}>v1.0.2</span></h1>
          <div className="sub">
            {gauges.length > 0
              ? `${gauges.length} gauges · ${gauges[0]?.name?.split(',')[0] || ''}`
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
                click: () => setSelected({ gauge, reading, median: medians[gauge.siteNo], classification }),
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
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Flow vs. typical</div>
          {['very-low', 'low', 'normal', 'high', 'very-high'].map((k) => (
            <div className="row" key={k}>
              <div className="swatch" style={{ background: FLOW_COLORS[k] }} />
              <span>{FLOW_LABELS[k]}</span>
            </div>
          ))}
          <div style={{ marginTop: 6, fontSize: 10, color: '#64748b' }}>
            ▲ rising · ▼ falling · ● steady
          </div>
        </div>

        {selected && (
          <GaugeDetail
            gauge={selected.gauge}
            reading={selected.reading}
            median={selected.median}
            classification={selected.classification}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  )
}
