// ===== STREAM GAUGE MAP v1.0.3 =====
// File: src/usgs.js
// Changes from v1.0.2:
//   - getDailyValueFallback: pulls most recent DV when IV data is unavailable
//   - selectUpstreamFromLocation: hybrid filter (drainage area + regional flow
//     direction) so gauges south/downstream of the user are excluded
//   - Flow direction is approximated per HUC-2 (major US watershed region)

const SITE_BASE = 'https://waterservices.usgs.gov/nwis/site/'
const IV_BASE = 'https://waterservices.usgs.gov/nwis/iv/'
const DV_BASE = 'https://waterservices.usgs.gov/nwis/dv/'
const STATS_BASE = 'https://waterservices.usgs.gov/nwis/stat/'

const PARAM_DISCHARGE = '00060'

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

/**
 * Pull the most recent daily value for a site. Used as a fallback when the
 * gauge doesn't report instantaneous values. Returns null if no DV either.
 */
export async function getDailyValueFallback(siteNo) {
  try {
    // Pull last 30 days of daily values; pick the most recent non-null
    const end = new Date()
    const start = new Date(end.getTime() - 30 * 24 * 3600 * 1000)
    const startStr = start.toISOString().slice(0, 10)
    const endStr = end.toISOString().slice(0, 10)
    const url = `${DV_BASE}?format=json&sites=${siteNo}&parameterCd=${PARAM_DISCHARGE}&startDT=${startStr}&endDT=${endStr}`
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json()
    const ts = data.value?.timeSeries?.[0]
    if (!ts) return null
    const values = (ts.values?.[0]?.value || [])
      .map((v) => ({ t: v.dateTime, cfs: parseFloat(v.value) }))
      .filter((p) => !isNaN(p.cfs) && p.cfs > -999999)
    if (values.length === 0) return null
    // Most recent reading
    const last = values[values.length - 1]
    // Compute trend by comparing to ~3 days earlier if available
    let trend = 'flat'
    let delta = null
    if (values.length >= 2) {
      const ref = values[Math.max(0, values.length - 4)] // ~3 days back
      delta = last.cfs - ref.cfs
      const threshold = Math.max(5, ref.cfs * 0.1)
      if (delta > threshold) trend = 'rising'
      else if (delta < -threshold) trend = 'falling'
    }
    return {
      cfs: last.cfs,
      time: last.t,
      trend,
      delta,
      source: 'dv', // flag so UI can show "daily value" indicator
    }
  } catch (e) {
    console.warn(`DV fallback failed for ${siteNo}:`, e)
    return null
  }
}

export async function get7DayHistory(siteNo) {
  // Try IV first
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
  // Fallback to DV
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

/**
 * Approximate "uphill" direction (the direction water flows FROM, i.e. toward
 * which upstream gauges lie) for each USGS major HUC-2 region. Returned as a
 * unit vector in (dLat, dLon) space.
 *
 * The vector points TOWARD upstream. A gauge is upstream of a point if the
 * vector from the point to the gauge has a positive dot product with this.
 *
 * These are coarse but useful — rivers in each region flow predominantly in
 * one general direction.
 */
function regionalUpstreamVector(huc2) {
  const map = {
    // Region: upstream is generally...
    '01': [0.3, -1.0],   // New England — west
    '02': [0.3, -1.0],   // Mid-Atlantic — west
    '03': [1.0, 0.3],    // South Atlantic-Gulf — north
    '04': [-0.7, 0.7],   // Great Lakes — varies; default SE drain (upstream NW)
    '05': [0.7, 0.7],    // Ohio — NE (tributaries from N/NE)
    '06': [1.0, 0.3],    // Tennessee — north
    '07': [1.0, 0.3],    // Upper Mississippi — north
    '08': [1.0, 0.3],    // Lower Mississippi — north
    '09': [1.0, 0.3],    // Souris-Red-Rainy — north
    '10': [0.5, -1.0],   // Missouri — west (drains east)
    '11': [0.5, -1.0],   // Arkansas-White-Red — NW (Bird Creek region)
    '12': [1.0, -0.3],   // Texas-Gulf — north/NW (San Antonio basin)
    '13': [0.3, -1.0],   // Rio Grande — west/NW
    '14': [1.0, -0.5],   // Upper Colorado — north
    '15': [0.5, -1.0],   // Lower Colorado — NE
    '16': [1.0, 0.0],    // Great Basin — varies, default north
    '17': [0.5, 1.0],    // Pacific Northwest — east (drains W)
    '18': [0.5, 1.0],    // California — east (Sierra)
  }
  const vec = map[huc2] || [1.0, 0.0] // default: north
  // Normalize
  const mag = Math.hypot(vec[0], vec[1])
  return [vec[0] / mag, vec[1] / mag]
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

/**
 * Find gauges geographically upstream of a user location.
 *
 * Strategy (Option C — pragmatic hybrid):
 *  1. Find the nearest active gauge to seed a watershed search.
 *  2. Pull a generous pool of candidate upstream gauges using HUC + drainage area.
 *  3. Filter the pool with TWO geographic checks against the user's actual location:
 *     a) Drainage area smaller than the reference (true upstream in network).
 *     b) Direction: the gauge lies in the regional "upstream" direction
 *        from the user (e.g. north/NW in Texas-Gulf region).
 *  4. If too few survive, relax to "either condition" instead of "both."
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

  const huc2 = (nearest.huc || '').slice(0, 2)
  const upstreamVec = regionalUpstreamVector(huc2)

  // Larger candidate pool so we have plenty to filter
  const candidates = await selectUpstreamGauges(nearest, n * 4)

  const refDA = nearest.drainageArea
  const refAlt = nearest.altitude

  // Score each candidate on two criteria measured from THE USER, not the nearest gauge
  function isInUpstreamDirection(g) {
    // Vector from user to candidate gauge
    const dLat = g.lat - lat
    const dLon = g.lon - lon
    const mag = Math.hypot(dLat, dLon)
    if (mag < 0.001) return true // essentially at user's location
    // Dot product with upstream unit vector
    const dot = (dLat / mag) * upstreamVec[0] + (dLon / mag) * upstreamVec[1]
    // Positive dot product = in the upstream half-plane.
    // Require dot > -0.2 (some tolerance to avoid being overly strict; ~100° cone)
    return dot > -0.2
  }

  function hasSmallerDrainage(g) {
    if (refDA != null && g.drainageArea != null) return g.drainageArea < refDA
    if (refAlt != null && g.altitude != null) return g.altitude > refAlt
    return true // unknown — be permissive
  }

  // Strict: both checks must pass
  const strict = candidates.filter((g) => isInUpstreamDirection(g) && hasSmallerDrainage(g))

  let result = strict
  // Relax to either condition if too few
  if (result.length < n) {
    const have = new Set(result.map((g) => g.siteNo))
    const relaxed = candidates.filter(
      (g) => !have.has(g.siteNo) && (isInUpstreamDirection(g) || hasSmallerDrainage(g))
    )
    result = [...result, ...relaxed]
  }
  // Last resort: original candidates
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
