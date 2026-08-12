// Mağaza raporu veri güncelleyici.
// Apple (App Store Connect) + Google Play verisini çeker, 13 Tem 2026 bazıyla
// karşılaştırır ve depo kökündeki data.json'ı yazar. Sayfa data.json'ı fetch eder.
//
// GİZLİ BİLGİ İÇERMEZ — tüm kimlik bilgileri ortam değişkeninden gelir:
//   ASC_ISSUER_ID, ASC_KEY_ID, ASC_P8 (.p8 dosyasının içeriği), ASC_VENDOR,
//   GP_SA_JSON (service account JSON içeriği), GP_BUCKET
// GitHub Actions'ta bunlar Secrets'tan; yerelde rapor-updater/run_local.mjs verir.
// Git commit/push işini çağıran taraf yapar (workflow veya run_local).
import crypto from 'crypto';
import https from 'https';
import fs from 'fs';
import zlib from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const DATA = path.join(REPO, 'data.json');

const need = (n) => {
  const v = process.env[n];
  if (!v) { console.error(`HATA: ${n} ortam değişkeni tanımsız`); process.exit(2); }
  return v;
};
const ISSUER_ID = need('ASC_ISSUER_ID');
const KEY_ID = need('ASC_KEY_ID');
const P8_PEM = need('ASC_P8').replace(/\\n/g, '\n');
const VENDOR = need('ASC_VENDOR');
const GP_SA = JSON.parse(need('GP_SA_JSON'));
const GP_BUCKET = need('GP_BUCKET');

const APPS = {
  'Vocal Tasbeeh - Dhikr Counter': 'vocal',
  'Snoutgram': 'snout',
  'Peacefy - Happy Mind': 'mz',
  'Match Reminder Sports TV Guide': 'mr',
};
const PKGS = { 'com.sesliTesbih.app': 'vocal', 'com.snoutgram.app': 'snout', 'com.mutluzihin.app': 'mz', 'com.machatirlatici.app': 'mr' };

// ---- 13 Temmuz 2026 baz değerleri (Hindistan hariç: tamamı testçi) ----
const BASE = {
  ios: {
    vocal: { TR: 6, FR: 2, US: 2, GB: 2, BR: 2, DE: 1, NL: 1, CA: 1, NO: 1, GH: 1, JO: 1, SA: 1, MY: 1, NG: 1, TZ: 1, AU: 1 },
    snout: { TR: 4, US: 3, GB: 2, FR: 1, UA: 1, CN: 1 },
    mr: { US: 2, TR: 1, NG: 1, BJ: 1, AE: 1, AZ: 1 },
    mz: { TR: 4, JP: 1, UA: 1, US: 1 },
  },
  android: {
    vocal: { TR: 33, AZ: 4, TM: 2, RU: 2, BE: 1, BA: 1 },
    snout: { TR: 5, NG: 3, AU: 2, ID: 2, US: 1, ES: 1, RU: 1 },
    mr: { TR: 3, GR: 1 },
    mz: { TR: 1, VE: 1 },
  },
  androidUninst: { vocal: 33, snout: 13, mr: 2, mz: 1 },
};

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);

function appleJWT() {
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' })).toString('base64url');
  // exp KESİNLİKLE 20 dakikadan küçük olmalı. Tam 1200 (=20 dk) kullanıldığında
  // Apple saat farkı yüzünden sınırı aşmış sayıp 401 NOT_AUTHORIZED veriyor —
  // "anahtar iptal olmuş" sanılan şey buydu. 900 güvenli.
  const p = Buffer.from(JSON.stringify({ iss: ISSUER_ID, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' })).toString('base64url');
  const s = crypto.createSign('SHA256'); s.update(`${h}.${p}`);
  return `${h}.${p}.${s.sign({ key: P8_PEM, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

function get(hostname, pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname, path: pathname, headers }, (res) => {
      const ch = [];
      res.on('data', (c) => ch.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(ch) }));
    });
    req.on('error', reject);
    // Bu olmadan asılı bir bağlantı tüm scripti sonsuza dek dondurur.
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
  });
}

async function appleSales() {
  const ios = { vocal: {}, snout: {}, mr: {}, mz: {} };
  const proceedsByCur = {};
  let okCount = 0;    // en az bir rapor indi mi
  let failCount = 0;  // ÇÖZÜLEMEYEN çağrı — 0 değilse toplam eksiktir

  // 404 = o gün/ay için rapor yok (gerçek boşluk). Diğer hatalar veri kaybıdır.
  async function grab(freq, date) {
    const qs = `filter[vendorNumber]=${VENDOR}&filter[reportType]=SALES&filter[reportSubType]=SUMMARY&filter[frequency]=${freq}&filter[reportDate]=${date}`;
    let r = null;
    for (let i = 0; i < 4; i++) {
      try {
        r = await get('api.appstoreconnect.apple.com', `/v1/salesReports?${qs}`, { Authorization: `Bearer ${appleJWT()}`, Accept: 'application/a-gzip' });
      } catch { r = null; }
      if (r && (r.status === 200 || r.status === 404)) break;
      await sleep(8000 * (i + 1));
      r = null;
    }
    await sleep(1500);
    if (!r) { failCount++; return false; }
    if (r.status === 404) return false;
    okCount++;
    let tsv; try { tsv = zlib.gunzipSync(r.buf).toString('utf8'); } catch { failCount++; return false; }
    const lines = tsv.split('\n').filter((l) => l.trim());
    const hdr = lines[0].split('\t');
    const iT = hdr.indexOf('Title'), iU = hdr.indexOf('Units'), iC = hdr.indexOf('Country Code'),
      iP = hdr.indexOf('Product Type Identifier'), iPr = hdr.indexOf('Developer Proceeds'),
      iCur = hdr.indexOf('Currency of Proceeds');
    for (const line of lines.slice(1)) {
      const c = line.split('\t');
      const app = APPS[c[iT]];
      const country = c[iC], units = parseInt(c[iU]) || 0, ptype = c[iP];
      // ptype 1* = ilk indirme, 3* = redownload, 7* = güncelleme
      if (app && ptype.startsWith('1') && country !== 'IN')
        ios[app][country] = (ios[app][country] || 0) + units;
      const p = (parseFloat(c[iPr]) || 0) * units;
      if (p > 0) {
        const cur = (c[iCur] || '?').trim();
        proceedsByCur[cur] = Math.round(((proceedsByCur[cur] || 0) + p) * 100) / 100;
      }
    }
    return true;
  }

  // Tamamlanmış aylar: Kasım 2025 → geçen ay. Aylık rapor henüz yayınlanmadıysa
  // (ay başı gecikmesi) o ayın günlüklerine düş.
  const d = new Date();
  const thisYm = d.getFullYear() * 12 + d.getMonth();
  for (let ym = 2025 * 12 + 10; ym < thisYm; ym++) {
    const y = Math.floor(ym / 12), m = ym % 12 + 1;
    const tag = `${y}-${String(m).padStart(2, '0')}`;
    const ok = await grab('MONTHLY', tag);
    if (!ok && ym >= thisYm - 2) {
      const lastDay = new Date(y, m, 0).getDate();
      for (let i = 1; i <= lastDay; i++) await grab('DAILY', `${tag}-${String(i).padStart(2, '0')}`);
      log(`aylık ${tag} yok — günlüklerden toplandı`);
    }
  }
  // İçinde bulunduğumuz ay: her zaman günlükler
  for (let i = 1; i <= d.getDate(); i++)
    await grab('DAILY', `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`);

  if (failCount) log(`apple: ${failCount} çağrı çözülemedi — veri EKSİK, iOS yazılmayacak`);
  return { ios, proceedsByCur, ok: okCount > 0 && failCount === 0 };
}

async function googleToken() {
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const c = Buffer.from(JSON.stringify({ iss: GP_SA.client_email, scope: 'https://www.googleapis.com/auth/devstorage.read_only', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })).toString('base64url');
  const s = crypto.createSign('RSA-SHA256'); s.update(`${h}.${c}`);
  const jwt = `${h}.${c}.${s.sign(GP_SA.private_key).toString('base64url')}`;
  const body = `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`;
  return new Promise((resolve) => {
    const req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let d = ''; res.on('data', (x) => d += x);
      res.on('end', () => resolve(JSON.parse(d).access_token || null));
    });
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
}

async function googleInstalls() {
  const token = await googleToken();
  if (!token) return null;
  const android = { vocal: {}, snout: {}, mr: {}, mz: {} };
  const uninst = { vocal: 0, snout: 0, mr: 0, mz: 0 };
  const d = new Date();
  const months = [];
  for (let y = 2026, m = 3; y < d.getFullYear() || (y === d.getFullYear() && m <= d.getMonth() + 1);) {
    months.push(`${y}${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  let any = false;
  for (const pkg of Object.keys(PKGS)) {
    for (const ym of months) {
      const obj = encodeURIComponent(`stats/installs/installs_${pkg}_${ym}_country.csv`);
      const r = await get('storage.googleapis.com', `/storage/v1/b/${GP_BUCKET}/o/${obj}?alt=media`, { Authorization: `Bearer ${token}` });
      if (r.status !== 200) continue;   // dosya henüz oluşmamış olabilir (Play 3-5 gün gecikir)
      any = true;
      let text; try { text = r.buf.toString('utf16le'); if (!text.includes('Package')) text = r.buf.toString('utf8'); } catch { continue; }
      const lines = text.split('\n').filter((l) => l.trim());
      const hdr = lines[0].replace(/^﻿/, '').split(',');
      const iC = hdr.indexOf('Country'), iI = hdr.indexOf('Daily User Installs'), iU = hdr.indexOf('Daily User Uninstalls');
      const app = PKGS[pkg];
      for (const line of lines.slice(1)) {
        const c = line.split(',');
        const country = (c[iC] || '').trim();
        if (country === 'IN' || !country) continue;
        android[app][country] = (android[app][country] || 0) + (parseInt(c[iI]) || 0);
        uninst[app] += parseInt(c[iU]) || 0;
      }
    }
  }
  return any ? { android, uninst } : null;
}

function diffMap(cur, base) {
  const out = {};
  for (const [k, v] of Object.entries(cur || {})) {
    const delta = v - (base[k] || 0);
    if (delta > 0) out[k] = delta;
  }
  return out;
}

async function main() {
  log('güncelleme başladı');
  const prev = fs.existsSync(DATA) ? JSON.parse(fs.readFileSync(DATA, 'utf8')) : { history: [] };

  const apple = await appleSales();
  const goog = await googleInstalls();
  log(`apple ${apple.ok ? 'ok' : 'ERİŞİM YOK/EKSİK — iOS son bilinen değerler korunuyor'} (proceeds ${JSON.stringify(apple.proceedsByCur)}); google ${goog ? 'ok' : 'ERİŞİM YOK — Android son bilinen değerler korunuyor'}`);

  const androidCur = goog ? goog.android : (prev.androidCur || BASE.android);
  const uninstCur = goog ? goog.uninst : (prev.uninstCur || BASE.androidUninst);

  const newByApp = {}, newCountries = new Set();
  let totalNew = 0;
  for (const app of ['vocal', 'snout', 'mr', 'mz']) {
    // Apple verisi tam değilse iOS delta'sını önceki data.json'dan koru — 0 YAZMA.
    const di = apple.ok ? diffMap(apple.ios[app], BASE.ios[app]) : (prev.newByApp?.[app]?.byCountryIos || {});
    const da = diffMap(androidCur[app], BASE.android[app]);
    const merged = {};
    for (const [k, v] of Object.entries(di)) merged[k] = (merged[k] || 0) + v;
    for (const [k, v] of Object.entries(da)) merged[k] = (merged[k] || 0) + v;
    newByApp[app] = { ios: sum(di), android: sum(da), byCountry: merged, byCountryIos: di, byCountryAndroid: da };
    totalNew += sum(di) + sum(da);
    const baseCountries = new Set([...Object.keys(BASE.ios[app]), ...Object.keys(BASE.android[app])]);
    for (const k of Object.keys(merged)) if (!baseCountries.has(k)) newCountries.add(k);
  }

  // GERİLEME KORUMASI: kümülatif "baz'dan beri yeni indirme" asla azalamaz.
  // Azaldıysa veri eksik gelmiştir — data.json'a dokunma, hata ver.
  if (typeof prev.totalNew === 'number' && totalNew < prev.totalNew) {
    log(`GERİLEME: toplam ${prev.totalNew} → ${totalNew}. Veri eksik kabul edildi, data.json DEĞİŞTİRİLMEDİ.`);
    process.exitCode = 1;
    return;
  }

  const newUninst = goog ? Math.max(0, sum(uninstCur) - sum(BASE.androidUninst)) : null;
  const entry = {
    date: new Date().toISOString().slice(0, 10),
    totalNew,
    perApp: {
      vocal: newByApp.vocal.ios + newByApp.vocal.android,
      snout: newByApp.snout.ios + newByApp.snout.android,
      mr: newByApp.mr.ios + newByApp.mr.android,
      mz: newByApp.mz.ios + newByApp.mz.android,
    },
  };
  const history = (prev.history || []).filter((h) => h.date !== entry.date);
  history.push(entry);

  fs.writeFileSync(DATA, JSON.stringify({
    updatedAt: new Date().toISOString(),
    baselineDate: '2026-07-13',
    totalNew,
    newUninst,
    newCountries: [...newCountries],
    proceedsByCur: apple.proceedsByCur,
    newByApp,
    history,
    androidLive: !!goog,
    androidCur, uninstCur,
  }, null, 1));
  log(`data.json yazıldı — yeni indirme: ${totalNew}`);
}

main().catch((e) => { log('HATA: ' + e.message); process.exitCode = 1; });
