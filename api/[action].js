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
      return [200, { message: data[0], failed_total: rc.total, failed: fails.data }];
    }
    const size = Math.min(100, parseInt(query.size, 10) || 30);
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const { data, total } = await sb(
      `jsms_messages?select=*&order=created_at.desc&limit=${size}&offset=${(page - 1) * size}`, { count: true });
    return [200, { rows: data, total }];
  },

  // ---------- 발송 1단계: 메시지+수신자 확정 ----------
  async send_create(req, body) {
    const settings = await getSettings();
    let text = String(body.body || '').trim();
    if (!text) return [400, { error: '문자 내용이 없습니다.' }];
    const isAd = !!body.is_ad;
    if (isAd) {
      if (!text.startsWith('(광고)')) text = `(광고)${settings.org_name} ${text}`;
      text += `\n${settings.ad_footer}`;
    }
    const filter = { category: body.category || null, tag: body.tag || null };
    const cnt = await sb(`jsms_contacts?select=id&${targetQuery(filter)}&limit=1`, { count: true });
    if (!cnt.total) return [400, { error: '발송 대상이 없습니다.' }];

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
        target_filter: filter,
        total_count: cnt.total,
        status: 'sending',
        sent_at: new Date().toISOString(),
      },
    });
    const messageId = m[0].id;

    // 수신자 스냅샷 저장 (1000명씩 읽어 500명씩 insert)
    let offset = 0;
    for (;;) {
      const { data } = await sb(
        `jsms_contacts?select=id,name,phone&${targetQuery(filter)}&order=created_at.asc,id.asc&limit=1000&offset=${offset}`);
      for (let i = 0; i < data.length; i += 500) {
        const part = data.slice(i, i + 500).map((c) => ({
          message_id: messageId, contact_id: c.id, name: c.name, phone: c.phone,
        }));
        await sb('jsms_message_recipients', { method: 'POST', body: part });
      }
      if (data.length < 1000) break;
      offset += 1000;
    }
    await audit('send.create', { messageId, total: cnt.total, provider: settings.provider });
    return [200, { message_id: messageId, total: cnt.total, msg_type: m[0].msg_type, provider: settings.provider }];
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

    const { data: pend } = await sb(
      `jsms_message_recipients?select=id,phone&message_id=eq.${enc(id)}&status=eq.pending&order=id.asc&limit=${size}`);

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
