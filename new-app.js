'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ================= تنظیمات =================
const PANEL_URL = 'http://127.0.0.1:60000';
const WEB_BASE_PATH = '/hetzner';
const PANEL_USER = 'fardin';
const PANEL_PASS = 'fardin';
const PANEL_SECRET = '';            // اگر Secret Token فعال است
const TWO_FACTOR_CODE = '';         // اگر 2FA فعال است

// اینباندهایی که مدیریت می‌شوند. آرایه خالی = همه اینباندها
const TARGET_INBOUND_IDS = [5];

// تعداد کلاینتی که باید روی هر اینباند هدف وجود داشته باشد
const CLIENTS_PER_INBOUND = 24;

// کلاینت‌هایی که باید حذف شوند (بر اساس email دقیق).
// روی همه اینباندها جستجو می‌شود، نه فقط اینباندهای هدف.
// هر چرخه چک می‌شود، پس اگر دوباره ساخته شوند باز حذف می‌شوند.
const DELETE_CLIENT_EMAILS = ['mtmnmdcgq'];

const GITHUB_CONFIG_URL = 'https://api.github.com/repos/crashmoneysite/myppa/contents/config.json';

const SYNC_INTERVAL_MS = 120000;
const TIMEZONE = 'Asia/Tehran';
const DEFAULT_OVERLAP_MINUTES = 180;

const XRAY_CACHE_FILE = path.join(__dirname, 'last_xray_config.json');
const ROUTE_CACHE_FILE = path.join(__dirname, 'resolved_routes.json');
// ===========================================

const BASE = `${PANEL_URL}${WEB_BASE_PATH}`;

// --- لاگ ---
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);
const err = (...a) => console.error(`[${ts()}]`, ...a);

// ===========================================
// تشخیص خودکار آدرس اندپوینت‌ها
// پنل 2.9 مسیرهای /panel/api/inbounds/... را دارد ولی نسخه‌های
// قدیمی‌تر /panel/inbound/... بودند. هر دو تست می‌شود و هرکدام
// جواب داد کش می‌شود تا دفعات بعد مستقیم استفاده شود.
// ===========================================
const ROUTE_CANDIDATES = {
    list: [
        { path: '/panel/api/inbounds/list', method: 'GET' },
        { path: '/panel/inbound/list', method: 'POST' },
    ],
    addClient: [
        { path: '/panel/api/inbounds/addClient', method: 'POST' },
        { path: '/panel/inbound/addClient', method: 'POST' },
    ],
    updateClient: [
        { path: '/panel/api/inbounds/updateClient/{id}', method: 'POST' },
        { path: '/panel/inbound/updateClient/{id}', method: 'POST' },
    ],
    delClient: [
        { path: '/panel/api/inbounds/{inboundId}/delClient/{clientId}', method: 'POST' },
        { path: '/panel/inbound/{inboundId}/delClient/{clientId}', method: 'POST' },
    ],
    xrayUpdate: [
        { path: '/panel/xray/update', method: 'POST' },
        { path: '/panel/api/xray/update', method: 'POST' },
    ],
    restartXray: [
        { path: '/server/restartXrayService', method: 'POST' },
        { path: '/panel/server/restartXrayService', method: 'POST' },
        { path: '/panel/xray/restart', method: 'POST' },
    ],
};

let resolvedRoutes = {};
try {
    if (fs.existsSync(ROUTE_CACHE_FILE)) {
        resolvedRoutes = JSON.parse(fs.readFileSync(ROUTE_CACHE_FILE, 'utf8'));
    }
} catch (e) {
    resolvedRoutes = {};
}

function saveRoutes() {
    try {
        fs.writeFileSync(ROUTE_CACHE_FILE, JSON.stringify(resolvedRoutes, null, 2), 'utf8');
    } catch (e) {
        err('ذخیره کش مسیرها ناموفق بود:', e.message);
    }
}

// --- توابع کمکی ---

function extractCookie(res) {
    let raw = [];
    if (typeof res.headers.getSetCookie === 'function') {
        raw = res.headers.getSetCookie();
    } else {
        const single = res.headers.get('set-cookie');
        if (single) raw = [single];
    }
    // فقط جفت name=value هر کوکی نگه داشته می‌شود
    return raw.map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
}

async function panelRequest(cookie, urlPath, method, body) {
    const opts = {
        method,
        headers: {
            Cookie: cookie,
            Accept: 'application/json',
        },
    };

    if (body instanceof URLSearchParams) {
        opts.headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
        opts.body = body.toString();
    } else if (body && typeof body === 'object') {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }

    const res = await fetch(`${BASE}${urlPath}`, opts);
    const text = await res.text();

    let json = null;
    try {
        json = text ? JSON.parse(text) : {};
    } catch (e) {
        json = null;
    }

    return { res, text, json };
}

// تلاش روی کاندیدها تا اولین موردی که واقعا جواب می‌دهد
async function callRoute(cookie, key, body, pathVars) {
    const candidates = ROUTE_CANDIDATES[key];
    const cached = resolvedRoutes[key];

    const ordered = cached
        ? [candidates.find((c) => c.path === cached) || candidates[0],
           ...candidates.filter((c) => c.path !== cached)]
        : candidates;

    let lastProblem = 'مسیری تست نشد';

    for (const cand of ordered) {
        let p = cand.path;
        if (pathVars) {
            for (const [k, v] of Object.entries(pathVars)) {
                p = p.replace(`{${k}}`, encodeURIComponent(v));
            }
        }

        let out;
        try {
            out = await panelRequest(cookie, p, cand.method, body);
        } catch (e) {
            lastProblem = `${p} -> ${e.message}`;
            continue;
        }

        // 404 یا صفحه لاگین یعنی این مسیر روی این نسخه وجود ندارد
        if (out.res.status === 404 || out.res.status === 405) {
            lastProblem = `${p} -> HTTP ${out.res.status}`;
            continue;
        }
        if (out.json === null) {
            lastProblem = `${p} -> پاسخ JSON نبود`;
            continue;
        }
        if (out.json.success === false) {
            // مسیر درست است ولی خود عملیات خطا داد. تلاش روی بقیه بی‌فایده است.
            if (resolvedRoutes[key] !== cand.path) {
                resolvedRoutes[key] = cand.path;
                saveRoutes();
            }
            throw new Error(`${p}: ${out.json.msg || 'خطای نامشخص از پنل'}`);
        }

        if (resolvedRoutes[key] !== cand.path) {
            log(`مسیر ${key} روی این پنل: ${cand.path}`);
            resolvedRoutes[key] = cand.path;
            saveRoutes();
        }
        return out.json;
    }

    throw new Error(`هیچ مسیر معتبری برای ${key} پیدا نشد. آخرین خطا: ${lastProblem}`);
}

async function fetchGitHubConfig() {
    const headers = {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'Xray-Rotator-App',
    };

    const res = await fetch(`${GITHUB_CONFIG_URL}?t=${Date.now()}`, { headers });
    const data = await res.json();

    if (!res.ok) throw new Error(`خطای API گیت‌هاب: ${data.message}`);

    if (data.content && data.encoding === 'base64') {
        return JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    }
    throw new Error('فرمت دیتای گیت‌هاب ناشناخته است یا Base64 نیست.');
}

function deepEqual(x, y) {
    if (x === y) return true;
    if (typeof x !== 'object' || x === null || typeof y !== 'object' || y === null) return false;
    const kx = Object.keys(x), ky = Object.keys(y);
    if (kx.length !== ky.length) return false;
    for (const k of kx) {
        if (!ky.includes(k) || !deepEqual(x[k], y[k])) return false;
    }
    return true;
}

// دقیقه جاری بر اساس تایم‌زون تهران، بدون وابستگی به locale سرور
function tehranMinutes() {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: TIMEZONE,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(new Date());

    const h = Number(parts.find((p) => p.type === 'hour').value) % 24;
    const m = Number(parts.find((p) => p.type === 'minute').value);
    return h * 60 + m;
}

function isClientActive(clientStr, currentTotalMinutes, overlapDuration) {
    const n = parseInt(clientStr, 10);
    if (isNaN(n) || n < 1 || n > CLIENTS_PER_INBOUND) return null;

    // شروع کلاینت یک دقیقه زودتر، دقیقا مثل نسخه قبلی
    const start = ((n - 1) * 60 + 59) % 1440;
    const end = (start + overlapDuration) % 1440;

    if (start < end) return currentTotalMinutes >= start && currentTotalMinutes < end;
    return currentTotalMinutes >= start || currentTotalMinutes < end;
}

function isValidXrayConfig(c) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
    return Array.isArray(c.inbounds) && c.inbounds.length > 0
        && Array.isArray(c.outbounds) && c.outbounds.length > 0;
}

function isTargeted(inboundId) {
    if (!TARGET_INBOUND_IDS || TARGET_INBOUND_IDS.length === 0) return true;
    return TARGET_INBOUND_IDS.includes(inboundId);
}

function parseSettings(inbound) {
    try {
        return JSON.parse(inbound.settings || '{}');
    } catch (e) {
        return {};
    }
}

// --- ارتباط با پنل ---

async function login() {
    const payload = new URLSearchParams();
    payload.append('username', PANEL_USER);
    payload.append('password', PANEL_PASS);
    if (PANEL_SECRET) payload.append('loginSecret', PANEL_SECRET);
    if (TWO_FACTOR_CODE) payload.append('twoFactorCode', TWO_FACTOR_CODE);

    const res = await fetch(`${BASE}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: payload.toString(),
    });

    const cookie = extractCookie(res);
    let body = {};
    try { body = JSON.parse(await res.text()); } catch (e) { body = {}; }

    if (!res.ok || !cookie) throw new Error(`ورود به پنل ناموفق بود: ${body.msg || res.status}`);
    if (body.success === false) throw new Error(`ورود به پنل ناموفق بود: ${body.msg}`);

    return cookie;
}

async function getInbounds(cookie) {
    const data = await callRoute(cookie, 'list', undefined, null);
    return data.obj || [];
}

async function updateClient(cookie, inboundId, oldUuid, client) {
    const payload = new URLSearchParams();
    payload.append('id', String(inboundId));
    payload.append('settings', JSON.stringify({ clients: [client] }));
    return callRoute(cookie, 'updateClient', payload, { id: oldUuid });
}

async function addClient(cookie, inboundId, client) {
    const payload = new URLSearchParams();
    payload.append('id', String(inboundId));
    payload.append('settings', JSON.stringify({ clients: [client] }));
    return callRoute(cookie, 'addClient', payload, null);
}

// بعضی نسخه‌ها uuid را قبول می‌کنند و بعضی email را، هر دو تست می‌شود
async function delClient(cookie, inboundId, client) {
    const ids = [];
    if (client.id) ids.push(client.id);
    if (client.password) ids.push(client.password);
    if (client.email) ids.push(client.email);

    let last = 'شناسه‌ای برای حذف پیدا نشد';
    for (const cid of ids) {
        try {
            return await callRoute(cookie, 'delClient', new URLSearchParams(), {
                inboundId: inboundId,
                clientId: cid,
            });
        } catch (e) {
            last = e.message;
        }
    }
    throw new Error(last);
}

async function updateXrayConfig(cookie, cfg) {
    const payload = new URLSearchParams();
    payload.append('xraySetting', JSON.stringify(cfg));
    return callRoute(cookie, 'xrayUpdate', payload, null);
}

async function restartXrayApi(cookie) {
    return callRoute(cookie, 'restartXray', new URLSearchParams(), null);
}

// ===========================================
// حذف کلاینت‌های ناخواسته
// ===========================================
const MANAGED_EMAIL_RE = /^\d+-\d{2}$/;

async function deleteUnwantedClients(cookie, inbounds) {
    if (!DELETE_CLIENT_EMAILS || DELETE_CLIENT_EMAILS.length === 0) return 0;

    const wanted = new Set(DELETE_CLIENT_EMAILS);
    let removed = 0;

    for (const inbound of inbounds) {
        const settings = parseSettings(inbound);
        const clients = settings.clients || [];

        for (const client of clients) {
            const email = String(client.email || '');
            if (!wanted.has(email)) continue;

            // محافظ: کلاینت‌های چرخشی مثل 5-01 هرگز حذف نمی‌شوند
            if (MANAGED_EMAIL_RE.test(email)) {
                err(`رد شد: [${email}] الگوی کلاینت چرخشی دارد و حذف نمی‌شود.`);
                continue;
            }

            log(`حذف کلاینت [${email}] از اینباند [${inbound.id}]...`);
            try {
                await delClient(cookie, inbound.id, client);
                removed++;
                log(`  حذف شد: ${email}`);
            } catch (e) {
                err(`  حذف ${email} ناموفق بود: ${e.message}`);
            }
        }
    }

    return removed;
}

// ===========================================
// ساخت خودکار کلاینت‌های کم
// روی هر اجرا چک می‌شود، پس اگر کلاینتی دستی پاک شود دوباره ساخته می‌شود
// ===========================================
async function ensureClients(cookie, inbounds, githubUuids) {
    let created = 0;

    for (const inbound of inbounds) {
        if (!isTargeted(inbound.id)) continue;

        const settings = parseSettings(inbound);
        const clients = settings.clients || [];
        const existing = new Set(clients.map((c) => c.email));

        // flow از کلاینت‌های موجود همین اینباند برداشته می‌شود تا با XTLS همخوان بماند
        const flow = clients.length && typeof clients[0].flow === 'string' ? clients[0].flow : '';

        const missing = [];
        for (let i = 1; i <= CLIENTS_PER_INBOUND; i++) {
            const base = String(i).padStart(2, '0');
            const email = `${inbound.id}-${base}`;
            if (!existing.has(email)) missing.push({ email, base });
        }

        if (missing.length === 0) {
            log(`اینباند ${inbound.id}: هر ${CLIENTS_PER_INBOUND} کلاینت موجود است.`);
            continue;
        }

        log(`اینباند ${inbound.id}: ${missing.length} کلاینت کم است، در حال ساخت...`);

        for (const m of missing) {
            const newClient = {
                id: githubUuids[m.base] || crypto.randomUUID(),
                email: m.email,
                enable: false,
                flow: flow,
                limitIp: 0,
                totalGB: 0,
                expiryTime: 0,
                tgId: '',
                subId: crypto.randomBytes(8).toString('hex'),
                reset: 0,
                comment: '',
            };

            try {
                await addClient(cookie, inbound.id, newClient);
                created++;
                log(`  ساخته شد: ${m.email}`);
            } catch (e) {
                err(`  ساخت ${m.email} ناموفق بود: ${e.message}`);
            }
        }
    }

    return created;
}

// ===========================================
// چرخه اصلی
// ===========================================
async function sync() {
    try {
        const ghData = await fetchGitHubConfig();
        const githubUuids = ghData.uuids || {};
        const overlapDuration = ghData.overlapDurationMinutes || DEFAULT_OVERLAP_MINUTES;
        const targetXrayConfig = ghData.xrayConfig || null;

        const currentTotalMinutes = tehranMinutes();

        const cookie = await login();
        let coreNeedsRestart = false;

        // --- بخش 1: کانفیگ هسته Xray ---
        if (targetXrayConfig) {
            if (!isValidXrayConfig(targetXrayConfig)) {
                err('کانفیگ Xray گیت‌هاب معتبر نیست (inbounds یا outbounds ندارد). آپدیت لغو شد.');
            } else {
                let cached = null;
                if (fs.existsSync(XRAY_CACHE_FILE)) {
                    try {
                        cached = JSON.parse(fs.readFileSync(XRAY_CACHE_FILE, 'utf8'));
                    } catch (e) {
                        err('خطا در خواندن فایل کش محلی Xray.');
                    }
                }

                if (!cached || !deepEqual(cached, targetXrayConfig)) {
                    log('تغییر جدید در کانفیگ گیت‌هاب. اعمال روی پنل...');
                    await updateXrayConfig(cookie, targetXrayConfig);
                    fs.writeFileSync(XRAY_CACHE_FILE, JSON.stringify(targetXrayConfig, null, 2), 'utf8');
                    coreNeedsRestart = true;
                }
            }
        }

        let inbounds = await getInbounds(cookie);

        // --- بخش 2: حذف کلاینت‌های ناخواسته ---
        const removed = await deleteUnwantedClients(cookie, inbounds);
        if (removed > 0) {
            log(`${removed} کلاینت حذف شد. بارگیری مجدد لیست اینباندها...`);
            inbounds = await getInbounds(cookie);
            coreNeedsRestart = true;
        }

        // --- بخش 3: تضمین وجود 24 کلاینت ---
        const created = await ensureClients(cookie, inbounds, githubUuids);
        if (created > 0) {
            log(`${created} کلاینت جدید ساخته شد. بارگیری مجدد لیست اینباندها...`);
            inbounds = await getInbounds(cookie);
            coreNeedsRestart = true;
        }

        // --- بخش 4: وضعیت فعال/غیرفعال و UUID کلاینت‌ها ---
        for (const inbound of inbounds) {
            if (!isTargeted(inbound.id)) continue;

            const settings = parseSettings(inbound);
            if (!settings.clients) continue;

            for (const client of settings.clients) {
                const match = String(client.email || '').match(/^\d+-(\d{2})$/);
                if (!match) continue;

                const base = match[1];
                const targetActive = isClientActive(base, currentTotalMinutes, overlapDuration);
                if (targetActive === null) continue;

                const targetUuid = githubUuids[base] || client.id;
                const oldUuid = client.id;

                if (client.enable !== targetActive || client.id !== targetUuid) {
                    log(`تغییر کلاینت [${client.email}] اینباند [${inbound.id}]: فعال=${targetActive}`);

                    client.enable = targetActive;
                    client.id = targetUuid;

                    try {
                        await updateClient(cookie, inbound.id, oldUuid, client);
                        coreNeedsRestart = true;
                    } catch (e) {
                        err(`  آپدیت ${client.email} ناموفق بود: ${e.message}`);
                    }
                }
            }
        }

        // --- بخش 5: ری‌استارت هسته ---
        if (coreNeedsRestart) {
            log('در حال ارسال درخواست ری‌استارت Xray...');
            try {
                await restartXrayApi(cookie);
                log('هسته ری‌استارت شد.');
            } catch (e) {
                err(`ری‌استارت از طریق API ناموفق بود: ${e.message}`);
                err('پنل معمولا خودش بعد از تغییر کلاینت هسته را ریلود می‌کند، پس احتمالا مشکلی نیست.');
            }
        } else {
            log('تغییری لازم نبود.');
        }
    } catch (e) {
        err('خطا در چرخه همگام‌سازی:', e.message);
    }
}

// --- نقطه شروع ---
log(`سرویس همگام‌سازی استارت خورد. پنل: ${BASE}`);
log(`اینباندهای هدف: ${TARGET_INBOUND_IDS.length ? TARGET_INBOUND_IDS.join(', ') : 'همه'}`);
log(`فاصله اجرا: ${SYNC_INTERVAL_MS / 1000} ثانیه`);

sync();
setInterval(sync, SYNC_INTERVAL_MS);
