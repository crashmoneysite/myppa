const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ================= تنظیمات =================
const PANEL_URL = 'http://127.0.0.1:60000'; 
const WEB_BASE_PATH = '/hetzner'; 
const PANEL_USER = 'fardin'; 
const PANEL_PASS = 'fardin'; 

// آدرس API گیت‌هاب (بدون نیاز به توکن برای اجرای ۲ دقیقه‌ای)
const GITHUB_CONFIG_URL = 'https://api.github.com/repos/crashmoneysite/myppa/contents/config.json';

// زمان اجرای اینتروال: ۱۲۰۰۰۰ میلی‌ثانیه (۲ دقیقه)
const SYNC_INTERVAL_MS = 120000; 

// مسیر فایل کش محلی روی سرور برای ردیابی آخرین وضعیت کانفیگ هسته
const XRAY_CACHE_FILE = path.join(__dirname, 'last_xray_config.json');
// ===========================================

// --- توابع کمکی ---

async function safeFetchJson(url, options) {
    const res = await fetch(url, options);
    const text = await res.text();
    try {
        const json = text ? JSON.parse(text) : {};
        if (json.success === false) {
            throw new Error(json.msg || 'خطای نامشخص از سمت پنل');
        }
        return json;
    } catch (err) {
        throw new Error(`مشکل در پردازش درخواست: ${url}\nدلیل: ${err.message}\nمحتوای دریافتی: ${text.substring(0, 100)}`);
    }
}

// دریافت و رمزگشایی دیتای Base64 از API رسمی گیت‌هاب
async function fetchGitHubConfig() {
    const headers = {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Xray-Rotator-App'
    };

    const res = await fetch(`${GITHUB_CONFIG_URL}?t=${Date.now()}`, { headers });
    const data = await res.json();

    if (!res.ok) {
        throw new Error(`خطای API گیت‌هاب: ${data.message}`);
    }

    if (data.content && data.encoding === 'base64') {
        // تبدیل دیتای Base64 به متن UTF-8 و سپس پارس کردن آن به عنوان JSON
        const decodedContent = Buffer.from(data.content, 'base64').toString('utf8');
        return JSON.parse(decodedContent);
    }
    
    throw new Error('فرمت دیتای گیت‌هاب ناشناخته است یا Base64 نیست.');
}

function deepEqual(x, y) {
    if (x === y) return true;
    if (typeof x !== 'object' || x === null || typeof y !== 'object' || y === null) return false;
    const keysX = Object.keys(x), keysY = Object.keys(y);
    if (keysX.length !== keysY.length) return false;
    for (const key of keysX) {
        if (!keysY.includes(key) || !deepEqual(x[key], y[key])) return false;
    }
    return true;
}

function isClientActive(clientStr, currentTotalMinutes, overlapDuration) {
    const clientNum = parseInt(clientStr, 10);
    if (isNaN(clientNum) || clientNum < 1 || clientNum > 24) return null;

    // شروع کلاینت ۱ دقیقه زودتر (دقیقه ۵۹ ساعت قبل)
    const startMinutes = ((clientNum - 1) * 60 + 59) % 1440;
    const endMinutes = (startMinutes + overlapDuration) % 1440; 

    if (startMinutes < endMinutes) {
        return currentTotalMinutes >= startMinutes && currentTotalMinutes < endMinutes;
    } else {
        return currentTotalMinutes >= startMinutes || currentTotalMinutes < endMinutes;
    }
}

function isValidXrayConfig(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
    const hasInbounds = Array.isArray(config.inbounds) && config.inbounds.length > 0;
    const hasOutbounds = Array.isArray(config.outbounds) && config.outbounds.length > 0;
    return hasInbounds && hasOutbounds;
}

// --- توابع ارتباط با API پنل ---

async function login() {
    const payload = new URLSearchParams();
    payload.append('username', PANEL_USER);
    payload.append('password', PANEL_PASS);

    const res = await fetch(`${PANEL_URL}${WEB_BASE_PATH}/login`, { method: 'POST', body: payload });
    const cookie = res.headers.get('set-cookie');
    if (!res.ok || !cookie) throw new Error('ورود به پنل ناموفق بود.');
    return cookie;
}

async function getInbounds(cookie) {
    const data = await safeFetchJson(`${PANEL_URL}${WEB_BASE_PATH}/panel/api/inbounds/list`, { 
        method: 'GET',
        headers: { 'Cookie': cookie } 
    });
    return data.obj;
}

async function updateClient(cookie, inboundId, oldUuid, newClientSettings) {
    const payload = new URLSearchParams();
    payload.append('id', inboundId);
    payload.append('settings', JSON.stringify({ clients: [newClientSettings] }));

    await safeFetchJson(`${PANEL_URL}${WEB_BASE_PATH}/panel/inbound/updateClient/${oldUuid}`, {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 
            'Cookie': cookie 
        },
        body: payload.toString()
    });
}

async function addClient(cookie, inboundId, newClientSettings) {
    const payload = new URLSearchParams();
    payload.append('id', inboundId);
    payload.append('settings', JSON.stringify({ clients: [newClientSettings] }));

    await safeFetchJson(`${PANEL_URL}${WEB_BASE_PATH}/panel/inbound/addClient`, {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 
            'Cookie': cookie 
        },
        body: payload.toString()
    });
}

async function updateXrayConfig(cookie, targetXrayConfig) {
    const payload = new URLSearchParams();
    payload.append('xraySetting', JSON.stringify(targetXrayConfig));

    await safeFetchJson(`${PANEL_URL}${WEB_BASE_PATH}/panel/xray/update`, {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 
            'Cookie': cookie 
        },
        body: payload.toString()
    });
}

async function restartXrayApi(cookie) {
    await safeFetchJson(`${PANEL_URL}${WEB_BASE_PATH}/server/restartXrayService`, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Cookie': cookie }
    });
}

// --- توابع اصلی اسکریپت ---

async function sync() {
    try {
        const ghData = await fetchGitHubConfig();
        const githubUuids = ghData.uuids || {};
        const overlapDuration = ghData.overlapDurationMinutes || 180;
        const targetXrayConfig = ghData.xrayConfig || null;

        // محاسبه زمان بر اساس تایم‌زون تهران
        const now = new Date();
        const tehranTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tehran" }));
        const currentTotalMinutes = tehranTime.getHours() * 60 + tehranTime.getMinutes();

        const cookie = await login();
        let coreNeedsRestart = false;

        // --- بخش 1: مدیریت تنظیمات Xray با ساختار فایل مرجع محلی ---
        if (targetXrayConfig) {
            if (!isValidXrayConfig(targetXrayConfig)) {
                console.error('⚠️ کانفیگ Xray گیت‌هاب معتبر نیست (فاقد inbounds یا outbounds معتبر است). آپدیت کانفیگ لغو شد.');
            } else {
                let localCachedConfig = null;

                if (fs.existsSync(XRAY_CACHE_FILE)) {
                    try {
                        localCachedConfig = JSON.parse(fs.readFileSync(XRAY_CACHE_FILE, 'utf8'));
                    } catch (e) {
                        console.error('خطا در خواندن فایل کش محلی Xray.');
                    }
                }

                if (!localCachedConfig || !deepEqual(localCachedConfig, targetXrayConfig)) {
                    console.log(`> تغییر جدید در کانفیگ گیت‌هاب ثبت شده است. اعمال روی پنل و بروزرسانی فایل محلی...`);
                    
                    await updateXrayConfig(cookie, targetXrayConfig);
                    fs.writeFileSync(XRAY_CACHE_FILE, JSON.stringify(targetXrayConfig, null, 2), 'utf8');
                    coreNeedsRestart = true;
                }
            }
        }

        // --- بخش 2: مدیریت وضعیت فعال/غیرفعال کلاینت‌ها ---
        const inbounds = await getInbounds(cookie);
        for (const inbound of inbounds) {
            const settings = JSON.parse(inbound.settings);
            if (!settings.clients) continue;

            for (const client of settings.clients) {
                const match = client.email.match(/^\d+-(\d{2})$/);
                if (!match) continue; 
                
                const baseClientName = match[1];
                const targetActiveState = isClientActive(baseClientName, currentTotalMinutes, overlapDuration);
                if (targetActiveState === null) continue;

                const targetUuid = githubUuids[baseClientName] || client.id;
                const oldUuid = client.id; 
                
                if (client.enable !== targetActiveState || client.id !== targetUuid) {
                    console.log(`> تغییر کلاینت [${client.email}] اینباند [${inbound.id}]: وضعیت=${targetActiveState}`);
                    
                    client.enable = targetActiveState;
                    client.id = targetUuid;

                    await updateClient(cookie, inbound.id, oldUuid, client);
                    coreNeedsRestart = true;
                }
            }
        }

        // --- بخش 3: ری‌استارت هسته در صورت لزوم ---
        if (coreNeedsRestart) {
            console.log('تغییرات با موفقیت اعمال شد. در حال ارسال درخواست ری‌استارت Xray به API...');
            await restartXrayApi(cookie);
            console.log('هسته با موفقیت از طریق API پنل ری‌استارت شد.');
        }

    } catch (err) {
        console.error('خطا در اجرای چرخه همگام‌سازی:', err.message);
    }
}

async function initialize() {
    try {
        console.log(`[${new Date().toISOString()}] در حال ساخت کلاینت‌های اولیه...`);
        
        const ghData = await fetchGitHubConfig();
        const githubUuids = ghData.uuids || {};

        const cookie = await login();
        const inbounds = await getInbounds(cookie);
        let coreNeedsRestart = false;

        for (const inbound of inbounds) {
            const settings = JSON.parse(inbound.settings);
            const existingEmails = (settings.clients || []).map(c => c.email);
            
            for (let i = 1; i <= 24; i++) {
                const baseName = i.toString().padStart(2, '0');
                const clientEmail = `${inbound.id}-${baseName}`;
                
                if (!existingEmails.includes(clientEmail)) {
                    console.log(`> ساخت کلاینت [${clientEmail}] اینباند [${inbound.id}]...`);
                    
                    const newClient = {
                        id: githubUuids[baseName] || crypto.randomUUID(), 
                        email: clientEmail, 
                        enable: false,
                        flow: "",
                        limitIp: 0, 
                        totalGB: 0,
                        expiryTime: 0,
                        tgId: "",
                        subId: crypto.randomBytes(8).toString('hex')
                    };

                    await addClient(cookie, inbound.id, newClient);
                    coreNeedsRestart = true;
                }
            }
        }
        
        if (coreNeedsRestart) {
            console.log('کلاینت‌های جدید با موفقیت اضافه شدند. در حال ری‌استارت Xray...');
            await restartXrayApi(cookie);
            console.log('هسته با موفقیت از طریق API ری‌استارت شد.');
        } else {
            console.log('تمام ۲۴ کلاینت در تمامی اینباندها از قبل موجود بودند.');
        }

    } catch (err) {
        console.error('خطا در عملیات Initialize:', err.message);
    }
}

// --- نقطه شروع برنامه ---
const runMode = process.argv[2];
if (runMode === 'initialize') {
    initialize();
} else {
    console.log(`[${new Date().toISOString()}] سرویس همگام‌سازی داینامیک استارت خورد...`);
    sync();
    setInterval(sync, SYNC_INTERVAL_MS);
}
