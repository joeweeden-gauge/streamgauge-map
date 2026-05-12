// ===== STREAM GAUGE MAP v1.0.6 =====
// File: src/GaugeDetail.jsx
// Changes from v1.0.5:
//   - Accepts a `mode` prop ('height' or 'flow') from parent
//   - In height mode: shows feet, 7-day height chart, height-vs-7-day-avg classification
//   - In flow mode: original CFS behavior with median comparison

import { useEffect, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'
import { get7DayHistory, get7DayHistoryHeight, FLOW_COLORS, FLOW_LABELS } from './usgs'

export default function GaugeDetail({ gauge, reading, median, classification, mode, onClose }) {
  const [history, setHistory] = useState(null)
  const [historyError, setHistoryError] = useState(null)

  const isHeight = mode === 'height' || reading?.source === 'height'
  const unit = isHeight ? 'ft' : 'cfs'
  const value = isHeight ? reading?.feet : reading?.cfs
  const dataKey = isHeight ? 'feet' : 'cfs'
  const markerColor = FLOW_COLORS[classification] || FLOW_COLORS['no-data']
  const classLabel = FLOW_LABELS[classification] || 'No data'

  useEffect(() => {
    let cancelled = false
    setHistory(null)
    setHistoryError(null)
    const fetcher = isHeight ? get7DayHistoryHeight : get7DayHistory
    fetcher(gauge.siteNo)
      .then((data) => {
        if (cancelled) return
        const step = Math.max(1, Math.floor(data.length / 150))
        const sampled = data.filter((_, i) => i % step === 0 || i === data.length - 1)
        setHistory(sampled)
      })
      .catch((e) => {
        if (!cancelled) setHistoryError(e.message || 'History fetch failed')
      })
    return () => { cancelled = true }
  }, [gauge.siteNo, isHeight])

  const trendIcon =
    reading?.source === 'dv' ? '◷' :
    reading?.trend === 'rising' ? '▲' :
    reading?.trend === 'falling' ? '▼' : '●'
  const trendClass =
    reading?.trend === 'rising' ? 'trend-up' :
    reading?.trend === 'falling' ? 'trend-down' : 'trend-flat'
  const trendLabel =
    reading?.source === 'dv' ? 'Daily value' :
    reading?.trend === 'rising' ? 'Rising' :
    reading?.trend === 'falling' ? 'Falling' : 'Steady'

  const lastUpdated = reading?.time
    ? new Date(reading.time).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      })
    : '—'

  return (
    <div className="detail">
      <div className="detail-header">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2>{gauge.name}</h2>
          <div className="id">USGS {gauge.siteNo}</div>
        </div>
        <button className="detail-close" onClick={onClose} aria-label="Close">×</button>
      </div>

      <div className="detail-body">
        <div className="metric-grid">
          <div className="metric" style={{ borderColor: markerColor }}>
            <div className="label">{isHeight ? 'Gauge height' : 'Discharge'}</div>
            <div className="value">
              {value != null ? (value >= 100 ? Math.round(value).toLocaleString() : value.toFixed(1)) : '—'}{' '}
              <span style={{ fontSize: 12, fontWeight: 500, color: '#64748b' }}>{unit}</span>
            </div>
            <div className="sub" style={{ color: markerColor, fontWeight: 600 }}>
              {classLabel}
            </div>
          </div>

          <div className="metric">
            <div className="label">Trend (3 hr)</div>
            <div className={`value ${trendClass}`}>
              {trendIcon} {trendLabel}
            </div>
            {reading?.delta != null && (
              <div className="sub">
                {reading.delta > 0 ? '+' : ''}{reading.delta.toFixed(1)} {unit}
              </div>
            )}
          </div>

          {isHeight && reading?.sevenDayAvg != null && (
            <div className="metric">
              <div className="label">7-day avg height</div>
              <div className="value">
                {reading.sevenDayAvg.toFixed(1)}
                <span style={{ fontSize: 12, fontWeight: 500, color: '#64748b' }}> ft</span>
              </div>
              <div className="sub">For classification</div>
            </div>
          )}

          {!isHeight && median != null && (
            <div className="metric">
              <div className="label">Today's median</div>
              <div className="value">
                {median >= 100 ? Math.round(median).toLocaleString() : median.toFixed(1)}
                <span style={{ fontSize: 12, fontWeight: 500, color: '#64748b' }}> cfs</span>
              </div>
              <div className="sub">Long-term average</div>
            </div>
          )}

          {gauge.drainageArea != null && (
            <div className="metric">
              <div className="label">Drainage area</div>
              <div className="value">
                {gauge.drainageArea.toLocaleString()}
                <span style={{ fontSize: 12, fontWeight: 500, color: '#64748b' }}> mi²</span>
              </div>
            </div>
          )}
        </div>

        <div className="chart-title">Last 7 days</div>
        {history === null && !historyError && (
          <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8' }}>
            Loading chart...
          </div>
        )}
        {historyError && (
          <div style={{ color: '#dc2626', fontSize: 12 }}>{historyError}</div>
        )}
        {history && history.length > 0 && (
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={history} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis
                dataKey="time"
                tickFormatter={(t) => {
                  const d = new Date(t)
                  return `${d.getMonth() + 1}/${d.getDate()}`
                }}
                tick={{ fontSize: 10 }}
                interval="preserveStartEnd"
                minTickGap={40}
              />
              <YAxis
                tick={{ fontSize: 10 }}
                width={50}
                tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v)}
              />
              <Tooltip
                labelFormatter={(t) =>
                  new Date(t).toLocaleString(undefined, {
                    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                  })
                }
                formatter={(v) => [
                  isHeight ? `${v.toFixed(2)} ft` : `${Math.round(v).toLocaleString()} cfs`,
                  isHeight ? 'Gauge height' : 'Discharge',
                ]}
              />
              {isHeight && reading?.sevenDayAvg != null && (
                <ReferenceLine
                  y={reading.sevenDayAvg}
                  stroke="#94a3b8"
                  strokeDasharray="4 4"
                  label={{ value: '7-day avg', fontSize: 10, fill: '#64748b', position: 'right' }}
                />
              )}
              {!isHeight && median != null && (
                <ReferenceLine
                  y={median}
                  stroke="#94a3b8"
                  strokeDasharray="4 4"
                  label={{ value: 'Median', fontSize: 10, fill: '#64748b', position: 'right' }}
                />
              )}
              <Line
                type="monotone"
                dataKey={dataKey}
                stroke={markerColor}
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
        {history && history.length === 0 && !historyError && (
          <div style={{ color: '#94a3b8', fontSize: 12 }}>No 7-day data available.</div>
        )}

        <div style={{ marginTop: 10, fontSize: 11, color: '#64748b' }}>
          Last reading: {lastUpdated}
        </div>

        <a
          className="usgs-link"
          href={`https://waterdata.usgs.gov/monitoring-location/${gauge.siteNo}/`}
          target="_blank"
          rel="noopener noreferrer"
        >
          View full data on USGS →
        </a>
      </div>
    </div>
  )
}
