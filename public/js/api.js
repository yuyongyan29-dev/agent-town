// 与本地服务端通信：SSE 实时流 + 普通接口
export async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
}

export async function postJSON(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `请求失败 ${r.status}`);
  return data;
}

/** 连上 /api/stream；断开后浏览器会自动重连 */
export function connect({ onState, onEvent, onStatus }) {
  const es = new EventSource('/api/stream');
  es.addEventListener('state', (e) => { onStatus?.(true); onState(JSON.parse(e.data)); });
  es.addEventListener('event', (e) => onEvent(JSON.parse(e.data)));
  es.onopen = () => onStatus?.(true);
  es.onerror = () => onStatus?.(false);
  return es;
}
