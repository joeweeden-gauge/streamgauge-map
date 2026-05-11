// ===== STREAM GAUGE MAP v1.0.1 =====
// File: src/usgs.js
// If you can see this comment in GitHub after pasting, the paste worked.

// USGS Water Services API client
// Docs: https://waterservices.usgs.gov/

const SITE_BASE = 'https://waterservices.usgs.gov/nwis/site/'
const IV_BASE = 'https://waterservices.usgs.gov/nwis/iv/'
const STATS_BASE = 'https://waterservices.usgs.gov/nwis/stat/'

// Parameter codes: 00060 = discharge (CFS), 00065 = gauge height (ft)
const PARAM_DISCHARGE = '00060'

/**
 * Parse USGS RDB (tab-delimited) format. Returns an array of row objects.
 */
function parseRDB(text) {
  const lines = text.split('\n').filter((l) => l && !l.startsWith('#'))
  if (lines.length < 2) return []
  const headers = lines[0].split('\t')
  // line 1 is the format-spec row (e.g. "5s\t15s\t..."), skip it
  return lines.slice(2).map((line) => {
    const cells = line.split('\t')
    const obj = {}
    headers.forEach((h, i) => {
      obj[h] = cells[i]
    })
    return obj
  })
}

/**
 * Get all stream sites in a HUC that report discharge.
 * huc can be 2, 4, 6, or 8 digits.
 */
export async function getSitesInHUC(huc) {
  const url = `${SITE_BASE}?format=rdb&huc=${huc}&parameterCd=${PARAM_DISCHARGE}&siteType=ST&siteStatus=active&hasDataTypeCd=iv`
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

/**
 * Get current discharge readings for a list of site numbers.
 * Returns map: siteNo -> { cfs, gaugeHeight, time, rising }
 */
export async function getCurrentReadings(siteNos) {
  if (siteNos.length === 0) return {}
  // USGS allows up to 100 sites per request; chunk if needed
  const chunks = []
  for (let i = 0; i < siteNos.length; i += 100) {
    chunks.push(siteNos.slice(i, i + 100))
  }
  const result = {}
  for (const chunk of chunks) {
    // Pull last 6 hours so we can compute rising/falling
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
      // rising/falling: compare last reading to ~3hr earlier
      const midpoint = numeric.find((p) => p.t >= last.t - 3 * 3600 * 1000)
      const reference = midpoint || first
      const delta = cfs - reference.v
      let trend = 'flat'
      // Use a relative threshold: 5% change OR 5 cfs absolute, whichever is bigger
      const threshold = Math.max(5, reference.v * 0.05)
      if (delta > threshold) trend = 'rising'
      else if (delta < -threshold) trend = 'falling'
      result[siteNo] = {
        cfs,
        time: new Date(last.t).toISOString(),
        trend,
        delta,
      }
    }
  }
  return result
}

/**
 * Get 7-day discharge time series for a single site.
 * Returns array of { time: ISO string, cfs: number }
 */
export async function get7DayHistory(siteNo) {
  const url = `${IV_BASE}?format=json&sites=${siteNo}&parameterCd=${PARAM_DISCHARGE}&period=P7D`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`History fetch failed: ${res.status}`)
  const data = await res.json()
  const ts = data.value?.timeSeries?.[0]
  if (!ts) return []
  return (ts.values?.[0]?.value || [])
    .map((v) => ({ time: v.dateTime, cfs: parseFloat(v.value) }))
    .filter((p) => !isNaN(p.cfs) && p.cfs > -999999)
}

/**
 * Get historical median (long-term daily statistics) for a site.
 * Used to color-code current flow as low/normal/high vs. typical.
 */
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
    // fallback: average all medians
    const all = rows.map((r) => parseFloat(r.p50_va)).filter((n) => !isNaN(n))
    if (all.length === 0) return null
    return all.reduce((a, b) => a + b, 0) / all.length
  } catch {
    return null
  }
}

/**
 * Classify a current CFS reading against historical median.
 * Returns one of: 'no-data', 'very-low', 'low', 'normal', 'high', 'very-high'
 */
export function classifyFlow(cfs, median) {
  if (cfs == null || isNaN(cfs)) return 'no-data'
  if (median == null) {
    // Without context, fall back to absolute thresholds
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

export const FLOW_COLORS = {
  'no-data': '#94a3b8',
  'very-low': '#dc2626', // red — drought / very low
  'low': '#f97316',      // orange — below normal
  'normal': '#16a34a',   // green — typical
  'high': '#0ea5e9',     // sky blue — above normal
  'very-high': '#7c3aed',// purple — flood-stage range
}

export const FLOW_LABELS = {
  'no-data': 'No data',
  'very-low': 'Very low',
  'low': 'Below normal',
  'normal': 'Normal',
  'high': 'Above normal',
  'very-high': 'High / flood',
}

/**
 * Haversine distance in km.
 */
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

/**
 * Select up to N gauges that are upstream of a starting point and reasonably nearby.
 */
export async function selectUpstreamGauges(reference, n = 7) {
  const huc8 = (reference.huc || '').slice(0, 8)
  const huc6 = huc8.slice(0, 6)
  const huc4 = huc8.slice(0, 4)

  const tried = new Set()
  let candidates = []

  // Try HUC8 first, expand outward as needed
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

  const refSiteNo = reference.siteNo
  candidates = candidates.filter((c) => c.siteNo !== refSiteNo)

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

/**
 * Find the nearest gauge to a lat/lon, then select upstream gauges from there.
 */
export async function selectUpstreamFromLocation(lat, lon, n = 8) {
  const bbox = [lon - 1, lat - 1, lon + 1, lat + 1].join(',')
  const url = `${SITE_BASE}?format=rdb&bBox=${bbox}&parameterCd=${PARAM_DISCHARGE}&siteType=ST&siteStatus=active&hasDataTypeCd=iv&siteOutput=expanded`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Site search failed: ${res.status}`)
  const text = await res.text()
  const sites = parseRDB(text)
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

  if (sites.length === 0) {
    throw new Error('No stream gauges found within ~110 km of your location.')
  }

  sites.sort((a, b) => distKm(lat, lon, a.lat, a.lon) - distKm(lat, lon, b.lat, b.lon))
  const nearest = sites[0]

  const upstream = await selectUpstreamGauges(nearest, n - 1)
  return [nearest, ...upstream]
}
