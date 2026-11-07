const { sb, authed, makeToken, checkPassword, normPhone, byteLen, msgType } = require('./_lib');
const { send } = require('./_provider');

const enc = encodeURIComponent;

function targetQuery(f = {}) {
  // 발송 대상: 활성 + 수신거부 아님
  let q = 'active=eq.true&opt_out=eq.false';
  if (f.category) q += `&category=eq.${enc(f.category)}`;
  if (f.tag) q += `&tags=cs.{${enc(f.tag)}}`;
  return q;
}

async function audit(action, detail) {
  try { await sb('jsms_audit', { method: 'POST', body: { action, detail } }); } catch {}
}

async function getSettings() {
  const { data } = await sb('jsms_settings?id=eq.1');
  return data[0];
}

const DEDUPE_DAYS = 10;
const normText = (t) => String(t || '').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();

// 실제로 발송될 최종 본문 (광고성 문구 포함)
function buildText(body, isAd, settings) {
  let text = String(body || '').trim();
  if (text && isAd) {
    if (!text.startsWith('(광고)')) text = `(광고)${settings.org_name} ${text}`;
    text += `\n${settings.ad_footer}`;
  }
  return text;
}

// 최근 DEDUPE_DAYS일 이내, 같은 공급자(실발송/연습)로 보낸 동일 본문 메시지의 수신자 번호 집합
async function dupPhones({ text, provider, excludeId, statuses }) {
  const set = new Set();
  const key = normText(text);
  if (!key) return set;
  const since = new Date(Date.now() - DEDUPE_DAYS * 86400000).toISOString();
  const ids = [];
  for (let off = 0; ; off += 1000) {
    const { data } = await sb(
      `jsms_messages?select=id,body&provider=eq.${enc(provider)}&created_at=gte.${enc(since)}&order=created_at.desc&limit=1000&offset=${off}`);
    for (const m of data) if (m.id !== excludeId && normText(m.body) === key) ids.push(m.id);
    if (data.length < 1000) break;
  }
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50).join(',');
    for (let o = 0; ; o += 1000) {
      const { data } = await sb(
        `jsms_message_recipients?select=phone&message_id=in.(${part})&status=in.(${statuses.join(',')})&order=id.asc&limit=1000&offset=${o}`);
      data.forEach((r) => set.add(r.phone));
      if (data.length < 1000) break;
    }
  }
  return set;
}

async function loadTargets(filter) {
  const rows = [];
  for (let off = 0; ; off += 1000) {
    const { data } = await sb(
      `jsms_contacts?select=id,name,phone,category&${targetQuery(filter)}&order=created_at.asc,id.asc&limit=1000&offset=${off}`);
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

const handlers = {
  // ---------- 로그인 ----------
  async login(req, body) {
    if (!checkPassword(body.password)) return [401, { error: '비밀번호가 올바르지 않습니다.' }];
    return [200, { token: makeToken() }];
  },

  // ---------- 설정 ----------
  async settings(req, body) {
    if (req.method === 'PUT') {
      const patch = { updated_at: new Date().toISOString() };
      if (body.sender_label !== undefined) patch.sender_label = String(body.sender_label).slice(0, 40);
      if (body.org_name !== undefined) patch.org_name = String(body.org_name).slice(0, 40);
      if (body.ad_footer !== undefined) patch.ad_footer = String(body.ad_footer).slice(0, 80);
      if (body.chunk_size !== undefined) patch.chunk_size = Math.min(1000, Math.max(50, parseInt(body.chunk_size, 10) || 500));
      if (body.provider !== undefined) {
        if (!['console', 'solapi'].includes(body.provider)) return [400, { error: '잘못된 공급자' }];
        if (body.provider === 'solapi' && !(process.env.SOLAPI_API_KEY && process.env.SOLAPI_API_SECRET)) {
          return [400, { error: '솔라피 키가 서버 환경변수에 설정되지 않아 실발송으로 전환할 수 없습니다.' }];
        }
        patch.provider = body.provider;
      }
      await sb('jsms_settings?id=eq.1', { method: 'PATCH', body: patch });
      await audit('settings.update', patch);
    }
    const s = await getSettings();
    s.solapi_ready = !!(process.env.SOLAPI_API_KEY && process.env.SOLAPI_API_SECRET);
    return [200, s];
  },

  // ---------- 수신자 ----------
  async contacts(req, body, query) {
    if (req.method === 'GET') {
      const size = Math.min(200, parseInt(query.size, 10) || 50);
      const page = Math.max(1, parseInt(query.page, 10) || 1);
      let q = 'select=*&order=name.asc,created_at.asc';
      if (query.category) q += `&category=eq.${enc(query.category)}`;
      if (query.status === 'optout') q += '&opt_out=eq.true';
      if (query.status === 'inactive') q += '&active=eq.false';
      if (query.q) {
        const k = String(query.q).replace(/[(),*]/g, ' ').trim();
        if (k) q += `&or=(name.ilike.*${enc(k)}*,phone.ilike.*${enc(k.replace(/[^0-9]/g, '') || '@@')}*,memo.ilike.*${enc(k)}*)`;
      }
      q += `&limit=${size}&offset=${(page - 1) * size}`;
      const { data, total } = await sb(`jsms_contacts?${q}`, { count: true });
      return [200, { rows: data, total }];
    }
    if (req.method === 'POST') {
      const phone = normPhone(body.phone);
      if (!body.name || !phone) return [400, { error: '이름과 올바른 휴대폰 번호가 필요합니다.' }];
      const row = { name: String(body.name).trim(), phone, category: body.category || null, memo: body.memo || null };
      const { data } = await sb('jsms_contacts?on_conflict=phone', {
        method: 'POST', body: row, prefer: 'resolution=merge-duplicates,return=representation',
      });
      return [200, data[0]];
    }
    if (req.method === 'PATCH') {
      if (!body.id) return [400, { error: 'id 필요' }];
      const patch = { updated_at: new Date().toISOString() };
      if (body.name !== undefined) patch.name = String(body.name).trim();
      if (body.phone !== undefined) {
        const p = normPhone(body.phone);
        if (!p) return [400, { error: '번호 형식 오류' }];
        patch.phone = p;
      }
      if (body.category !== undefined) patch.category = body.category || null;
      if (body.memo !== undefined) patch.memo = body.memo || null;
      if (body.active !== undefined) patch.active = !!body.active;
      if (body.opt_out !== undefined) {
        patch.opt_out = !!body.opt_out;
        patch.opt_out_at = body.opt_out ? new Date().toISOString() : null;
      }
      await sb(`jsms_contacts?id=eq.${enc(body.id)}`, { method: 'PATCH', body: patch });
      return [200, { ok: true }];
    }
    if (req.method === 'DELETE') {
      if (!body.id) return [400, { error: 'id 필요' }];
      await sb(`jsms_contacts?id=eq.${enc(body.id)}`, { method: 'DELETE' });
      await audit('contact.delete', { id: body.id });
      return [200, { ok: true }];
    }
    return [405, { error: 'method' }];
  },

  // CSV에서 파싱된 행을 500건 단위로 받아 upsert
  async import(req, body) {
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const map = new Map();
    let invalid = 0;
    for (const r of rows) {
      const phone = normPhone(r.phone);
      const name = String(r.name || '').trim();
      if (!phone || !name) { invalid++; continue; }
      map.set(phone, {
        name, phone,
        category: r.category ? String(r.category).trim() : null,
        memo: r.memo ? String(r.memo).trim() : null,
        updated_at: new Date().toISOString(),
      });
    }
    const list = [...map.values()];
    if (list.length) {
      await sb('jsms_contacts?on_conflict=phone', { method: 'POST', body: list, prefer: 'resolution=merge-duplicates' });
    }
    return [200, { imported: list.length, duplicate_in_batch: rows.length - invalid - list.length, invalid }];
  },

  async categories() {
    const out = new Set();
    let offset = 0;
    for (;;) {
      const { data } = await sb(`jsms_contacts?select=category&category=not.is.null&limit=1000&offset=${offset}`);
      data.forEach((r) => r.category && out.add(r.category));
      if (data.length < 1000) break;
      offset += 1000;
    }
    return [200, [...out].sort()];
  },

  async stats() {
    const all = await sb('jsms_contacts?select=id&limit=1', { count: true });
    const sendable = await sb(`jsms_contacts?select=id&${targetQuery()}&limit=1`, { count: true });
    const optout = await sb('jsms_contacts?select=id&opt_out=eq.true&limit=1', { count: true });
    return [200, { total: all.total, sendable: sendable.total, optout: optout.total }];
  },

  // ---------- 템플릿 ----------
  async templates(req, body) {
    if (req.method === 'GET') {
      const { data } = await sb('jsms_templates?select=*&order=updated_at.desc');
      return [200, data];
    }
    if (req.method === 'POST') {
      if (!body.title || !body.body) return [400, { error: '제목과 내용이 필요합니다.' }];
      const { data } = await sb('jsms_templates', { method: 'POST', body: { title: body.title, body: body.body }, prefer: 'return=representation' });
      return [200, data[0]];
    }
    if (req.method === 'DELETE') {
      await sb(`jsms_templates?id=eq.${enc(body.id)}`, { method: 'DELETE' });
      return [200, { ok: true }];
    }
    return [405, { error: 'method' }];
  },

  // ---------- 발송 이력 ----------
  async messages(req, body, query) {
    if (query.id) {
      const { data } = await sb(`jsms_messages?id=eq.${enc(query.id)}`);
      const rc = await sb(`jsms_message_recipients?select=id&message_id=eq.${enc(query.id)}&status=eq.failed&limit=1`, { count: true });
      const fails = await sb(`jsms_message_recipients?select=name,phone,error&message_id=eq.${enc(query.id)}&status=eq.failed&limit=200`);
      const pc = await sb(`jsms_message_recipients?select=id&message_id=eq.${enc(query.id)}&status=eq.pending&limit=1`, { count: true });
      const sk = await sb(`jsms_message_recipients?select=id&message_id=eq.${enc(query.id)}&status=eq.skipped&limit=1`, { count: true });
      return [200, { message: data[0], failed_total: rc.total, pending_total: pc.total || 0, skipped_total: sk.total || 0, failed: fails.data }];
    }
    const size = Math.min(100, parseInt(query.size, 10) || 30);
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const { data, total } = await sb(
      `jsms_messages?select=*&order=created_at.desc&limit=${size}&offset=${(page - 1) * size}`, { count: true });
    return [200, { rows: data, total }];
  },

  // ---------- 발송 전 미리보기: 대상 구분별 인원 (최근 10일 동일 본문 수신자 자동 제외) ----------
  async send_preview(req, body) {
    const settings = await getSettings();
    const filter = { category: body.category || null, tag: body.tag || null };
    const targets = await loadTargets(filter);
    const text = buildText(body.body, !!body.is_ad, settings);
    const dup = text ? await dupPhones({ text, provider: settings.provider, statuses: ['sent', 'pending'] }) : new Set();
    const eligible = targets.filter((c) => !dup.has(c.phone));
    const counts = new Map();
    for (const r of eligible) {
      const k = r.category || '(구분 없음)';
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const dupCounts = new Map();
    for (const r of targets) if (dup.has(r.phone)) {
      const k = r.category || '(구분 없음)';
      dupCounts.set(k, (dupCounts.get(k) || 0) + 1);
    }
    const excluded = (await sb('jsms_contacts?select=id&or=(opt_out.eq.true,active.eq.false)&limit=1', { count: true })).total || 0;
    const toList = (m) => [...m.entries()].map(([name, count]) => ({ name, count }))
      .sort((x, y) => y.count - x.count || x.name.localeCompare(y.name, 'ko'));
    return [200, {
      total: eligible.length, categories: toList(counts), excluded,
      duplicates: targets.length - eligible.length, duplicate_categories: toList(dupCounts), dedupe_days: DEDUPE_DAYS,
    }];
  },

  // ---------- 발송 1단계: 메시지+수신자 확정 (동일 본문 중복 수신자는 skipped 처리) ----------
  async send_create(req, body) {
    const settings = await getSettings();
    const isAd = !!body.is_ad;
    const text = buildText(body.body, isAd, settings);
    if (!text) return [400, { error: '문자 내용이 없습니다.' }];
    const filter = { category: body.category || null, tag: body.tag || null };
    const targets = await loadTargets(filter);
    if (!targets.length) return [400, { error: '발송 대상이 없습니다.' }];
    const dup = await dupPhones({ text, provider: settings.provider, statuses: ['sent', 'pending'] });
    const eligible = targets.filter((c) => !dup.has(c.phone));
    const skipped = targets.filter((c) => dup.has(c.phone));
    if (!eligible.length) {
      return [400, { error: `대상 ${targets.length}명 모두 최근 ${DEDUPE_DAYS}일 이내 같은 내용을 받았거나 발송 대기 중이라 보낼 사람이 없습니다.` }];
    }
    if (body.expected_total !== undefined && Number(body.expected_total) !== eligible.length) {
      return [409, { error: `확인하신 대상 인원(${body.expected_total}명)과 현재 인원(${eligible.length}명)이 달라 발송을 중단했습니다. 다시 확인해 주세요.` }];
    }

    const { data: m } = await sb('jsms_messages', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        title: body.title || text.slice(0, 20),
        body: text,
        msg_type: msgType(text),
        byte_len: byteLen(text),
        is_ad: isAd,
        sender_number: settings.sender_number,
        provider: settings.provider,
        target_filter: { ...filter, duplicates_skipped: skipped.length, dedupe_days: DEDUPE_DAYS },
        total_count: eligible.length,
        status: 'sending',
        sent_at: new Date().toISOString(),
      },
    });
    const messageId = m[0].id;

    const rows = [
      ...eligible.map((c) => ({ message_id: messageId, contact_id: c.id, name: c.name, phone: c.phone })),
      ...skipped.map((c) => ({ message_id: messageId, contact_id: c.id, name: c.name, phone: c.phone,
        status: 'skipped', error: `최근 ${DEDUPE_DAYS}일 이내 동일 내용 수신` })),
    ];
    for (let i = 0; i < rows.length; i += 500) {
      await sb('jsms_message_recipients', { method: 'POST', body: rows.slice(i, i + 500) });
    }
    await audit('send.create', { messageId, total: eligible.length, duplicates_skipped: skipped.length, provider: settings.provider });
    return [200, { message_id: messageId, total: eligible.length, skipped: skipped.length, msg_type: m[0].msg_type, provider: settings.provider }];
  },

  // ---------- 발송 2단계: 대기 건을 청크 단위로 처리 (클라이언트가 반복 호출) ----------
  async send_chunk(req, body) {
    const id = body.message_id;
    if (!id) return [400, { error: 'message_id 필요' }];
    const { data: mm } = await sb(`jsms_messages?id=eq.${enc(id)}`);
    const msg = mm[0];
    if (!msg) return [404, { error: '메시지 없음' }];
    const settings = await getSettings();
    const size = settings.chunk_size || 500;

    let { data: pend } = await sb(
      `jsms_message_recipients?select=id,phone&message_id=eq.${enc(id)}&status=eq.pending&order=id.asc&limit=${size}`);

    // 이어서 발송/재시도 시에도 최근 10일 이내 다른 메시지로 이미 받은 사람은 건너뜀
    if (pend.length) {
      const got = await dupPhones({ text: msg.body, provider: msg.provider, excludeId: id, statuses: ['sent'] });
      const dupIds = pend.filter((r) => got.has(r.phone)).map((r) => r.id);
      if (dupIds.length) {
        await sb(`jsms_message_recipients?id=in.(${dupIds.join(',')})`, {
          method: 'PATCH', body: { status: 'skipped', error: `최근 ${DEDUPE_DAYS}일 이내 동일 내용 수신` },
        });
        pend = pend.filter((r) => !got.has(r.phone));
      }
    }

    if (pend.length) {
      const items = pend.map((r) => ({ to: r.phone, text: msg.body, type: msg.msg_type }));
      let failed = {};
      let groupId = null;
      let fatal = null;
      try {
        const r = await send(msg.provider, { from: msg.sender_number, items });
        failed = r.failed; groupId = r.groupId;
      } catch (e) { fatal = e.message; }

      const now = new Date().toISOString();
      const okIds = [], failRows = [];
      for (const r of pend) {
        if (fatal) failRows.push([r.id, fatal]);
        else if (failed[r.phone]) failRows.push([r.id, String(failed[r.phone]).slice(0, 200)]);
        else okIds.push(r.id);
      }
      if (okIds.length) {
        await sb(`jsms_message_recipients?id=in.(${okIds.join(',')})`, {
          method: 'PATCH', body: { status: 'sent', sent_at: now },
        });
      }
      for (const [rid, err] of failRows) {
        await sb(`jsms_message_recipients?id=eq.${rid}`, { method: 'PATCH', body: { status: 'failed', error: err, sent_at: now } });
      }
      if (groupId) await sb(`jsms_messages?id=eq.${enc(id)}`, { method: 'PATCH', body: { provider_group_id: groupId } });
    }

    const c = async (st) => (await sb(`jsms_message_recipients?select=id&message_id=eq.${enc(id)}&status=eq.${st}&limit=1`, { count: true })).total || 0;
    const [sent, failedN, pending] = await Promise.all([c('sent'), c('failed'), c('pending')]);
    const status = pending > 0 ? 'sending' : failedN === 0 ? 'done' : sent === 0 ? 'failed' : 'partial';
    await sb(`jsms_messages?id=eq.${enc(id)}`, { method: 'PATCH', body: { success_count: sent, fail_count: failedN, status } });
    return [200, { sent, failed: failedN, pending, status }];
  },

  // 실패 건 재시도 대기 전환
  async retry_failed(req, body) {
    await sb(`jsms_message_recipients?message_id=eq.${enc(body.message_id)}&status=eq.failed`, {
      method: 'PATCH', body: { status: 'pending', error: null },
    });
    await sb(`jsms_messages?id=eq.${enc(body.message_id)}`, { method: 'PATCH', body: { status: 'sending' } });
    return [200, { ok: true }];
  },
};

module.exports = async (req, res) => {
  const action = req.query.action;
  try {
    const fn = handlers[action];
    if (!fn) return res.status(404).json({ error: 'not found' });
    if (action !== 'login' && !authed(req)) return res.status(401).json({ error: '로그인이 필요합니다.' });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const [status, json] = await fn(req, body || {}, req.query);
    res.status(status).json(json);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
