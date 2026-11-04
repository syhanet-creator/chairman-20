const crypto = require('crypto');

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || APP_PASSWORD;

// ---------- Supabase REST (PostgREST) ----------
async function sb(path, { method = 'GET', body, prefer, count } = {}) {
  if (!SB_URL || !SB_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 없습니다.');
  const headers = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json',
  };
  const pref = [];
  if (prefer) pref.push(prefer);
  if (count) pref.push('count=exact');
  if (pref.length) headers.Prefer = pref.join(',');
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`DB 오류(${res.status}): ${text.slice(0, 300)}`);
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  let total = null;
  const cr = res.headers.get('content-range');
  if (cr && cr.includes('/')) {
    const t = cr.split('/')[1];
    if (t !== '*') total = parseInt(t, 10);
  }
  return { data, total };
}

// ---------- 인증(비밀번호 + 서명 토큰) ----------
function sign(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
}
function makeToken() {
  const exp = Date.now() + 1000 * 60 * 60 * 12; // 12시간
  const p = String(exp);
  return `${p}.${sign(p)}`;
}
function verifyToken(token) {
  if (!token || !SESSION_SECRET) return false;
  const [p, s] = String(token).split('.');
  if (!p || !s) return false;
  const expect = sign(p);
  if (s.length !== expect.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expect))) return false;
  return Number(p) > Date.now();
}
function authed(req) {
  const h = req.headers['authorization'] || '';
  return verifyToken(h.replace(/^Bearer\s+/i, ''));
}
function checkPassword(pw) {
  if (!APP_PASSWORD) return false;
  const a = Buffer.from(String(pw || ''));
  const b = Buffer.from(APP_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- 전화번호/문자 유틸 ----------
function normPhone(v) {
  let d = String(v || '').replace(/[^0-9]/g, '');
  if (d.startsWith('82')) d = '0' + d.slice(2);
  if (/^10[0-9]{8,9}$/.test(d)) d = '0' + d;
  return /^01[0-9]{8,9}$/.test(d) ? d : null;
}
function byteLen(s) {
  let n = 0;
  for (const ch of String(s)) n += ch.charCodeAt(0) > 127 ? 2 : 1;
  return n;
}
function msgType(text) {
  return byteLen(text) > 90 ? 'LMS' : 'SMS';
}

module.exports = { sb, authed, makeToken, checkPassword, normPhone, byteLen, msgType };
