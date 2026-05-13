// ===== STREAM GAUGE MAP v1.0.8 =====
// File: src/precip.js
// Precipitation data client. Uses Open-Meteo (free, no API key, CORS-enabled).
// https://open-meteo.com/en/docs

/**
 * Fetch daily precipitation totals (in inches) for a lat/lon.
 * Returns past 7 days plus today's running total, indexed newest-first.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<{daily: Array<{date: string, inches: number}>,
 *                   total24h: number, total72h: number, total7d: number}>}
 */
export async function getPrecipitation(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=precipitation_sum&past_days=7&forecast_days=1&precipitation_unit=inch&timezone=America%2FChicago`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`)
  const data = await res.json()
  const times = data.daily?.time || []
  const sums = data.daily?.precipitation_sum || []
  if (times.length === 0 || sums.length === 0) {
    throw new Error('No precipitation data returned.')
  }
  const daily = times
    .map((date, i) => ({ date, inches: Number(sums[i]) || 0 }))
    .reverse() // newest first

  // Aggregate windows. daily[0] is today; daily[1] = yesterday, etc.
  // 24h = today's running total (most recent day)
  // 72h = sum of last 3 days
  // 7d = sum of all 7 past days (excludes "today" so 7 full days of data)
  const total24h = daily[0]?.inches || 0
  const total72h = daily.slice(0, 3).reduce((sum, d) => sum + d.inches, 0)
  const total7d = daily.slice(1, 8).reduce((sum, d) => sum + d.inches, 0)

  return { daily, total24h, total72h, total7d }
}
