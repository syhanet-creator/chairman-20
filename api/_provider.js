const crypto = require('crypto');

/**
 * 발송 공급자 어댑터.
 * - console: 실제 발송 없이 성공 처리(연습모드)
 * - solapi : 솔라피 API 연동 (SOLAPI_API_KEY / SOLAPI_API_SECRET 환경변수 필요)
 *
 * send({ from, items:[{to,text,type}] }) → { groupId, failed: { [to]: '사유' } }
 */
async function sendConsole({ from, items }) {
  console.log(`[연습모드] 발신 ${from} → ${items.length}건 (실제 발송 안 됨)`);
  return { groupId: 'console-' + Date.now(), failed: {} };
}

function solapiAuth() {
  const key = process.env.SOLAPI_API_KEY;
  const secret = process.env.SOLAPI_API_SECRET;
  if (!key || !secret) throw new Error('SOLAPI_API_KEY / SOLAPI_API_SECRET 환경변수가 없습니다.');
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(16).toString('hex');
  const signature = crypto.createHmac('sha256', secret).update(date + salt).digest('hex');
  return `HMAC-SHA256 apiKey=${key}, date=${date}, salt=${salt}, signature=${signature}`;
}

async function sendSolapi({ from, items }) {
  const res = await fetch('https://api.solapi.com/messages/v4/send-many/detail', {
    method: 'POST',
    headers: { Authorization: solapiAuth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: items.map((m) => ({ to: m.to, from, text: m.text, type: m.type })),
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`솔라피 오류(${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
  const failed = {};
  for (const f of json.failedMessageList || []) {
    failed[f.to] = f.statusMessage || f.statusCode || '발송 실패';
  }
  return { groupId: json.groupInfo?._id || json.groupId || null, failed };
}

async function send(provider, args) {
  if (provider === 'solapi') return sendSolapi(args);
  return sendConsole(args);
}

module.exports = { send };
