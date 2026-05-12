// ===== STREAM GAUGE MAP v1.0.6 =====
// File: src/usgs.js
// Changes from v1.0.5:
//   - getGaugeHeightFallback: now ALWAYS returns height for the startup view
//     (no longer just a fallback when discharge is missing)
//   - get7DayHistoryHeight: returns full 7-day series for height-based classification
//   - classifyHeight: NEW - classifies current height vs the gauge's 7-day average

const SITE_BASE = 'https://waterservices.usgs.gov/nwis/site/'
const IV_BASE = 'https://waterservices.usgs.gov/nwis/iv/'
const DV_BASE = 'https://waterservices.usgs.gov/nwis/dv/'
const STATS_BASE = 'https://waterservices.usgs.gov/nwis/stat/'

const PARAM_DISCHARGE = '00060'
const PARAM_GAUGE_HEIGHT = '00065'

function parseRDB(text) {
  const lines = text.split('\n').filter((l) => l && !l.startsWith('#'))
  if (lines.length < 2) return []
  const headers = lines[0].split('\t')
  return lines.slice(2).map((line) => {
    const cells = line.split('\t')
    const obj = {}
    headers.forEach((h, i) => {
      obj[h] = cells[i]
    })
    return obj
  })
}

export async function getSitesInHUC(huc, paramCd = PARAM_DISCHARGE) {
  const url = `${SITE_BASE}?format=rdb&huc=${huc}&parameterCd=${paramCd}&siteType=ST&siteStatus=active&hasDataTypeCd=iv`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`USGS site service: HTTP ${res.status}`)
  const text = await res.text()
  return parseRDB(text)
    .filter((r) => r.dec_lat_va && r.dec_long_va && r.site_no)
    .map((r) => ({
      siteNo: r.site_no,
      name: r.station_nm,
      lat: parseFloat(r.dec_lat_va),
      lon: parseFloat(r.dec_long_va),
      huc: r.huc_cd,
      drainageArea: r.drain_area_va ? parseFloat(r.drain_area_va) : null,
      altitude: r.alt_va ? parseFloat(r.alt_va) : null,
    }))
}

export async function getCurrentReadings(siteNos) {
  if (siteNos.length === 0) return {}
  const chunks = []
  for (let i = 0; i < siteNos.length; i += 100) {
    chunks.push(siteNos.slice(i, i + 100))
  }
  const result = {}
  for (const chunk of chunks) {
    const url = `${IV_BASE}?format=json&sites=${chunk.join(',')}&parameterCd=${PARAM_DISCHARGE}&period=PT6H`
    const res = await fetch(url)
    if (!res.ok) continue
    const data = await res.json()
    for (const ts of data.value?.timeSeries || []) {
      const siteNo = ts.sourceInfo?.siteCode?.[0]?.value
      const values = ts.values?.[0]?.value || []
      if (!siteNo || values.length === 0) continue
      const numeric = values
        .map((v) => ({ t: new Date(v.dateTime).getTime(), v: parseFloat(v.value) }))
        .filter((p) => !isNaN(p.v) && p.v > -999999)
      if (numeric.length === 0) continue
      const last = numeric[numeric.length - 1]
      const first = numeric[0]
      const cfs = last.v
      const midpoint = numeric.find((p) => p.t >= last.t - 3 * 3600 * 1000)
      const reference = midpoint || first
      const delta = cfs - reference.v
      let trend = 'flat'
      const threshold = Math.max(5, reference.v * 0.05)
      if (delta > threshold) trend = 'rising'
      else if (delta < -threshold) trend = 'falling'
      result[siteNo] = {
        cfs,
        time: new Date(last.t).toISOString(),
        trend,
        delta,
        source: 'iv',
      }
    }
  }
  return result
}

export async function getDailyValueFallback(siteNo) {
  try {
    const end = new Date()
    const start = new Date(end.getTime() - 30 * 24 * 3600 * 1000)
    const url = `${DV_BASE}?format=json&sites=${siteNo}&parameterCd=${PARAM_DISCHARGE}&startDT=${start.toISOString().slice(0, 10)}&endDT=${end.toISOString().slice(0, 10)}`
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json()
    const ts = data.value?.timeSeries?.[0]
    if (!ts) return null
    const values = (ts.values?.[0]?.value || [])
      .map((v) => ({ t: v.dateTime, cfs: parseFloat(v.value) }))
      .filter((p) => !isNaN(p.cfs) && p.cfs > -999999)
    if (values.length === 0) return null
    const last = values[values.length - 1]
    let trend = 'flat'
    let delta = null
    if (values.length >= 2) {
      const ref = values[Math.max(0, values.length - 4)]
      delta = last.cfs - ref.cfs
      const threshold = Math.max(5, ref.cfs * 0.1)
      if (delta > threshold) trend = 'rising'
      else if (delta < -threshold) trend = 'falling'
    }
    return { cfs: last.cfs, time: last.t, trend, delta, source: 'dv' }
  } catch (e) {
    console.warn(`DV fallback failed for ${siteNo}:`, e)
    return null
  }
}

/**
 * Get current gauge height (feet) plus a 7-day average for classification.
 * Returns: { feet, time, trend, delta, source: 'height', sevenDayAvg }
 */
export async function getHeightReading(siteNo) {
  try {
    const url = `${IV_BASE}?format=json&sites=${siteNo}&parameterCd=${PARAM_GAUGE_HEIGHT}&period=P7D`
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json()
    const ts = data.value?.timeSeries?.[0]
    if (!ts) return null
    const values = (ts.values?.[0]?.value || [])
      .map((v) => ({ t: new Date(v.dateTime).getTime(), v: parseFloat(v.value) }))
      .filter((p) => !isNaN(p.v) && p.v > -999)
    if (values.length === 0) return null
    const last = values[values.length - 1]
    const feet = last.v

    // 3-hour trend
    const midpoint = values.find((p) => p.t >= last.t - 3 * 3600 * 1000) || values[0]
    const delta = feet - midpoint.v
    let trend = 'flat'
    const threshold = Math.max(0.1, midpoint.v * 0.05)
    if (delta > threshold) trend = 'rising'
    else if (delta < -threshold) trend = 'falling'

    // 7-day average — for classification
    const sevenDayAvg =
      values.reduce((sum, p) => sum + p.v, 0) / values.length

    return {
      feet,
      time: new Date(last.t).toISOString(),
      trend,
      delta,
      source: 'height',
      sevenDayAvg,
    }
  } catch (e) {
    console.warn(`Height reading failed for ${siteNo}:`, e)
    return null
  }
}

export async function get7DayHistory(siteNo) {
  try {
    const url = `${IV_BASE}?format=json&sites=${siteNo}&parameterCd=${PARAM_DISCHARGE}&period=P7D`
    const res = await fetch(url)
    if (res.ok) {
      const data = await res.json()
      const ts = data.value?.timeSeries?.[0]
      if (ts) {
        const points = (ts.values?.[0]?.value || [])
          .map((v) => ({ time: v.dateTime, cfs: parseFloat(v.value) }))
          .filter((p) => !isNaN(p.cfs) && p.cfs > -999999)
        if (points.length > 0) return points
      }
    }
  } catch {}
  try {
    const end = new Date()
    const start = new Date(end.getTime() - 7 * 24 * 3600 * 1000)
    const url = `${DV_BASE}?format=json&sites=${siteNo}&parameterCd=${PARAM_DISCHARGE}&startDT=${start.toISOString().slice(0, 10)}&endDT=${end.toISOString().slice(0, 10)}`
    const res = await fetch(url)
    if (!res.ok) return []
    const data = await res.json()
    const ts = data.value?.timeSeries?.[0]
    if (!ts) return []
    return (ts.values?.[0]?.value || [])
      .map((v) => ({ time: v.dateTime, cfs: parseFloat(v.value) }))
      .filter((p) => !isNaN(p.cfs) && p.cfs > -999999)
  } catch {
    return []
  }
}

export async function get7DayHistoryHeight(siteNo) {
  try {
    const url = `${IV_BASE}?format=json&sites=${siteNo}&parameterCd=${PARAM_GAUGE_HEIGHT}&period=P7D`
    const res = await fetch(url)
    if (!res.ok) return []
    const data = await res.json()
    const ts = data.value?.timeSeries?.[0]
    if (!ts) return []
    return (ts.values?.[0]?.value || [])
      .map((v) => ({ time: v.dateTime, feet: parseFloat(v.value) }))
      .filter((p) => !isNaN(p.feet) && p.feet > -999)
  } catch {
    return []
  }
}

export async function getMedianFlow(siteNo) {
  try {
    const url = `${STATS_BASE}?format=rdb&sites=${siteNo}&statReportType=daily&statTypeCd=median&parameterCd=${PARAM_DISCHARGE}`
    const res = await fetch(url)
    if (!res.ok) return null
    const text = await res.text()
    const rows = parseRDB(text)
    if (rows.length === 0) return null
    const today = new Date()
    const m = today.getMonth() + 1
    const d = today.getDate()
    const todayRow = rows.find((r) => parseInt(r.month_nu) === m && parseInt(r.day_nu) === d)
    if (todayRow && todayRow.p50_va) return parseFloat(todayRow.p50_va)
    const all = rows.map((r) => parseFloat(r.p50_va)).filter((n) => !isNaN(n))
    if (all.length === 0) return null
    return all.reduce((a, b) => a + b, 0) / all.length
  } catch {
    return null
  }
}

/**
 * Classify discharge against historical median.
 */
export function classifyFlow(cfs, median) {
  if (cfs == null || isNaN(cfs)) return 'no-data'
  if (median == null) {
    if (cfs < 10) return 'very-low'
    if (cfs < 100) return 'low'
    if (cfs < 1000) return 'normal'
    if (cfs < 5000) return 'high'
    return 'very-high'
  }
  const ratio = cfs / Math.max(median, 0.1)
  if (ratio < 0.25) return 'very-low'
  if (ratio < 0.75) return 'low'
  if (ratio < 1.5) return 'normal'
  if (ratio < 4) return 'high'
  return 'very-high'
}

/**
 * NEW: Classify current gauge height vs the gauge's own 7-day average.
 * Uses absolute deviation in feet rather than ratio (more meaningful for height).
 */
export function classifyHeight(currentFt, sevenDayAvgFt) {
  if (currentFt == null || isNaN(currentFt)) return 'no-data'
  if (sevenDayAvgFt == null || isNaN(sevenDayAvgFt)) return 'normal'
  const delta = currentFt - sevenDayAvgFt
  // Thresholds chosen so small streams aren't perpetually alarmed.
  // Tune here if results are too sensitive / not sensitive enough.
  if (delta < -1.5) return 'very-low'
  if (delta < -0.5) return 'low'
  if (delta < 0.5) return 'normal'
  if (delta < 2.0) return 'high'
  return 'very-high'
}

export const FLOW_COLORS = {
  'no-data': '#94a3b8',
  'very-low': '#dc2626',
  'low': '#f97316',
  'normal': '#16a34a',
  'high': '#0ea5e9',
  'very-high': '#7c3aed',
}

export const FLOW_LABELS = {
  'no-data': 'No data',
  'very-low': 'Very low',
  'low': 'Below normal',
  'normal': 'Normal',
  'high': 'Above normal',
  'very-high': 'High / flood',
}

function distKm(lat1, lon1, lat2, lon2) {
  const R = 6371
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.asin(Math.sqrt(a))
}

function regionalUpstreamVector(huc2) {
  const map = {
    '01': [0.3, -1.0], '02': [0.3, -1.0], '03': [1.0, 0.3], '04': [-0.7, 0.7],
    '05': [0.7, 0.7], '06': [1.0, 0.3], '07': [1.0, 0.3], '08': [1.0, 0.3],
    '09': [1.0, 0.3], '10': [0.5, -1.0], '11': [0.5, -1.0], '12': [1.0, -0.3],
    '13': [0.3, -1.0], '14': [1.0, -0.5], '15': [0.5, -1.0], '16': [1.0, 0.0],
    '17': [0.5, 1.0], '18': [0.5, 1.0],
  }
  const vec = map[huc2] || [1.0, 0.0]
  const mag = Math.hypot(vec[0], vec[1])
  return [vec[0] / mag, vec[1] / mag]
}

async function getCombinedSitesInHUC(huc) {
  try {
    const [discharge, height] = await Promise.all([
      getSitesInHUC(huc, PARAM_DISCHARGE).catch(() => []),
      getSitesInHUC(huc, PARAM_GAUGE_HEIGHT).catch(() => []),
    ])
    const dischargeSet = new Set(discharge.map((s) => s.siteNo))
    const merged = discharge.map((s) => ({ ...s, reportsDischarge: true }))
    for (const s of height) {
      if (!dischargeSet.has(s.siteNo)) {
        merged.push({ ...s, reportsDischarge: false, reportsHeight: true })
      } else {
        const existing = merged.find((m) => m.siteNo === s.siteNo)
        if (existing) existing.reportsHeight = true
      }
    }
    return merged
  } catch (e) {
    console.warn(`Combined HUC fetch failed for ${huc}:`, e)
    return []
  }
}

export async function selectUpstreamGauges(reference, n = 7) {
  const huc8 = (reference.huc || '').slice(0, 8)
  const huc6 = huc8.slice(0, 6)
  const huc4 = huc8.slice(0, 4)

  const tried = new Set()
  let candidates = []

  for (const huc of [huc8, huc6, huc4].filter((h) => h && h.length >= 4)) {
    if (tried.has(huc)) continue
    tried.add(huc)
    try {
      const sites = await getSitesInHUC(huc)
      const have = new Set(candidates.map((s) => s.siteNo))
      for (const s of sites) if (!have.has(s.siteNo)) candidates.push(s)
    } catch (e) {
      console.warn(`HUC ${huc} fetch failed:`, e)
    }
    if (candidates.length >= n * 4) break
  }

  candidates = candidates.filter((c) => c.siteNo !== reference.siteNo)

  const refDA = reference.drainageArea
  const refAlt = reference.altitude
  const scored = candidates.map((c) => {
    const d = distKm(reference.lat, reference.lon, c.lat, c.lon)
    let upstreamScore = 0
    if (refDA && c.drainageArea) {
      if (c.drainageArea < refDA) upstreamScore += 50
      else upstreamScore -= 20
    }
    if (refAlt && c.altitude) {
      if (c.altitude > refAlt) upstreamScore += 30
      else upstreamScore -= 10
    }
    if (c.huc && c.huc.startsWith(huc8)) upstreamScore += 20
    const distPenalty = d * 0.5
    return { site: c, distKm: d, score: upstreamScore - distPenalty }
  })

  scored.sort((a, b) => b.score - a.score)
  const within = scored.filter((s) => s.distKm < 200)
  const top = (within.length >= n ? within : scored).slice(0, n).map((s) => s.site)
  return top
}

export async function selectUpstreamGaugesIncludingHeightOnly(reference, n = 7) {
  const huc8 = (reference.huc || '').slice(0, 8)
  const huc6 = huc8.slice(0, 6)
  const huc4 = huc8.slice(0, 4)

  const tried = new Set()
  let candidates = []

  for (const huc of [huc8, huc6, huc4].filter((h) => h && h.length >= 4)) {
    if (tried.has(huc)) continue
    tried.add(huc)
    const sites = await getCombinedSitesInHUC(huc)
    const have = new Set(candidates.map((s) => s.siteNo))
    for (const s of sites) if (!have.has(s.siteNo)) candidates.push(s)
    if (candidates.length >= n * 4) break
  }

  candidates = candidates.filter((c) => c.siteNo !== reference.siteNo)

  const refDA = reference.drainageArea
  const refAlt = reference.altitude
  const scored = candidates.map((c) => {
    const d = distKm(reference.lat, reference.lon, c.lat, c.lon)
    let score = 0
    if (refDA && c.drainageArea) {
      if (c.drainageArea < refDA) score += 50
      else score -= 20
    }
    if (refAlt && c.altitude) {
      if (c.altitude > refAlt) score += 30
      else score -= 10
    }
    if (c.huc && c.huc.startsWith(huc8)) score += 20
    if (c.reportsDischarge) score += 10
    const distPenalty = d * 0.5
    return { site: c, distKm: d, score: score - distPenalty }
  })

  scored.sort((a, b) => b.score - a.score)
  const within = scored.filter((s) => s.distKm < 200)
  return (within.length >= n ? within : scored).slice(0, n).map((s) => s.site)
}

async function fetchSitesInBBox(lat, lon, halfSize) {
  const round = (x) => Math.round(x * 10000) / 10000
  const west = round(lon - halfSize)
  const south = round(lat - halfSize)
  const east = round(lon + halfSize)
  const north = round(lat + halfSize)
  const bbox = `${west},${south},${east},${north}`
  const url = `${SITE_BASE}?format=rdb&bBox=${bbox}&parameterCd=${PARAM_DISCHARGE}&siteType=ST&siteStatus=active&hasDataTypeCd=iv&siteOutput=expanded`
  const res = await fetch(url)
  if (!res.ok) {
    const msg = await res.text().catch(() => '')
    throw new Error(`USGS site search HTTP ${res.status}${msg ? ': ' + msg.slice(0, 100) : ''}`)
  }
  const text = await res.text()
  return parseRDB(text)
    .filter((r) => r.dec_lat_va && r.dec_long_va)
    .map((r) => ({
      siteNo: r.site_no,
      name: r.station_nm,
      lat: parseFloat(r.dec_lat_va),
      lon: parseFloat(r.dec_long_va),
      huc: r.huc_cd,
      drainageArea: r.drain_area_va ? parseFloat(r.drain_area_va) : null,
      altitude: r.alt_va ? parseFloat(r.alt_va) : null,
    }))
}

export async function selectUpstreamFromLocation(lat, lon, n = 8) {
  let sites = []
  const bboxSizes = [0.5, 1.0, 2.0]
  let lastError = null
  for (const halfSize of bboxSizes) {
    try {
      sites = await fetchSitesInBBox(lat, lon, halfSize)
      if (sites.length > 0) break
    } catch (e) {
      lastError = e
      console.warn(`bbox ${halfSize}° failed:`, e.message)
    }
  }

  if (sites.length === 0) {
    if (lastError) throw new Error(`Could not search for gauges near you. ${lastError.message}`)
    throw new Error('No stream gauges found within ~220 km of your location.')
  }

  sites.sort((a, b) => distKm(lat, lon, a.lat, a.lon) - distKm(lat, lon, b.lat, b.lon))
  const nearest = sites[0]

  const huc2 = (nearest.huc || '').slice(0, 2)
  const upstreamVec = regionalUpstreamVector(huc2)

  const candidates = await selectUpstreamGauges(nearest, n * 4)

  const refDA = nearest.drainageArea
  const refAlt = nearest.altitude

  function isInUpstreamDirection(g) {
    const dLat = g.lat - lat
    const dLon = g.lon - lon
    const mag = Math.hypot(dLat, dLon)
    if (mag < 0.001) return true
    const dot = (dLat / mag) * upstreamVec[0] + (dLon / mag) * upstreamVec[1]
    return dot > -0.2
  }
  function hasSmallerDrainage(g) {
    if (refDA != null && g.drainageArea != null) return g.drainageArea < refDA
    if (refAlt != null && g.altitude != null) return g.altitude > refAlt
    return true
  }

  const strict = candidates.filter((g) => isInUpstreamDirection(g) && hasSmallerDrainage(g))
  let result = strict
  if (result.length < n) {
    const have = new Set(result.map((g) => g.siteNo))
    const relaxed = candidates.filter(
      (g) => !have.has(g.siteNo) && (isInUpstreamDirection(g) || hasSmallerDrainage(g))
    )
    result = [...result, ...relaxed]
  }
  if (result.length < n) {
    const have = new Set(result.map((g) => g.siteNo))
    for (const g of candidates) {
      if (!have.has(g.siteNo)) {
        result.push(g)
        if (result.length >= n) break
      }
    }
  }
  return result.slice(0, n)
}
