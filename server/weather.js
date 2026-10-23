// Open-Meteo 免费接口，无需 key；默认北京，可用环境变量改城市
const CITY = process.env.AT_CITY || '北京';
const LAT = +(process.env.AT_LAT || 39.9042);
const LON = +(process.env.AT_LON || 116.4074);
const TTL = 15 * 60e3;

let cache = null;

// WMO 天气代码 → 场景天气
function kindOf(code) {
  if (code === 0) return ['clear', '晴'];
  if (code <= 2) return ['partly', '多云'];
  if (code === 3) return ['cloudy', '阴'];
  if (code === 45 || code === 48) return ['fog', '雾'];
  if (code >= 51 && code <= 67) return ['rain', code >= 61 ? '雨' : '小雨'];
  if (code >= 71 && code <= 77) return ['snow', '雪'];
  if (code >= 80 && code <= 82) return ['rain', '阵雨'];
  if (code >= 85 && code <= 86) return ['snow', '阵雪'];
  if (code >= 95) return ['storm', '雷雨'];
  return ['partly', '多云'];
}

export async function getWeather() {
  if (cache && Date.now() - cache.fetchedAt < TTL) return cache;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m,weather_code,is_day,wind_speed_10m&daily=sunrise,sunset&timezone=auto&forecast_days=1`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const j = await res.json();
    const [kind, text] = kindOf(j.current.weather_code);
    cache = {
      ok: true, city: CITY, lat: LAT, lon: LON, kind, text, temp: Math.round(j.current.temperature_2m), wind: j.current.wind_speed_10m,
      // Open-Meteo 返回的是该城市当地时间字符串，按它给的时差换成时间戳
      utcOffset: j.utc_offset_seconds,
      sunrise: Date.parse(j.daily.sunrise[0] + ':00Z') - j.utc_offset_seconds * 1000, sunset: Date.parse(j.daily.sunset[0] + ':00Z') - j.utc_offset_seconds * 1000, fetchedAt: Date.now(),
    };
  } catch (e) {
    cache = { ok: false, city: CITY, lat: LAT, lon: LON, kind: 'partly', text: '天气获取失败', temp: null, fetchedAt: Date.now() - TTL + 60e3, error: String(e.message || e) };
  }
  return cache;
}
