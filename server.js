require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Storage — persisted to Upstash Redis (a free, permanent, external key-value
// store) instead of the local disk. Render's free tier wipes local files
// every time the service spins down from inactivity — which happens several
// times a day — so anything written only to disk disappears constantly.
// A local JSON file is still kept as a same-request cache/fallback so the
// rest of the code can read/write `store` synchronously as before.
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const STORE_KEY = "loop-gm-store";
const EMPTY_STORE = { gmMessages: [], gmDisplayLog: [], deptLogs: {}, dailyBriefing: null, secretaryBriefing: null, competitorReport: null };

async function loadStoreRemote() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${STORE_KEY}`, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
    const data = await res.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch {
    return null;
  }
}

function saveStoreRemote(storeObj) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(storeObj, null, 2), "utf8"); // local fallback
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  fetch(`${UPSTASH_URL}/set/${STORE_KEY}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    body: JSON.stringify(storeObj),
  }).catch(() => {}); // best-effort; a dropped save just means next call retries with a fuller diff
}

function loadStoreLocal() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { ...EMPTY_STORE };
  }
}

function saveStore(storeObj) {
  saveStoreRemote(storeObj);
}

// Start with whatever's on local disk (instant), then replace with Upstash's
// copy once it arrives (the source of truth across spin-downs).
let store = loadStoreLocal();
loadStoreRemote().then((remote) => {
  if (remote) store = remote;
});

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// ---------------------------------------------------------------------------
// Company + department configuration (same personas as the artifact version)
// ---------------------------------------------------------------------------
const LOOP_CONTEXT = `Loop Travel & Tourism (يُعرف أيضًا بـ Golden Medal) وكالة سفريات وسياحة مقرها الإمارات، تقدم باقات وجهات سياحية، برامج عمرة، وباقات رياضية. تدير حسابها على انستغرام (@loop.tourism) عبر أتمتة خدمة عملاء تعتمد على ManyChat وMake.com وGoogle Sheets لجلب الأسعار وإرسال ردود عربية منسّقة. يديرها نواف.`;

const COMM_CONTEXT = `آلية التواصل الفعلية مع العملاء عبر انستغرام (بالأتمتة عبر ManyChat): رسالة ترحيب تلقائية "مرحباً بك في Loop Travel & Tourism 🌍✈️" ثم أزرار اختيار الفئة: باقات العمرة، الباقات السياحية، الباقات الرياضية. بعد اختيار العميل، يجلب النظام الأسعار الفعلية من Google Sheets عبر Make.com، ويعرض حالة الباقة مع قائمة مزايا (إقامة، إفطار، وتوصيل يتوفر عند الطلب حسب الباقة)، ثم يوجّه العميل للحجز عبر زرّي "تواصل معنا للحجز" أو "القائمة الرئيسية". رقم التواصل/واتساب الرسمي للحجز والاستفسارات: +971 54 544 4003.`;

const DEPTS = {
  finance: {
    name: "المالية", role: "رئيس القسم المالي",
    sheetUrl: "https://docs.google.com/spreadsheets/d/1lOFhWpKIUd3kV7brNa-6BCJQmbKQ6iV6VHxR9ejTm3U/export?format=csv&gid=399480050",
    sheetColumns: "الوجهة، تاريخ البداية، تاريخ النهاية، عدد الليالي، سعر شخصين، سعر 3 أشخاص، سعر 4 أشخاص، ملاحظات، Type، تاريخ التحديث",
    system: `أنت رئيس القسم المالي في Loop Travel & Tourism. ${LOOP_CONTEXT}
أنت عضو فعلي من فريق Loop، تتحدث بصيغة "نحن" لا "أنتم"، وتقدّم تقاريرك مباشرة للمدير العام.
مسؤوليتك: التسعير وهوامش الربح لباقات العمرة والوجهات السياحية، الميزانيات، التدفق النقدي، وتقييم الجدوى المالية للمبادرات الجديدة.
تحدث كرئيس قسم مالي فعلي: مباشر، مبني على أرقام حين تُذكر لك، وإن لم تتوفر لديك بيانات فعلية فوضّح أنها تقديرات أو اطلب الأرقام الفعلية بدل اختلاقها. أجب بالعربية بإيجاز تنفيذي (لا تتجاوز فقرة أو فقرتين قصيرتين).`,
  },
  marketing: {
    name: "التسويق", role: "رئيس قسم التسويق",
    sheetUrl: null, sheetColumns: null,
    system: `أنت رئيس قسم التسويق في Loop Travel & Tourism. ${LOOP_CONTEXT}
أنت عضو فعلي من فريق Loop، تتحدث بصيغة "نحن" لا "أنتم"، وتقدّم تقاريرك مباشرة للمدير العام.
مسؤوليتك: حملات انستغرام، المحتوى، الإعلانات الممولة، هوية العلامة، وتحسين معدلات التحويل من المتابعين إلى حجوزات.
أجب كرئيس تسويق فعلي، مقترحات عملية وقابلة للتنفيذ، بالعربية، بإيجاز تنفيذي (فقرة أو فقرتين).`,
  },
  strategy: {
    name: "الاستراتيجية", role: "رئيس قسم الاستراتيجية",
    sheetUrl: "https://docs.google.com/spreadsheets/d/1lOFhWpKIUd3kV7brNa-6BCJQmbKQ6iV6VHxR9ejTm3U/export?format=csv&gid=399480050",
    sheetColumns: "الوجهة، تاريخ البداية، تاريخ النهاية، عدد الليالي، سعر شخصين، سعر 3 أشخاص، سعر 4 أشخاص، ملاحظات، Type، تاريخ التحديث",
    system: `أنت رئيس قسم الاستراتيجية في Loop Travel & Tourism. ${LOOP_CONTEXT}
أنت عضو فعلي من فريق Loop، تتحدث بصيغة "نحن" لا "أنتم"، وتقدّم تقاريرك مباشرة للمدير العام.
مسؤوليتك: خطط النمو والتوسع، الشراكات، تحليل المنافسين والسوق، وأولويات المشروع على المدى المتوسط والبعيد. استخدم أسعار باقاتنا الفعلية (المرفقة أدناه) مقارنة ببيانات المنافسين الحية عند تقييم موقعنا التنافسي.
أجب كرئيس استراتيجية فعلي، بخطوات واضحة الأولوية، بالعربية، بإيجاز تنفيذي (فقرة أو فقرتين).`,
  },
  communication: {
    name: "الاتصال", role: "رئيس قسم الاتصال",
    sheetUrl: null, sheetColumns: null,
    system: `أنت رئيس قسم الاتصال وخدمة العملاء في Loop Travel & Tourism. ${LOOP_CONTEXT}
أنت عضو فعلي من فريق Loop، تتحدث بصيغة "نحن" لا "أنتم"، وتقدّم تقاريرك مباشرة للمدير العام.
${COMM_CONTEXT}
مسؤوليتك: التواصل مع العملاء عبر انستغرام وواتساب، صياغة الردود والرسائل، وتحسين تجربة العميل في المحادثات — بما ينسجم مع آلية الأتمتة الفعلية الموضحة أعلاه.
أجب كرئيس اتصال فعلي، بالعربية، بإيجاز تنفيذي (فقرة أو فقرتين).`,
  },
  accounting: {
    name: "المحاسبة", role: "رئيس المحاسبة والرقابة المالية",
    sheetUrl: "https://docs.google.com/spreadsheets/d/1lOFhWpKIUd3kV7brNa-6BCJQmbKQ6iV6VHxR9ejTm3U/export?format=csv&gid=399480050",
    sheetColumns: "الوجهة، تاريخ البداية، تاريخ النهاية، عدد الليالي، سعر شخصين، سعر 3 أشخاص، سعر 4 أشخاص، ملاحظات، Type، تاريخ التحديث",
    system: `أنت رئيس المحاسبة والرقابة المالية في Loop Travel & Tourism. ${LOOP_CONTEXT}
أنت عضو فعلي من فريق Loop، تتحدث بصيغة "نحن" لا "أنتم"، وتقدّم تقاريرك مباشرة للمدير العام.
مسؤوليتك: ضبط الإيرادات والتكاليف لكل باقة على حدة، مطابقة المقبوضات بالحجوزات، رصد أي فروقات أو تسريب مالي (باقة تُباع بأقل من تكلفتها، خصم غير مبرر، مصروف بلا سند)، والتأكد من سلامة هوامش الربح فعليًا لا نظريًا.
دورك رقابي لا تسويقي: تشير للأرقام التي لا تتطابق وتطلب تفسيرها بدل تمريرها. إن لم تتوفر لديك بيانات التكاليف الفعلية، وضّح ذلك واطلبها صراحة بدل افتراضها.
أجب كرئيس محاسبة فعلي، بأرقام محددة حين تتوفر، بالعربية، بإيجاز تنفيذي (فقرة أو فقرتين).`,
  },
  sales: {
    name: "المبيعات", role: "رئيس المبيعات وتطوير الأعمال",
    sheetUrl: "https://docs.google.com/spreadsheets/d/1lOFhWpKIUd3kV7brNa-6BCJQmbKQ6iV6VHxR9ejTm3U/export?format=csv&gid=399480050",
    sheetColumns: "الوجهة، تاريخ البداية، تاريخ النهاية، عدد الليالي، سعر شخصين، سعر 3 أشخاص، سعر 4 أشخاص، ملاحظات، Type، تاريخ التحديث",
    system: `أنت رئيس المبيعات وتطوير الأعمال في Loop Travel & Tourism. ${LOOP_CONTEXT}
أنت عضو فعلي من فريق Loop، تتحدث بصيغة "نحن" لا "أنتم"، وتقدّم تقاريرك مباشرة للمدير العام.
${COMM_CONTEXT}
مسؤوليتك: تحويل الاستفسارات القادمة عبر الأتمتة (انستغرام وواتساب) إلى مبيعات فعلية ومهيكلة — متابعة العملاء المهتمين حتى الحجز، تقليل التسرّب بين الاستفسار والحجز، بناء عروض وحزم تزيد قيمة الطلب، وفتح قنوات بيع وشراكات جديدة.
ركّز على الخطوة العملية التالية لكل فرصة، لا على الوصف العام.
أجب كرئيس مبيعات فعلي، بخطوات قابلة للتنفيذ، بالعربية، بإيجاز تنفيذي (فقرة أو فقرتين).`,
  },
};

const GM_SYSTEM = `أنت المدير العام لشركة Loop Travel & Tourism — عضو فعلي من فريق قيادة الشركة، ورئيس نواف المباشر في هرمها الإداري، وليس مستشارًا خارجيًا أو طرفًا ثالثًا. أنت جزء من الشركة، فتحدّث عنها دائمًا بصيغة "نحن" — ممنوع منعًا باتًا استخدام "أنتم". أنت أيضًا مساعد نواف الشخصي — تجاوبه على أي سؤال عام مباشرة بمعرفتك العامة دون استخدام أي أداة.
${LOOP_CONTEXT}
عندما يطلب منك نواف تحديثًا أو استشارة تخص الشركة وتحتاج خبرة قسم معين (المالية، التسويق، الاستراتيجية، الاتصال، المحاسبة والرقابة المالية، المبيعات وتطوير الأعمال)، استخدم أداة الاستشارة الخاصة بذلك القسم، ويمكنك استشارة أكثر من قسم بنفس الرسالة. بعد استلام ردود الأقسام، لخّصها بأسلوب تنفيذي واضح ومباشر، وادمجها في توصية واحدة متماسكة — وأنت من يملك القرار النهائي بصفتك المدير العام.
لا تختلق أرقامًا أو حقائق عن الشركة؛ إن لم تكن المعلومة متوفرة، وضّح ذلك. تحدث بالعربية دائمًا.
مهم جدًا: ردّك النهائي يجب أن يبدأ مباشرة بالمعلومة أو التوصية نفسها — بدون أي مقدمة تشرح خطواتك أو تسرد أنك استشرت قسمًا معينًا.`;

// ---------------------------------------------------------------------------
// Secretary — crypto/gold prices come straight from Kraken's live ticker
// (a real exchange feed, not a cached news page) computed here in code for
// accuracy; only WTI oil and weather are left to Claude's web_search.
// ---------------------------------------------------------------------------
const PORTFOLIO = [
  { symbol: "ETH", match: ["ETH"], qty: 0.1866579, cost: 2319.68 },
  { symbol: "SOL", match: ["SOL"], qty: 4.49919209, cost: 84.2080 },
  { symbol: "ATOM", match: ["ATOM"], qty: 196.52547694, cost: 1.3853 },
  { symbol: "XLM", match: ["XLM"], qty: 1555.19247268, cost: 0.17510 },
  { symbol: "FET", match: ["FET"], qty: 1839.18182198, cost: 0.14800 },
  { symbol: "SUI", match: ["SUI"], qty: 243.6238336, cost: 1.0932 },
  { symbol: "DOGE", match: ["XDG", "DOGE"], qty: 962.56531898, cost: 0.10960 },
];

function findTicker(result, tokens) {
  const key = Object.keys(result).find((k) => tokens.some((t) => k.toUpperCase().includes(t)) && k.toUpperCase().includes("USD"));
  return key ? result[key] : null;
}

async function fetchKrakenData() {
  const res = await fetch("https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD,SOLUSD,ATOMUSD,XLMUSD,DOGEUSD,SUIUSD,FETUSD,PAXGUSD");
  const json = await res.json();
  if (json.error?.length) throw new Error(json.error.join("; "));
  const result = json.result;

  const btc = findTicker(result, ["XBT", "BTC"]);
  const gold = findTicker(result, ["PAXG"]);
  if (!btc || !gold) throw new Error("تعذر إيجاد أسعار البيتكوين أو الذهب من Kraken");

  const pct = (t) => {
    const c = parseFloat(t.c[0]);
    const o = parseFloat(t.o);
    return { price: c, changePct: ((c - o) / o) * 100 };
  };

  let totalValue = 0, totalCost = 0;
  for (const asset of PORTFOLIO) {
    const t = findTicker(result, asset.match);
    if (!t) throw new Error(`تعذر إيجاد سعر ${asset.symbol} من Kraken`);
    const price = parseFloat(t.c[0]);
    totalValue += asset.qty * price;
    totalCost += asset.qty * asset.cost;
  }
  const portfolioPct = ((totalValue - totalCost) / totalCost) * 100;

  return { btc: pct(btc), gold: pct(gold), portfolioPct };
}

function gulfCityToday() {
  // UTC+4, no DST.
  const now = new Date(Date.now() + 4 * 60 * 60 * 1000);
  const day = now.getUTCDay(); // 0=Sun..6=Sat, computed against the shifted "Gulf" instant
  const isWeekend = day === 0 || day === 6;
  return isWeekend ? "رأس الخيمة" : "أبوظبي";
}

const SECRETARY_SYSTEM_BASE = `أنت السكرتير الشخصي لنواف داخل منصة Loop. مهمتك الوحيدة صباح كل يوم: تجهيز إحاطة صباحية شخصية لا علاقة لها بأعمال الشركة.
عندك أدناه بيانات دقيقة ومحسوبة مسبقًا لبيتكوين والذهب والمحفظة — استخدمها كما هي، لا تعيد حسابها ولا تخترع أرقامًا بديلة.
استخدم أداة البحث (web_search) للحصول على شيئين فقط:
1. سعر النفط الخام WTI الحالي (دولار للبرميل) وتغيره اليومي.
2. توقعات طقس اليوم للمدينة المحددة أدناه: أعلى/أقل حرارة بالمئوية، الحالة العامة، واحتمال الأمطار إن وجد.

أجب مباشرة بالشكل التالي بالضبط، بدون أي مقدمة أو سرد لخطوات البحث:

صباح الخير ☀️

**بيتكوين:** $[السعر] ([+/-X.XX]% خلال اليوم)

**الذهب:** $[السعر]/أونصة ([+/-X.XX]%)

**النفط الخام (WTI):** $[السعر]/برميل ([+/-X.XX]%)

**محفظتك:** [+/-X.XX]%

**الطقس — [المدينة]:** [الحالة]، أعلى درجة حرارة حوالي [X]°م، أقل درجة حرارة حوالي [X]°م، [احتمال الأمطار]`;

const TOOLS = Object.entries(DEPTS).map(([id, d]) => ({
  name: `consult_${id}`,
  description: `تكليف ${d.role} في Loop Travel بمهمة أو سؤال يقع ضمن مسؤولياته.`,
  input_schema: {
    type: "object",
    properties: { instruction: { type: "string", description: "الأمر أو السؤال الموجّه لرئيس هذا القسم." } },
    required: ["instruction"],
  },
}));

// ---------------------------------------------------------------------------
// Claude call helpers
// ---------------------------------------------------------------------------
function textOf(content) {
  return (content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}
function finalTextOf(content) {
  const full = textOf(content);
  const marker = "صباح الخير";
  const idx = full.indexOf(marker);
  return idx >= 0 ? full.slice(idx).trim() : full;
}

async function callClaude({ system, messages, tools }) {
  const res = await anthropic.messages.create({
    model: MODEL, max_tokens: 1000, system, messages, ...(tools ? { tools } : {}),
  });
  return res;
}

// ---------------------------------------------------------------------------
// Meta (Instagram) Graph API — safe here because the token lives only on the
// server, never in browser-visible code.
// ---------------------------------------------------------------------------
const META_TOKEN = process.env.META_ACCESS_TOKEN;
const META_IG_USER_ID = process.env.META_IG_USER_ID;
const GRAPH_VERSION = "v21.0";
const COMPETITOR_USERNAMES = ["hejozati", "alsuwaidisons", "alkhalidiya_holidays"];

async function metaGraph(path, params = {}) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", META_TOKEN);
  const res = await fetch(url.toString());
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error?.message || `Graph API error (${res.status})`);
  return data;
}

// Own recent posts + basic public engagement fields (no special insights
// permission needed — just caption/like_count/comments_count on /media).
async function fetchOwnRecentMedia() {
  if (!META_TOKEN || !META_IG_USER_ID) return null;
  try {
    const data = await metaGraph(`${META_IG_USER_ID}/media`, {
      fields: "caption,like_count,comments_count,media_type,timestamp,permalink",
      limit: "8",
    });
    return data.data || [];
  } catch {
    return null;
  }
}

// Public profile + recent posts of ANY Instagram Business/Creator account
// (Business Discovery) — this is how we can see competitors without owning
// their accounts.
// Competitor data comes from Apify's Instagram scraper rather than Meta's
// Business Discovery API — Meta restricts that endpoint's Advanced Access to
// Tech Providers managing other businesses' accounts, which doesn't apply to
// us. Apify reads the same publicly visible profile pages.
const APIFY_TOKEN = process.env.APIFY_API_TOKEN;

async function fetchCompetitorProfile(username) {
  if (!APIFY_TOKEN) return null;
  try {
    const res = await fetch(
      `https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directUrls: [`https://www.instagram.com/${username}/`],
          resultsType: "posts",
          resultsLimit: 12,
          addParentData: true,
        }),
      }
    );
    if (!res.ok) throw new Error(`Apify ${res.status}`);
    const items = await res.json();
    if (!Array.isArray(items) || items.length === 0) return null;

    // Apify returns one item per post, each carrying the owner's profile info.
    const first = items[0];
    return {
      username,
      followers_count: first.ownerFollowersCount ?? first.followersCount ?? null,
      media_count: first.ownerPostsCount ?? first.postsCount ?? null,
      media: {
        data: items.map((p) => ({
          caption: p.caption || "",
          timestamp: p.timestamp || "",
          permalink: p.url || "",
          media_type: p.type === "Video" ? "VIDEO" : "IMAGE",
          media_url: p.displayUrl || (p.images && p.images[0]) || null,
        })),
      },
    };
  } catch {
    return null;
  }
}

const UMRAH_KEYWORDS = ["عمرة", "العمرة", "مكة", "المكرمة", "umrah", "makkah", "mecca"];
function isUmrahPost(caption) {
  const c = (caption || "").toLowerCase();
  return UMRAH_KEYWORDS.some((k) => c.includes(k));
}

// Downloads a competitor's post image and asks Claude (vision) to read any
// offer/price shown in it. This is the piece that was impossible from the
// browser artifact (CORS) — the server has no such restriction.
async function analyzeImageForPricing(imageUrl, caption) {
  try {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) throw new Error();
    const mediaType = imgRes.headers.get("content-type") || "image/jpeg";
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const base64 = buffer.toString("base64");
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 300,
      system: "أنت محلل بيانات تسويقية لوكالة سفريات. مهمتك: تلخيص أي عرض عمرة أو سعر ظاهر داخل الصورة المرفقة (الفنادق، عدد الليالي، السعر، تاريخ السفر) بجملة أو جملتين بالعربية فقط، بدون أي تعليق إضافي. إذا لم يكن هناك عرض أو سعر واضح بالصورة، قل حرفيًا: لا يوجد عرض واضح.",
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: `نص المنشور: ${caption || "بدون نص"}\nلخّص العرض/السعر الظاهر بالصورة.` },
        ],
      }],
    });
    return textOf(res.content) || "تعذر تحليل الصورة.";
  } catch {
    return null;
  }
}

async function callDepartment(deptId, instruction) {
  const dept = DEPTS[deptId];
  let systemText = dept.system;
  if (dept.sheetUrl) {
    try {
      const res = await fetch(dept.sheetUrl);
      if (res.ok) {
        const csv = (await res.text()).split("\n").slice(0, 80).join("\n");
        systemText += `\n\nبيانات فعلية حديثة من ملف Loop (تنسيق CSV، الأعمدة: ${dept.sheetColumns}):\n${csv}\n\nاستخدم هذه الأرقام الفعلية متى كانت ذات صلة، ولا تخترع أرقامًا أخرى تخالفها.`;
      } else {
        systemText += `\n\n(تعذر الوصول لملف البيانات هذه المرة — وضّح ذلك إن احتاجه السؤال بدل التخمين.)`;
      }
    } catch {
      systemText += `\n\n(تعذر الوصول لملف البيانات هذه المرة — وضّح ذلك إن احتاجه السؤال بدل التخمين.)`;
    }
  }

  if (deptId === "marketing") {
    const media = await fetchOwnRecentMedia();
    if (media && media.length) {
      const summary = media.map((m) => `- ${m.timestamp}: "${(m.caption || "").slice(0, 100)}" — ${m.like_count ?? "?"} إعجاب، ${m.comments_count ?? "?"} تعليق (${m.permalink})`).join("\n");
      systemText += `\n\nآخر منشورات حساب Loop الفعلية على انستغرام (بيانات حية من Meta API):\n${summary}\n\nاستخدم هذه الأرقام الفعلية عند تقييم الأداء، ولا تخترع أرقامًا أخرى.`;
    } else if (META_TOKEN) {
      systemText += `\n\n(تعذر جلب بيانات انستغرام الحية هذه المرة — وضّح ذلك إن احتاجها السؤال.)`;
    }
  }

  if (deptId === "strategy") {
    // Fetch all competitors in parallel, and analyse each one's candidate
    // images in parallel too — sequential runs pushed this past the browser's
    // patience since every Apify call takes ~30-60s on its own.
    const profiles = (await Promise.all(
      COMPETITOR_USERNAMES.map(async (username) => {
        const p = await fetchCompetitorProfile(username);
        if (!p) return null;

        const allMedia = p.media?.data || [];
        const posts = allMedia.slice(0, 5).map((m) => `  · ${m.timestamp}: "${(m.caption || "").slice(0, 90)}"`).join("\n");

        // Prefer posts that actually mention Umrah (these accounts also post other
        // travel types); fall back to the most recent images if none match.
        const umrahMedia = allMedia.filter((m) => m.media_type === "IMAGE" && m.media_url && isUmrahPost(m.caption));
        const candidates = (umrahMedia.length ? umrahMedia : allMedia.filter((m) => m.media_type === "IMAGE" && m.media_url)).slice(0, 3);

        const analyses = await Promise.all(
          candidates.map(async (m) => {
            const analysis = await analyzeImageForPricing(m.media_url, m.caption);
            return analysis ? `  · (${m.timestamp}): ${analysis}` : null;
          })
        );
        const reads = analyses.filter(Boolean);
        const priceBlock = reads.length ? `\nقراءة بصرية فعلية لآخر ${reads.length} منشور${umrahMedia.length ? " متعلق بالعمرة" : ""}:\n${reads.join("\n")}` : "";

        return `@${p.username} — ${p.followers_count ?? "؟"} متابع، ${p.media_count ?? "؟"} منشور\nآخر منشورات:\n${posts}${priceBlock}`;
      })
    )).filter(Boolean);

    if (profiles.length) {
      systemText += `\n\nبيانات حية الآن من حسابات المنافسين على انستغرام، بما فيها قراءة بصرية فعلية لمنشورات العمرة تحديدًا حين توفرت:\n${profiles.join("\n\n")}\n\nهذه بيانات لحظية حقيقية — استخدمها بدل اللقطة الثابتة القديمة إن وُجد تعارض بينهما.`;
    }
  }

  try {
    const res = await callClaude({ system: systemText, messages: [{ role: "user", content: instruction }] });
    return textOf(res.content) || "لا يوجد رد.";
  } catch {
    return "تعذر الوصول للقسم حاليًا.";

  }
}

function appendDeptLog(deptId, instruction, response) {
  if (!store.deptLogs[deptId]) store.deptLogs[deptId] = [];
  store.deptLogs[deptId].push({ instruction, response, ts: Date.now() });
  saveStore(store);
}

async function runGM(userText, displayText) {
  let messages = [...store.gmMessages.slice(-16), { role: "user", content: userText }];
  let finalText = null;
  let consultedAll = [];

  // Today's already-prepared material, so asking "what's the briefing?" from a
  // second device returns what was actually sent this morning instead of
  // silently regenerating a different one.
  let system = GM_SYSTEM;
  const ready = [];
  if (store.dailyBriefing?.day === todayKey()) {
    ready.push(`إحاطة اليوم الصباحية التي كتبتَها بالفعل هذا الصباح:\n${store.dailyBriefing.text}`);
  }
  if (store.competitorReport?.day === todayKey()) {
    ready.push(`تقرير المنافسين الذي أعدّه قسم الاستراتيجية هذا الصباح:\n${store.competitorReport.text}`);
  }
  if (ready.length) {
    system += `\n\n${ready.join("\n\n")}\n\nإن سألك نواف عن إحاطة اليوم أو عن تقرير المنافسين، أعطه ما هو مذكور أعلاه كما هو (فهو ما استلمه فعلًا هذا الصباح) بدل توليد نسخة جديدة مختلفة، إلا إن طلب صراحة تحديثها أو إعادة توليدها.`;
  }

  for (let round = 0; round < 3 && finalText === null; round++) {
    const res = await callClaude({ system, messages, tools: TOOLS });
    const content = res.content || [];
    const toolUses = content.filter((b) => b.type === "tool_use");
    messages = [...messages, { role: "assistant", content }];

    if (toolUses.length === 0) { finalText = textOf(content) || "تم."; break; }

    const toolResults = [];
    for (const tu of toolUses) {
      const deptId = tu.name.replace("consult_", "");
      const instruction = tu.input?.instruction || "";
      const responseText = await callDepartment(deptId, instruction);
      appendDeptLog(deptId, instruction, responseText);
      consultedAll.push(deptId);
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: responseText });
    }
    messages = [...messages, { role: "user", content: toolResults }];
  }

  store.gmMessages = messages.slice(-16);
  const reply = finalText || "تم تنفيذ طلبك.";
  const depts = [...new Set(consultedAll)];
  store.gmDisplayLog.push({ role: "user", text: displayText || userText, ts: Date.now() });
  store.gmDisplayLog.push({ role: "gm", text: reply, depts, ts: Date.now() });
  store.gmDisplayLog = store.gmDisplayLog.slice(-100);
  saveStore(store);
  return { reply, depts };
}

async function generateDailyBriefing() {
  // The GM writes the briefing itself (so it lands in the GM conversation and
  // stays in its memory), grounded in the competitor report the strategy
  // department produced earlier in the same morning run.
  let prompt = "اكتب لنواف إحاطته الصباحية التنفيذية عن وضع الشركة اليوم. نسّق مع الأقسام حسب الحاجة، وأبرز ما يستحق انتباهه الآن.";
  if (store.competitorReport?.day === todayKey()) {
    prompt += `\n\nهذا تقرير المنافسين الذي أعدّه قسم الاستراتيجية صباح اليوم — ادمج أهم ما فيه في إحاطتك بصفتك مطّلعًا عليه، ولا تكرره حرفيًا:\n${store.competitorReport.text}`;
  }
  const result = await runGM(prompt, "إحاطة الصباح");
  store.dailyBriefing = { text: result.reply, depts: result.depts, ts: Date.now(), day: todayKey() };
  saveStore(store);
  return store.dailyBriefing;
}

// Competitor report — the heavy Apify + vision work runs on a schedule so the
// result is already waiting when Nawaf opens it, instead of making him sit
// through a multi-minute request.
async function generateCompetitorReport() {
  const reply = await callDepartment(
    "strategy",
    "أعدّ تقريرًا تنافسيًا اليوم: قارن أسعار باقات العمرة لدينا بأسعار المنافسين الظاهرة في منشوراتهم الحالية. اذكر الأسعار المرصودة لكل منافس، ثم وضّح موقعنا السعري مقابلهم، واختم بتوصية عملية واحدة."
  );
  store.competitorReport = { text: reply, ts: Date.now(), day: todayKey() };
  saveStore(store);
  return store.competitorReport;
}

async function generateSecretaryBriefing() {
  let system = SECRETARY_SYSTEM_BASE;
  try {
    const k = await fetchKrakenData();
    const city = gulfCityToday();
    system += `\n\nبيانات محسوبة الآن (استخدمها حرفيًا):
- سعر البيتكوين: $${k.btc.price.toLocaleString("en-US", { maximumFractionDigits: 2 })} (${k.btc.changePct >= 0 ? "+" : ""}${k.btc.changePct.toFixed(2)}% خلال اليوم)
- سعر الذهب (عبر PAXG، وكيل حي دقيق لسعر الأونصة): $${k.gold.price.toLocaleString("en-US", { maximumFractionDigits: 2 })} (${k.gold.changePct >= 0 ? "+" : ""}${k.gold.changePct.toFixed(2)}%)
- نسبة ربح/خسارة المحفظة الإجمالية: ${k.portfolioPct >= 0 ? "+" : ""}${k.portfolioPct.toFixed(2)}%
- مدينة اليوم لتوقعات الطقس: ${city}`;
  } catch (e) {
    system += `\n\n(تعذر جلب بيانات Kraken هذه المرة: ${e.message} — وضّح بصراحة في الرد أن أسعار البيتكوين/الذهب/المحفظة غير متوفرة اليوم بدل اختلاقها، واكتفِ بالنفط والطقس.)`;
  }

  const res = await callClaude({
    system,
    messages: [{ role: "user", content: "أعطني الإحاطة الصباحية" }],
    tools: [{ type: "web_search_20250305", name: "web_search" }],
  });
  const text = finalTextOf(res.content) || "تعذر تجهيز الإحاطة الشخصية اليوم.";
  store.secretaryBriefing = { text, ts: Date.now(), day: todayKey() };
  saveStore(store);
  return store.secretaryBriefing;
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------
const app = express();
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
}));
// Accept the request body as JSON no matter what Content-Type header the
// client sent (or omitted) — this lets the frontend send POST requests
// without a "Content-Type: application/json" header, which avoids the CORS
// preflight (OPTIONS) round-trip that some free hosting edges mishandle.
app.use(express.json({ type: () => true }));

app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// A real, live Privacy Policy page — Meta requires this URL before an app
// can go Live and before App Review will accept a submission.
app.get("/privacy", (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>سياسة الخصوصية — Loop Travel & Tourism</title>
<style>
  body { font-family: -apple-system, 'Segoe UI', Tahoma, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; line-height: 1.8; color: #222; }
  h1 { font-size: 22px; } h2 { font-size: 17px; margin-top: 28px; }
  p, li { color: #333; }
</style>
</head>
<body>
<h1>سياسة الخصوصية — منصة Loop Travel & Tourism الداخلية</h1>
<p>آخر تحديث: 2026</p>

<p>هذه المنصة أداة إدارية داخلية تستخدمها شركة Loop Travel & Tourism (وكالة سفريات وسياحة، الإمارات العربية المتحدة) لتشغيل مساعد إداري ذكي يخدم فريق العمل الداخلي فقط. هذه الصفحة توضّح كيف تتعامل المنصة مع البيانات.

<h2>البيانات التي تُعالَج</h2>
<ul>
  <li>بيانات عامة من حساب Loop على انستغرام (مثل عدد المتابعين وعدد المنشورات ونصوص المنشورات العامة) عبر واجهة Instagram Graph API الرسمية من Meta، لغرض تحليل أداء الحساب داخليًا.</li>
  <li>بيانات أسعار وباقات السفر الخاصة بالشركة (من ملفات جداول بيانات داخلية).</li>
  <li>محتوى المحادثات بين موظفي الشركة والمساعد الإداري الذكي، لغرض تقديم توصيات إدارية.</li>
</ul>

<h2>كيف تُستخدم البيانات</h2>
<p>تُستخدم هذه البيانات حصريًا للأغراض الإدارية الداخلية لشركة Loop (تحليل الأداء، دعم القرار، خدمة العملاء). لا تُباع أو تُشارك هذه البيانات مع أي طرف ثالث لأغراض تسويقية أو إعلانية.</p>

<h2>مشاركة البيانات مع خدمات خارجية</h2>
<p>تعتمد المنصة على مزودي خدمة تقنيين لتشغيلها، وهم:</p>
<ul>
  <li><strong>Anthropic</strong> — لمعالجة اللغة الطبيعية عبر واجهة Claude API.</li>
  <li><strong>Meta Platforms</strong> — عبر Instagram Graph API الرسمية، للوصول لبيانات حساب الشركة العامة.</li>
  <li><strong>Google</strong> — لقراءة جداول بيانات الأسعار الداخلية عبر Google Sheets.</li>
</ul>
<p>هذه الخدمات تُستخدم فقط لتشغيل وظائف المنصة، ولا تُستخدم بياناتها لأي غرض آخر.</p>

<h2>الاحتفاظ بالبيانات</h2>
<p>تُخزَّن سجلات المحادثات والاستشارات على سيرفر المنصة الخاص بالشركة، ويمكن حذفها بالكامل في أي وقت من قبل مدير النظام.</p>

<h2>التواصل</h2>
<p>لأي استفسار متعلق بهذه السياسة، يُرجى التواصل عبر واتساب: +971 54 544 4003.</p>
</body>
</html>`);
});

// Cheap diagnostic — checks the Meta connection without spending on a Claude call.
app.get("/api/meta/status", async (req, res) => {
  const result = { metaConfigured: !!(META_TOKEN && META_IG_USER_ID), apifyConfigured: !!APIFY_TOKEN };

  if (result.metaConfigured) {
    try {
      result.ownAccount = await metaGraph(META_IG_USER_ID, { fields: "username,followers_count,media_count" });
    } catch (e) {
      result.ownAccountError = e.message;
    }
  }

  if (APIFY_TOKEN) {
    try {
      const sample = await fetchCompetitorProfile(COMPETITOR_USERNAMES[0]);
      result.sampleCompetitor = sample
        ? {
            username: sample.username,
            followers_count: sample.followers_count,
            postsFetched: sample.media?.data?.length || 0,
            latestCaption: (sample.media?.data?.[0]?.caption || "").slice(0, 120),
          }
        : null;
      if (!sample) result.sampleCompetitorError = "لم تُرجع Apify أي نتائج";
    } catch (e) {
      result.sampleCompetitorError = e.message;
    }
  } else {
    result.sampleCompetitorError = "APIFY_API_TOKEN غير مضاف بعد";
  }

  res.json(result);
});

app.get("/api/state", (req, res) => {
  res.json({
    gmDisplayLog: store.gmDisplayLog,
    deptLogs: store.deptLogs,
    dailyBriefing: store.dailyBriefing,
    secretaryBriefing: store.secretaryBriefing,
    competitorReport: store.competitorReport,
  });
});

// All state-changing actions are exposed as GET with query params (not
// conventional REST, but GET requests have proven reliable end-to-end while
// POST consistently failed from the browser on this host — see chat-test).
// ---------------------------------------------------------------------------
// Async job pattern — every browser-facing request now returns *instantly*
// with a job id; the slow work (Claude calls) runs in the background and the
// frontend polls a fast status endpoint until it's done. This exists because
// long-lived fetch() calls from the browser to this host were failing
// outright, while instant requests and direct URL navigation both worked —
// so we simply stop making the browser hold a connection open for a while.
// ---------------------------------------------------------------------------
const jobs = new Map(); // id -> { status: 'pending'|'done'|'error', result, error }
let jobCounter = 0;

function startJob(fn) {
  const id = String(++jobCounter);
  jobs.set(id, { status: "pending" });
  fn()
    .then((result) => jobs.set(id, { status: "done", result }))
    .catch((e) => jobs.set(id, { status: "error", error: e.message || "internal error" }));
  // Jobs are small and short-lived; drop them from memory after a while so
  // this never grows unbounded.
  setTimeout(() => jobs.delete(id), 10 * 60 * 1000);
  return id;
}

app.get("/api/job/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ status: "error", error: "job not found or expired" });
  res.json(job);
});

app.get("/api/chat", async (req, res) => {
  const message = (req.query.message || "").toString().trim();
  if (!message) return res.status(400).json({ error: "message is required" });
  const id = startJob(() => runGM(message));
  res.json({ jobId: id });
});

app.get("/api/department/:id", async (req, res) => {
  const { id } = req.params;
  const message = (req.query.message || "").toString().trim();
  if (!DEPTS[id]) return res.status(404).json({ error: "unknown department" });
  if (!message) return res.status(400).json({ error: "message is required" });
  const jobId = startJob(async () => {
    const responseText = await callDepartment(id, message);
    appendDeptLog(id, message, responseText);
    return { reply: responseText };
  });
  res.json({ jobId });
});

app.get("/api/briefing/daily", async (req, res) => {
  try {
    if (store.dailyBriefing?.day === todayKey()) return res.json(store.dailyBriefing);
    const fresh = await generateDailyBriefing();
    res.json(fresh);
  } catch (e) {
    res.status(500).json({ error: e.message || "internal error" });
  }
});

app.get("/api/briefing/daily/refresh", (req, res) => {
  const jobId = startJob(() => generateDailyBriefing());
  res.json({ jobId });
});

app.get("/api/briefing/secretary", async (req, res) => {
  try {
    if (store.secretaryBriefing?.day === todayKey()) return res.json(store.secretaryBriefing);
    const fresh = await generateSecretaryBriefing();
    res.json(fresh);
  } catch (e) {
    res.status(500).json({ error: e.message || "internal error" });
  }
});

app.get("/api/briefing/secretary/refresh", (req, res) => {
  const jobId = startJob(() => generateSecretaryBriefing());
  res.json({ jobId });
});

app.get("/api/competitor-report", (req, res) => {
  res.json(store.competitorReport || null);
});

app.get("/api/competitor-report/refresh", (req, res) => {
  const jobId = startJob(() => generateCompetitorReport());
  res.json({ jobId });
});

app.get("/api/reset", (req, res) => {
  store = { gmMessages: [], gmDisplayLog: [], deptLogs: {}, dailyBriefing: null, secretaryBriefing: null, competitorReport: null };
  saveStore(store);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Scheduled jobs — this is the actual "runs while you're asleep" part.
// 3:00 UTC = 7:00 AM Gulf Standard Time (UTC+4).
// ---------------------------------------------------------------------------
// 04:00 UTC = 8:00 AM Gulf Standard Time (UTC+4). Order matters: the strategy
// department's competitor report is produced first, then the GM writes the
// morning briefing on top of it (which also puts the briefing into the GM's
// own conversation history, so it can discuss it later in the day).
cron.schedule("0 4 * * *", async () => {
  console.log("[cron] generating competitor report…");
  try { await generateCompetitorReport(); } catch (e) { console.error("[cron] competitor report failed:", e.message); }
  console.log("[cron] generating daily briefing…");
  try { await generateDailyBriefing(); } catch (e) { console.error("[cron] daily briefing failed:", e.message); }
  console.log("[cron] generating secretary briefing…");
  try { await generateSecretaryBriefing(); } catch (e) { console.error("[cron] secretary briefing failed:", e.message); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Loop GM server running on port ${PORT}`));
