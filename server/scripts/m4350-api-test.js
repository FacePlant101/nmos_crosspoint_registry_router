'use strict';

// Simple M4350 API auth and endpoint test script
// Usage:
//   node scripts/m4350-api-test.js --host 10.10.230.1 --user admin --pass 'password' [--port 8443] [--scheme https|http]
//   Environment variables also supported: M4350_HOST, M4350_USER, M4350_PASS, M4350_PORT, M4350_SCHEME

const { fetch, Agent, setGlobalDispatcher } = require('undici');

// Allow self-signed certs on the switch API
const agent = new Agent({
  connect: { rejectUnauthorized: false }
});
setGlobalDispatcher(agent);

function parseArgs() {
  const args = { host: process.env.M4350_HOST, user: process.env.M4350_USER, pass: process.env.M4350_PASS, port: process.env.M4350_PORT || '8443', cookie: process.env.M4350_COOKIE, scheme: process.env.M4350_SCHEME };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (!val) continue;
    switch (key) {
      case '--host': args.host = val; i++; break;
      case '--user': args.user = val; i++; break;
      case '--pass': args.pass = val; i++; break;
      case '--port': args.port = val; i++; break;
      case '--cookie': args.cookie = val; i++; break;
      case '--scheme': args.scheme = val; i++; break;
      default: break;
    }
  }
  // Default scheme based on port if not explicitly set
  if (!args.scheme) args.scheme = (String(args.port) === '80') ? 'http' : 'https';
  args.scheme = String(args.scheme).toLowerCase();
  if (!args.host || !args.user || !args.pass) {
    console.error('Missing required args. Example: node scripts/m4350-api-test.js --host 10.10.230.1 --user admin --pass "secret" [--port 8443] [--scheme https|http]');
    process.exit(2);
  }
  return args;
}

function baseUrl(args) {
  return `${args.scheme}://${args.host}:${args.port}/api/v1`;
}

function altBaseUrls(args) {
  return [
    `${args.scheme}://${args.host}:${args.port}/api/v1`,
    `${args.scheme}://${args.host}:${args.port}/api`,
    `${args.scheme}://${args.host}:${args.port}`
  ];
}

async function readBodySnippet(resp, max = 500) {
  try {
    const txt = await resp.text();
    return txt.slice(0, max);
  } catch {
    return '';
  }
}

async function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function login(args) {
  const url = baseUrl(args) + '/login';
  const body = {
    login: { username: args.user, password: args.pass }
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const raw = await resp.text();
  if (!resp.ok) {
    console.error(`[login] HTTP ${resp.status}. Body: ${raw.slice(0, 500)}`);
    const www = resp.headers.get('www-authenticate');
    if (www) console.error(`[login] WWW-Authenticate: ${www}`);
    try {
      console.error('[login] Response headers:');
      for (const [k, v] of resp.headers) {
        console.error(`  ${k}: ${v}`);
      }
    } catch {}
    return { ok: false };
  }

  let token = null;
  const data = await tryParseJson(raw);
  if (data) {
    token = data?.token || data?.login?.token || null;
  }
  const setCookie = resp.headers.get('set-cookie');
  let sessionCookie = null;
  if (setCookie) {
    // Grab first cookie pair (name=value)
    const m = setCookie.match(/^([^;]+);/);
    if (m) sessionCookie = m[1];
  }
  try {
    console.log('[login] Response headers:');
    for (const [k, v] of resp.headers) {
      if (k.toLowerCase() === 'set-cookie') {
        // Show presence but avoid dumping cookies in clear text
        console.log('  set-cookie: <present>');
      } else {
        console.log(`  ${k}: ${v}`);
      }
    }
  } catch {}
  console.log(`[login] success. token=${token ? (token.length + ' chars') : 'none'}, cookie=${sessionCookie ? 'present' : 'none'}`);
  return { ok: true, token, sessionCookie };
}

async function getJson(args, path, auth) {
  const url = baseUrl(args) + path;
  const variants = [];
  // Try Bearer first if token present
  if (auth?.token) variants.push({ Authorization: `Bearer ${auth.token}` , __name: 'Authorization: Bearer' });
  // Alternate schemes some firmwares use
  if (auth?.token) variants.push({ Authorization: `Token ${auth.token}`, __name: 'Authorization: Token' });
  if (auth?.token) variants.push({ 'X-Auth-Token': auth.token, __name: 'X-Auth-Token' });
  // Cookie-based session as fallback
  if (auth?.sessionCookie) variants.push({ Cookie: auth.sessionCookie, __name: 'Cookie' });
  // Basic auth variant (observed to work on some firmware)
  if (args.user && args.pass) {
    const basic = Buffer.from(`${args.user}:${args.pass}`).toString('base64');
    variants.push({ Authorization: `Basic ${basic}`, __name: 'Basic' });
  }
  // If nothing available still try without auth to observe behavior
  if (variants.length === 0) variants.push({ __name: 'none' });

  let lastResp = null;
  for (const v of variants) {
    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'curl/8.4.0',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `${args.scheme}://${args.host}:${args.port}/`,
      'Origin': `${args.scheme}://${args.host}:${args.port}`
    };
    for (const [k, val] of Object.entries(v)) {
      if (k === '__name') continue;
      headers[k] = val;
    }
    const resp = await fetch(url, { headers });
    lastResp = resp;
    if (resp.ok) {
      const text = await resp.text();
      const data = await tryParseJson(text);
      if (!data) {
        console.warn(`[GET ${path}] ok via {${v.__name}}. Non-JSON body (first 200): ${text.slice(0, 200)}`);
        return { ok: true, data: null };
      }
      console.log(`[GET ${path}] ok via {${v.__name}}`);
      return { ok: true, data };
    }
    const www = resp.headers.get('www-authenticate');
    const snippet = await readBodySnippet(resp);
    console.error(`[GET ${path}] HTTP ${resp.status} via {${v.__name}}`);
    if (www) console.error(`[GET ${path}] WWW-Authenticate: ${www}`);
    if (snippet) console.error(`[GET ${path}] Body: ${snippet}`);
    try {
      console.error(`[GET ${path}] Response headers via {${v.__name}}:`);
      for (const [k, v2] of resp.headers) {
        console.error(`  ${k}: ${v2}`);
      }
    } catch {}
  }
  // Fallback: try token in query parameter if present
  if (auth?.token) {
    const delim = url.includes('?') ? '&' : '?';
    const urlWithToken = `${url}${delim}token=${encodeURIComponent(auth.token)}`;
    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'curl/8.4.0',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `https://${args.host}:${args.port}/`,
      'Origin': `https://${args.host}:${args.port}`
    };
    const resp = await fetch(urlWithToken, { headers });
    lastResp = resp;
    if (resp.ok) {
      const text = await resp.text();
      const data = await tryParseJson(text);
      if (!data) {
        console.warn(`[GET ${path} + token param] ok. Non-JSON body (first 200): ${text.slice(0, 200)}`);
        return { ok: true, data: null };
      }
      console.log(`[GET ${path}] ok via {query token}`);
      return { ok: true, data };
    }
    const www = resp.headers.get('www-authenticate');
    const snippet = await readBodySnippet(resp);
    console.error(`[GET ${path}] HTTP ${resp.status} via {query token}`);
    if (www) console.error(`[GET ${path}] WWW-Authenticate: ${www}`);
    if (snippet) console.error(`[GET ${path}] Body: ${snippet}`);
    try {
      console.error(`[GET ${path}] Response headers via {query token}:`);
      for (const [k, v2] of resp.headers) {
        console.error(`  ${k}: ${v2}`);
      }
    } catch {}
  }
  return { ok: false, status: lastResp?.status ?? 0 };
}

async function postLogout(args, auth) {
  const url = baseUrl(args) + '/logout';
  const variants = [];
  if (auth?.token) variants.push({ Authorization: `Bearer ${auth.token}` , __name: 'Authorization: Bearer' });
  if (auth?.token) variants.push({ Authorization: `Token ${auth.token}`, __name: 'Authorization: Token' });
  if (auth?.token) variants.push({ 'X-Auth-Token': auth.token, __name: 'X-Auth-Token' });
  if (auth?.sessionCookie) variants.push({ Cookie: auth.sessionCookie, __name: 'Cookie' });
  if (args.user && args.pass) {
    const basic = Buffer.from(`${args.user}:${args.pass}`).toString('base64');
    variants.push({ Authorization: `Basic ${basic}`, __name: 'Basic' });
  }
  if (variants.length === 0) variants.push({ __name: 'none' });
  console.log('[logout] Probing POST /logout with auth variants');
  for (const variant of variants) {
    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'curl/8.4.0',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `https://${args.host}:${args.port}/`,
      'Origin': `https://${args.host}:${args.port}`
    };
    for (const [k, v] of Object.entries(variant)) {
      if (k === '__name') continue;
      headers[k] = v;
    }
    const resp = await fetch(url, { method: 'POST', headers });
    const body = await readBodySnippet(resp);
    if (resp.ok) {
      console.log(`[POST /logout] ok via {${variant.__name}}`);
      return { ok: true };
    }
    console.error(`[POST /logout] HTTP ${resp.status} via {${variant.__name}}`);
    const www = resp.headers.get('www-authenticate');
    if (www) console.error(`[POST /logout] WWW-Authenticate: ${www}`);
    if (body) console.error(`[POST /logout] Body: ${body}`);
  }
  return { ok: false };
}

function summarizeDeviceInfo(obj) {
  const d = obj?.device_info || obj?.deviceInfo || {};
  return {
    model: d.model || '',
    serialNumber: d.serialNumber || '',
    swVer: d.swVer || ''
  };
}

function summarizePortStats(obj) {
  const raw = obj?.switchStatsPort ?? obj?.portStats ?? null;
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === 'object') {
    if ('portId' in raw) list = [raw];
    else list = Object.values(raw);
  }
  return { count: list.length };
}

function summarizeLldp(obj) {
  const raw = obj?.lldp_remote_devices?.lldp_rem_dev_list ?? obj?.lldp_rem_dev_list ?? null;
  let list = [];
  if (Array.isArray(raw)) list = raw; else if (raw) list = [raw];
  return { count: list.length };
}

async function main() {
  const args = parseArgs();
  const auth = await login(args);
  if (!auth.ok) process.exit(1);
  if (args.cookie && !auth.sessionCookie) {
    auth.sessionCookie = args.cookie;
    console.log('[cookie] using provided cookie for Cookie-based session testing');
  }

  // /device_info
  const dev = await getJson(args, '/device_info', auth);
  if (dev.ok) {
    if (dev.data) console.log('[device_info]', summarizeDeviceInfo(dev.data));
    else console.log('[device_info] ok (no JSON)');
  }

  // /sw_portstats?portid=ALL
  const ps = await getJson(args, '/sw_portstats?portid=ALL', auth);
  if (ps.ok) {
    if (ps.data) console.log('[sw_portstats]', summarizePortStats(ps.data));
    else console.log('[sw_portstats] ok (no JSON)');
  }

  // /sw_portstats?portid=1 (alternate for firmwares not accepting ALL)
  const ps1 = await getJson(args, '/sw_portstats?portid=1', auth);
  if (ps1.ok) {
    if (ps1.data) console.log('[sw_portstats?portid=1]', summarizePortStats(ps1.data));
    else console.log('[sw_portstats?portid=1] ok (no JSON)');
  }

  // /lldp_remote_devices
  const lldp = await getJson(args, '/lldp_remote_devices', auth);
  if (lldp.ok) {
    if (lldp.data) console.log('[lldp_remote_devices]', summarizeLldp(lldp.data));
    else console.log('[lldp_remote_devices] ok (no JSON)');
  }

  // Try alternate base paths if primary returned 403s
  const bases = altBaseUrls(args);
  for (const b of bases) {
    if (b === baseUrl(args)) continue; // already tried
    console.log(`-- Trying alternate base: ${b}`);
    const wrap = async (full, auth) => {
      const variants = [];
      if (auth?.token) variants.push({ Authorization: `Bearer ${auth.token}` , __name: 'Authorization: Bearer' });
      if (auth?.token) variants.push({ Authorization: `Token ${auth.token}`, __name: 'Authorization: Token' });
      if (auth?.token) variants.push({ 'X-Auth-Token': auth.token, __name: 'X-Auth-Token' });
      if (auth?.sessionCookie) variants.push({ Cookie: auth.sessionCookie, __name: 'Cookie' });
      if (args.user && args.pass) {
        const basic = Buffer.from(`${args.user}:${args.pass}`).toString('base64');
        variants.push({ Authorization: `Basic ${basic}`, __name: 'Basic' });
      }
      if (variants.length === 0) variants.push({ __name: 'none' });
      for (const v of variants) {
        const headers = {
          'Accept': 'application/json',
          'User-Agent': 'curl/8.4.0',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': `https://${args.host}:${args.port}/`,
          'Origin': `https://${args.host}:${args.port}`
        };
        for (const [k, val] of Object.entries(v)) {
          if (k === '__name') continue;
          headers[k] = val;
        }
        const resp = await fetch(full, { headers });
        if (resp.ok) {
          console.log(`[ALT ${full}] ok via {${v.__name}}`);
          return true;
        }
        const www = resp.headers.get('www-authenticate');
        const snippet = await readBodySnippet(resp);
        console.error(`[ALT ${full}] HTTP ${resp.status} via {${v.__name}}`);
        if (www) console.error(`[ALT ${full}] WWW-Authenticate: ${www}`);
        if (snippet) console.error(`[ALT ${full}] Body: ${snippet}`);
      }
      return false;
    };
    await wrap(`${b}/device_info`, auth);
    await wrap(`${b}/sw_portstats?portid=ALL`, auth);
    await wrap(`${b}/lldp_remote_devices`, auth);
  }

  // Probe logout at the end, so we don't invalidate the token before other tests
  await postLogout(args, auth);
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
