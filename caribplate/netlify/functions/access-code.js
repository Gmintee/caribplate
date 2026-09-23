const https = require('https');

// Small helper that performs one HTTPS request and resolves with the raw body.
function makeRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// Influencer access codes. Uses the SAME Supabase connection (SUPABASE_URL +
// SUPABASE_ANON_KEY) as save-plan.js. Two actions:
//   action: "check"  -> is this code valid and unused? (does NOT consume it)
//   action: "redeem" -> mark the code used, once, after the plan has generated
// Splitting check from redeem means a failed/timed-out generation never burns
// a code: it is only consumed on a confirmed success.
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch (e) { payload = {}; }

  const action = (payload.action || '').toLowerCase();
  const code = (payload.code || '').trim().toUpperCase();
  const email = (payload.email || '').trim();

  if (!code) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Code required' }) };
  }

  const authHeaders = {
    'apikey': supabaseKey,
    'Authorization': 'Bearer ' + supabaseKey
  };

  try {
    // ── CHECK: look the code up, report whether it can be used ──
    if (action === 'check') {
      const q = new URL(supabaseUrl + '/rest/v1/access_codes');
      q.searchParams.set('code', 'eq.' + code);
      q.searchParams.set('select', 'code,used');

      const res = await makeRequest({
        hostname: q.hostname,
        path: q.pathname + q.search,
        method: 'GET',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders)
      });

      let rows = [];
      try { rows = JSON.parse(res.body); } catch (e) { rows = []; }

      if (!Array.isArray(rows) || rows.length === 0) {
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ valid: false, reason: 'not_found' }) };
      }
      if (rows[0].used) {
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ valid: false, reason: 'used' }) };
      }
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ valid: true }) };
    }

    // ── REDEEM: consume the code, but only if it is still unused ──
    if (action === 'redeem') {
      // The `used=eq.false` filter makes this a conditional update: if two people
      // somehow race the same code, only the first PATCH matches a row.
      const q = new URL(supabaseUrl + '/rest/v1/access_codes');
      q.searchParams.set('code', 'eq.' + code);
      q.searchParams.set('used', 'eq.false');

      const updateBody = JSON.stringify({
        used: true,
        used_by_email: email || null,
        used_at: new Date().toISOString()
      });

      const res = await makeRequest({
        hostname: q.hostname,
        path: q.pathname + q.search,
        method: 'PATCH',
        headers: Object.assign({
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
          'Content-Length': Buffer.byteLength(updateBody)
        }, authHeaders)
      }, updateBody);

      let rows = [];
      try { rows = JSON.parse(res.body); } catch (e) { rows = []; }

      if (Array.isArray(rows) && rows.length > 0) {
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
      }
      // Nothing updated: already used or code missing. The plan still generated,
      // so this is not surfaced to the visitor.
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: false, reason: 'already_used_or_missing' }) };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
