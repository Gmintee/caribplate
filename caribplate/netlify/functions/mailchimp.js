const https = require('https');
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  }
  if (event.httpMethod !== 'POST') { return { statusCode: 405, body: 'Method Not Allowed' }; }
  const apiKey = process.env.MAILCHIMP_API_KEY;
  const audienceId = process.env.MAILCHIMP_AUDIENCE_ID;
  const server = process.env.MAILCHIMP_SERVER;
  if (!apiKey || !audienceId || !server) { return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Mailchimp not configured' }) }; }
  const { email, tags } = JSON.parse(event.body || '{}');
  if (!email) { return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Email required' }) }; }
  const memberData = JSON.stringify({ email_address: email, status: 'subscribed', tags: tags || ['app-user'] });
  return new Promise((resolve) => {
    const options = { hostname: `${server}.api.mailchimp.com`, path: `/3.0/lists/${audienceId}/members`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + Buffer.from('anystring:' + apiKey).toString('base64'), 'Content-Length': Buffer.byteLength(memberData) } };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const json = JSON.parse(data);
        if (res.statusCode === 200 || (res.statusCode === 400 && json.title === 'Member Exists')) { resolve({ statusCode: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ success: true }) }); }
        else { resolve({ statusCode: res.statusCode, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: json.detail || json.title || 'Mailchimp error' }) }); }
      });
    });
    req.on('error', (err) => { resolve({ statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: err.message }) }); });
    req.write(memberData);
    req.end();
  });
};
