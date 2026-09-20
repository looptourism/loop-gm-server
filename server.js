require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-sonnet-4-6";

// Every external network call in this file goes through this — without it,
// a single stalled connection (Outlook, Meta, Apify, Resend, Sheets — any of
// them) can hang a job forever with no way to recover, which is exactly what
// "the GM keeps thinking" looks like from the browser.
async function fetchWithTimeout(url, opts = {}, ms = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`انتهت المهلة (${ms / 1000}ث) بدون رد من ${new URL(url).hostname}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

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
const EMPTY_STORE = { gmMessages: [], gmDisplayLog: [], deptLogs: {}, dailyBriefing: null, secretaryBriefing: null, competitorReport: null, archive: {}, priceHistory: [] };

async function loadStoreRemote() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const res = await fetchWithTimeout(`${UPSTASH_URL}/get/${STORE_KEY}`, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
    const data = await res.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch {
    return null;
  }
}

function saveStoreRemote(storeObj) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(storeObj, null, 2), "utf8"); // local fallback
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  fetchWithTimeout(`${UPSTASH_URL}/set/${STORE_KEY}`, {
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
عند الطلب منك صياغة فاتورة رسمية، أخرجها كنص منظم جاهز للنسخ مباشرة، بالتنسيق التالي بالضبط (املأ الحقول المتاحة لديك من السياق، واترك أي حقل غير متوفر بوضوح كـ"[يُستكمل]" بدل اختلاقه):

فاتورة — Loop Travel & Tourism
رقم الفاتورة: [يُستكمل]
التاريخ: [يُستكمل]
------------------------------
بيانات العميل:
الاسم:
جهة الاتصال:
------------------------------
البنود:
الوصف | الكمية | سعر الوحدة | الإجمالي
------------------------------
الإجمالي الفرعي:
الضريبة/الرسوم (إن وجدت):
الإجمالي الكلي:
------------------------------
طريقة الدفع:
ملاحظات:
------------------------------
Loop Travel & Tourism | واتساب: +971 54 544 4003

أجب كرئيس محاسبة فعلي، بأرقام محددة حين تتوفر، بالعربية، بإيجاز تنفيذي (فقرة أو فقرتين) في الردود العادية، وبالتنسيق الكامل أعلاه فقط عند طلب فاتورة تحديدًا.`,
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
تقدر ترسل بريدًا إلكترونيًا فعليًا نيابة عن نواف باستخدام أداة send_email — استخدمها فقط عندما يطلب صراحة إرسال بريد، وبعنوان بريد ذكره هو بوضوح؛ لا ترسل بريدًا من تلقاء نفسك ولا لعنوان لم يُذكر لك.
تقدر أيضًا تطّلع على بريده الإلكتروني (Outlook) باستخدام أداة check_email — استخدمها عندما يسألك عن بريده، أو عن عروض/إعلانات جديدة من شركات نتعامل معها، وأبرز له أي عرض يستحق الانتباه.
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
  const res = await fetchWithTimeout("https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD,SOLUSD,ATOMUSD,XLMUSD,DOGEUSD,SUIUSD,FETUSD,PAXGUSD");
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

const TOOLS = [
  ...Object.entries(DEPTS).map(([id, d]) => ({
    name: `consult_${id}`,
    description: `تكليف ${d.role} في Loop Travel بمهمة أو سؤال يقع ضمن مسؤولياته.`,
    input_schema: {
      type: "object",
      properties: { instruction: { type: "string", description: "الأمر أو السؤال الموجّه لرئيس هذا القسم." } },
      required: ["instruction"],
    },
  })),
  {
    name: "get_archived_day",
    description: "استرجاع إحاطة الصباح و/أو تقرير المنافسين و/أو إحاطة السكرتير الشخصية ليوم سابق محدد بالتاريخ، عندما يسأل نواف عن يوم معيّن قبل اليوم الحالي.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "التاريخ المطلوب بصيغة YYYY-M-D (مثال: 2026-9-5 ليوم 5 سبتمبر 2026)." },
      },
      required: ["date"],
    },
  },
  {
    name: "record_price_point",
    description: "تسجيل نقطة بيانات هذا الشهر برسم مقارنة أسعار العمرة (متوسط سعرنا ومتوسط سعر المنافسين). استخدمها فقط بعد استشارة القسم المالي وقسم الاستراتيجية فعليًا للحصول على الرقمين، لا تستخدمها برقم مخمّن.",
    input_schema: {
      type: "object",
      properties: {
        ourAvg: { type: "number", description: "متوسط سعر باقاتنا للعمرة للشخص الواحد هذا الشهر بالدرهم، كما أفاد به القسم المالي." },
        competitorAvg: { type: "number", description: "متوسط سعر باقات العمرة عند المنافسين للشخص الواحد هذا الشهر بالدرهم، كما أفاد به قسم الاستراتيجية." },
      },
      required: ["ourAvg", "competitorAvg"],
    },
  },
  {
    name: "send_email",
    description: "إرسال بريد إلكتروني فعلي نيابة عن نواف لشخص محدد. استخدمها فقط عندما يطلب نواف صراحة إرسال بريد، وبعنوان بريد صريح ذكره هو — لا ترسل بريدًا لعنوان لم يُذكر لك صراحة، ولا ترسله بدون طلب واضح.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "عنوان البريد الإلكتروني للمستلم، كما ذكره نواف صراحة." },
        subject: { type: "string", description: "عنوان الرسالة." },
        body: { type: "string", description: "نص الرسالة الكامل." },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "check_email",
    description: "الاطلاع على أحدث رسائل بريد نواف الإلكتروني (Outlook) — خصوصًا للبحث عن عروض أو إعلانات من الشركات التي نتعامل معها. استخدمها عندما يسألك نواف عن بريده أو عن عروض جديدة من موردين/شركاء، أو ضمن الإحاطة الصباحية.",
    input_schema: {
      type: "object",
      properties: {
        count: { type: "number", description: "عدد أحدث الرسائل المطلوب استعراضها. افتراضيًا 10." },
      },
    },
  },
];


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
  const res = await anthropic.messages.create(
    { model: MODEL, max_tokens: 1000, system, messages, ...(tools ? { tools } : {}) },
    { timeout: 60000 }
  );
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
  const res = await fetchWithTimeout(url.toString());
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
    const res = await fetchWithTimeout(
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
    const imgRes = await fetchWithTimeout(imageUrl);
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

// ---------------------------------------------------------------------------
// Outlook email reading — OAuth2 with Microsoft Graph, so the GM can check
// Nawaf's inbox for supplier/partner announcements. A one-time login grants
// a refresh token, stored persistently, used to fetch new access tokens
// without asking him to log in again.
// ---------------------------------------------------------------------------
const OUTLOOK_CLIENT_ID = process.env.OUTLOOK_CLIENT_ID;
const OUTLOOK_CLIENT_SECRET = process.env.OUTLOOK_CLIENT_SECRET;
const OUTLOOK_REDIRECT_URI = process.env.OUTLOOK_REDIRECT_URI || "https://loop-gm-server-1.onrender.com/auth/outlook/callback";
const OUTLOOK_SCOPES = "offline_access Mail.Read Mail.Send User.Read";

async function outlookTokenRequest(params) {
  const res = await fetchWithTimeout("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || "OAuth token request failed");
  return data;
}

async function getOutlookAccessToken() {
  if (!store.outlookRefreshToken) throw new Error("Outlook غير مربوط بعد — لازم تسجّل دخول من الرابط أولًا.");
  const data = await outlookTokenRequest({
    client_id: OUTLOOK_CLIENT_ID,
    client_secret: OUTLOOK_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: store.outlookRefreshToken,
    scope: OUTLOOK_SCOPES,
  });
  if (data.refresh_token) {
    store.outlookRefreshToken = data.refresh_token; // Microsoft sometimes rotates it
    saveStore(store);
  }
  return data.access_token;
}

async function fetchRecentEmails(count = 10) {
  const accessToken = await getOutlookAccessToken();
  const url = `https://graph.microsoft.com/v1.0/me/messages?$top=${count}&$select=subject,from,receivedDateTime,bodyPreview&$orderby=receivedDateTime desc`;
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "تعذر جلب البريد");
  return (data.value || []).map((m) => ({
    from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || "غير معروف",
    subject: m.subject || "(بدون عنوان)",
    preview: (m.bodyPreview || "").slice(0, 200),
    receivedAt: m.receivedDateTime,
  }));
}

async function sendOutlookEmail({ to, subject, body }) {
  const accessToken = await getOutlookAccessToken();
  const res = await fetchWithTimeout("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "HTML", content: toEmailHtml(body) },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: true,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`(${res.status}) ${detail.slice(0, 200)}`);
  }
}


// Real email sending via Resend — a free transactional email API (no
// credit card, 3,000/month). Without RESEND_API_KEY set, the tool reports
// that email isn't configured yet instead of silently failing.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || "Loop Travel <onboarding@resend.dev>";

const LOGO_PUBLIC_URL = "https://loop-gm-server-1.onrender.com/assets/logo.png";
const EMAIL_SIGNATURE_HTML = `
<div style="margin-top:24px;padding-top:16px;border-top:1px solid #E5E0DC;font-family:Arial,sans-serif;">
  <img src="${LOGO_PUBLIC_URL}" alt="Loop Travel & Tourism" style="height:40px;display:block;margin-bottom:8px;" />
  <div style="font-size:13px;color:#333;font-weight:bold;">Nawaf</div>
  <div style="font-size:12px;color:#666;">Founder</div>
  <div style="font-size:12px;color:#666;margin-top:4px;">وكالة سفريات وسياحة — الإمارات العربية المتحدة</div>
  <div style="font-size:12px;color:#666;">واتساب: +971 54 544 4003</div>
</div>`;

function toEmailHtml(bodyText) {
  const escaped = String(bodyText || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;white-space:pre-wrap;">${escaped}</div>${EMAIL_SIGNATURE_HTML}`;
}

async function sendEmail({ to, subject, body }) {
  // Prefer Outlook — sends from Nawaf's real connected address instead of a
  // generic/unverified one. Falls back to Resend only if Outlook isn't
  // connected or its send attempt fails.
  if (store.outlookRefreshToken) {
    try {
      await sendOutlookEmail({ to, subject, body });
      return { ok: true, message: `تم إرسال البريد إلى ${to} بنجاح عبر Outlook.` };
    } catch (e) {
      if (!RESEND_API_KEY) return { ok: false, message: `فشل الإرسال عبر Outlook: ${e.message}` };
      // fall through to Resend below
    }
  }

  if (!RESEND_API_KEY) {
    return { ok: false, message: "البريد الإلكتروني غير مفعّل بعد — اربط Outlook أو أضف RESEND_API_KEY." };
  }
  try {
    const res = await fetchWithTimeout("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [to],
        subject,
        text: body,
        html: toEmailHtml(body),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, message: `فشل الإرسال (${res.status}): ${detail.slice(0, 200)}` };
    }
    return { ok: true, message: `تم إرسال البريد إلى ${to} بنجاح عبر Resend.` };
  } catch (e) {
    return { ok: false, message: `تعذر الإرسال: ${e.message}` };
  }
}

async function callDepartment(deptId, instruction, images) {
  const dept = DEPTS[deptId];
  let systemText = dept.system;
  if (dept.sheetUrl) {
    try {
      const res = await fetchWithTimeout(dept.sheetUrl);
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
    const imgList = images ? (Array.isArray(images) ? images : [images]) : [];
    const content = imgList.length
      ? [
          ...imgList.map((img) => ({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } })),
          { type: "text", text: instruction || "افحص هذه الصور (فاتورة أو مستند) واستخرج ما تحتاجه لعملك منها." },
        ]
      : instruction;
    const res = await callClaude({ system: systemText, messages: [{ role: "user", content }] });
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

// Trimming to the last N messages can accidentally cut right between an
// assistant's tool_use and the user-role tool_result that must immediately
// follow it — Claude rejects a tool_result with no matching tool_use before
// it. Drop any such orphaned leading tool_result after slicing.
function trimMessages(messages, maxCount) {
  let trimmed = messages.slice(-maxCount);
  while (trimmed.length && Array.isArray(trimmed[0].content) && trimmed[0].content.some((b) => b.type === "tool_result")) {
    trimmed = trimmed.slice(1);
  }
  return trimmed;
}

async function runGM(userText, displayText, images) {
  const imgList = images ? (Array.isArray(images) ? images : [images]) : [];
  const userContent = imgList.length
    ? [
        ...imgList.map((img) => ({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } })),
        { type: "text", text: userText || "صف هذه الصور ووضّح لي ما تفهمه منها، واسألني إن احتجت توضيحًا." },
      ]
    : userText;
  let messages = [...trimMessages(store.gmMessages, 16), { role: "user", content: userContent }];
  let finalText = null;
  let consultedAll = [];

  // Today's already-prepared material, so asking "what's the briefing?" from a
  // second device returns what was actually sent this morning instead of
  // silently regenerating a different one.
  let system = GM_SYSTEM;
  system += `\n\nتاريخ اليوم بصيغة YYYY-M-D هو: ${todayKey()}. إذا سألك نواف عن يوم سابق (أمس، الأسبوع اللي فات، أو تاريخ محدد)، احسب التاريخ المطلوب بصيغة YYYY-M-D واستخدم أداة get_archived_day لجلبه — لا تعتمد على ذاكرتك من المحادثة الحالية وحدها لأيام سابقة.`;
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
      let responseText;
      if (tu.name === "get_archived_day") {
        const date = (tu.input?.date || "").trim();
        const day = store.archive?.[date];
        if (!day) {
          responseText = `لا يوجد أرشيف محفوظ لتاريخ ${date}. الأرشيف يبدأ من اليوم الذي فُعّل فيه هذا النظام؛ أي تاريخ قبل ذلك غير متاح.`;
        } else {
          const parts = [];
          if (day.dailyBriefing) parts.push(`إحاطة الصباح (${date}):\n${day.dailyBriefing.text}`);
          if (day.competitorReport) parts.push(`تقرير المنافسين (${date}):\n${day.competitorReport.text}`);
          if (day.secretaryBriefing) parts.push(`الإحاطة الشخصية (${date}):\n${day.secretaryBriefing.text}`);
          responseText = parts.join("\n\n---\n\n");
        }
      } else if (tu.name === "record_price_point") {
        const { ourAvg, competitorAvg } = tu.input || {};
        if (typeof ourAvg !== "number" || typeof competitorAvg !== "number") {
          responseText = "لم يتم التسجيل — يلزم تمرير ourAvg و competitorAvg كأرقام صالحة.";
        } else {
          if (!store.priceHistory) store.priceHistory = [];
          const key = monthKey();
          const point = { month: key, ourAvg, competitorAvg, ts: Date.now() };
          const idx = store.priceHistory.findIndex((p) => p.month === key);
          if (idx >= 0) store.priceHistory[idx] = point; else store.priceHistory.push(point);
          store.priceHistory.sort((a, b) => a.month.localeCompare(b.month));
          saveStore(store);
          responseText = `تم تسجيل نقطة شهر ${key}: سعرنا ${ourAvg}، متوسط المنافسين ${competitorAvg}.`;
        }
      } else if (tu.name === "send_email") {
        const { to, subject, body } = tu.input || {};
        if (!to || !subject || !body) {
          responseText = "لم يُرسل البريد — الحقول to وsubject وbody مطلوبة كلها.";
        } else {
          const result = await sendEmail({ to, subject, body });
          responseText = result.message;
        }
      } else if (tu.name === "check_email") {
        try {
          const emails = await fetchRecentEmails(tu.input?.count || 10);
          responseText = emails.length
            ? emails.map((m) => `- من: ${m.from} | الموضوع: ${m.subject} | ${new Date(m.receivedAt).toLocaleString("ar-AE")}\n  ${m.preview}`).join("\n\n")
            : "لا توجد رسائل حديثة.";
        } catch (e) {
          responseText = `تعذر الوصول للبريد: ${e.message}`;
        }
      } else {
        const deptId = tu.name.replace("consult_", "");
        const instruction = tu.input?.instruction || "";
        responseText = await callDepartment(deptId, instruction);
        appendDeptLog(deptId, instruction, responseText);
        consultedAll.push(deptId);
      }
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: responseText });
    }
    messages = [...messages, { role: "user", content: toolResults }];
  }

  // Keep the image out of persisted history — it already did its job this
  // turn, and re-sending it on every future request would bloat storage and
  // the context sent to Claude for no benefit.
  store.gmMessages = trimMessages(messages, 16).map((m) => {
    if (!Array.isArray(m.content)) return m;
    return { ...m, content: m.content.map((b) => (b.type === "image" ? { type: "text", text: "[صورة أرسلها نواف سابقًا]" } : b)) };
  });
  const reply = finalText || "تم تنفيذ طلبك.";
  const depts = [...new Set(consultedAll)];
  store.gmDisplayLog.push({ role: "user", text: displayText || userText || "📎 صورة", ts: Date.now() });
  store.gmDisplayLog.push({ role: "gm", text: reply, depts, ts: Date.now() });
  store.gmDisplayLog = store.gmDisplayLog.slice(-100);
  saveStore(store);
  return { reply, depts };
}

// ---------------------------------------------------------------------------
// Monthly price-comparison chart — one data point per month: our average
// Umrah package price (computed directly from the pricing sheet) vs the
// average competitor Umrah price (asked from the strategy department, based
// on whatever competitor data it currently has).
// ---------------------------------------------------------------------------
function parseCsvLine(line) {
  const cells = [];
  let cur = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === "," && !inQuotes) { cells.push(cur); cur = ""; continue; }
    cur += ch;
  }
  cells.push(cur);
  return cells;
}

async function computeOwnUmrahAveragePrice() {
  const res = await fetchWithTimeout(DEPTS.finance.sheetUrl);
  if (!res.ok) throw new Error("تعذر قراءة شيت الأسعار");
  const lines = (await res.text()).split("\n").filter((l) => l.trim());
  if (lines.length < 2) throw new Error("الشيت فارغ");
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const typeIdx = header.findIndex((h) => h === "Type");
  const priceIdx = header.findIndex((h) => h.includes("سعر شخصين"));
  if (typeIdx === -1 || priceIdx === -1) throw new Error("تعذر إيجاد أعمدة النوع أو السعر بالشيت");

  const prices = [];
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const type = (cells[typeIdx] || "").trim();
    if (!type.includes("عمرة")) continue;
    const price = parseFloat((cells[priceIdx] || "").replace(/[^\d.]/g, ""));
    if (!isNaN(price) && price > 0) prices.push(price);
  }
  if (!prices.length) throw new Error("لا توجد باقات عمرة مسعّرة بالشيت حاليًا");
  return prices.reduce((a, b) => a + b, 0) / prices.length;
}

async function computeCompetitorUmrahAveragePrice() {
  const reply = await callDepartment(
    "strategy",
    "بناءً على أحدث بيانات المنافسين المتوفرة لديك (منشوراتهم وقراءة الأسعار من صورهم)، ما هو متوسط سعر باقة عمرة للشخص الواحد بالدرهم الإماراتي عند المنافسين حاليًا؟ أجب برقم واحد فقط بدون أي نص أو رمز عملة أو شرح، مثال: 2150"
  );
  const match = (reply || "").match(/[\d,]+(\.\d+)?/);
  if (!match) return null;
  const num = parseFloat(match[0].replace(/,/g, ""));
  return isNaN(num) ? null : num;
}

function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

async function generateMonthlyPricePoint() {
  // The GM performs this itself — consults finance and strategy for real
  // numbers, then records them via the record_price_point tool — instead of
  // the server silently computing it behind the scenes.
  const result = await runGM(
    "سجّل نقطة بيانات هذا الشهر لرسم مقارنة أسعار العمرة. استشر القسم المالي ليعطيك متوسط سعر باقاتنا للعمرة للشخص الواحد هذا الشهر، واستشر قسم الاستراتيجية ليعطيك متوسط سعر باقات العمرة عند المنافسين للشخص الواحد هذا الشهر. بعد استلام الرقمين الفعليين من القسمين، استخدم أداة record_price_point لتسجيلهما. لا تسجّل أي رقم لم يصلك من القسمين فعليًا.",
    "تحديث رسم أسعار العمرة الشهري"
  );
  if (!store.priceHistory) store.priceHistory = [];
  const key = monthKey();
  const point = store.priceHistory.find((p) => p.month === key) || null;
  return point || { month: key, ourAvg: null, competitorAvg: null, ts: Date.now(), note: result.reply };
}

// Archive — each day's briefing/report is kept under its own dated key
// instead of overwriting the previous day's, so the GM can actually look
// back at a specific past date instead of only ever seeing "today".
function archiveEntry(kind, entry) {
  if (!store.archive) store.archive = {};
  if (!store.archive[entry.day]) store.archive[entry.day] = {};
  store.archive[entry.day][kind] = entry;
}

async function generateDailyBriefing() {
  // The GM writes the briefing itself (so it lands in the GM conversation and
  // stays in its memory), grounded in the competitor report the strategy
  // department produced earlier in the same morning run.
  let prompt = "اكتب لنواف إحاطته الصباحية التنفيذية عن وضع الشركة اليوم. نسّق مع الأقسام حسب الحاجة، وأبرز ما يستحق انتباهه الآن. إن كان بريده الإلكتروني مربوطًا، تحقق منه بأداة check_email وأبرز أي عرض أو إعلان مهم وصل من شركات نتعامل معها.";
  if (store.competitorReport?.day === todayKey()) {
    prompt += `\n\nهذا تقرير المنافسين الذي أعدّه قسم الاستراتيجية صباح اليوم — ادمج أهم ما فيه في إحاطتك بصفتك مطّلعًا عليه، ولا تكرره حرفيًا:\n${store.competitorReport.text}`;
  }
  const result = await runGM(prompt, "إحاطة الصباح");
  store.dailyBriefing = { text: result.reply, depts: result.depts, ts: Date.now(), day: todayKey() };
  archiveEntry("dailyBriefing", store.dailyBriefing);
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
  archiveEntry("competitorReport", store.competitorReport);
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
  archiveEntry("secretaryBriefing", store.secretaryBriefing);
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

// One-time Outlook login flow. Nawaf visits /auth/outlook/start once, signs
// in with Microsoft, and this callback exchanges the resulting code for a
// refresh token stored persistently — no further logins needed after that.
app.get("/auth/outlook/start", (req, res) => {
  if (!OUTLOOK_CLIENT_ID) return res.status(500).send("OUTLOOK_CLIENT_ID غير مضاف بعد على السيرفر.");
  const url = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  url.searchParams.set("client_id", OUTLOOK_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", OUTLOOK_REDIRECT_URI);
  url.searchParams.set("scope", OUTLOOK_SCOPES);
  url.searchParams.set("response_mode", "query");
  res.redirect(url.toString());
});

app.get("/auth/outlook/callback", async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error) return res.status(400).send(`<div dir="rtl" style="font-family:sans-serif;padding:40px;">تعذر الربط: ${error_description || error}</div>`);
  try {
    const data = await outlookTokenRequest({
      client_id: OUTLOOK_CLIENT_ID,
      client_secret: OUTLOOK_CLIENT_SECRET,
      grant_type: "authorization_code",
      code: code,
      redirect_uri: OUTLOOK_REDIRECT_URI,
      scope: OUTLOOK_SCOPES,
    });
    store.outlookRefreshToken = data.refresh_token;
    saveStore(store);
    res.send(`<div dir="rtl" style="font-family:sans-serif;padding:40px;text-align:center;">✅ تم ربط بريدك بنجاح. ارجع للمنصة وجرّب تسأل المدير العام عن بريدك.</div>`);
  } catch (e) {
    res.status(500).send(`<div dir="rtl" style="font-family:sans-serif;padding:40px;">فشل الربط: ${e.message}</div>`);
  }
});

// A real, live Privacy Policy page — Meta requires this URL before an app
// can go Live and before App Review will accept a submission.
// Loop's logo, served from the server itself so it has a stable public URL
// usable as an <img src> in HTML email signatures.
const LOGO_BASE64 = "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";
app.get("/assets/logo.png", (req, res) => {
  res.set("Content-Type", "image/png");
  res.set("Cache-Control", "public, max-age=86400");
  res.send(Buffer.from(LOGO_BASE64, "base64"));
});

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
    priceHistory: store.priceHistory || [],
  });
});

// All state-changing actions are exposed as GET with query params (not
// conventional REST, but GET requests have proven reliable end-to-end while
// POST consistently failed from the browser on this host — see chat-test).
// ---------------------------------------------------------------------------
// Async job pattern — every browser-facing request now returns *instantly*
// with a job id; the slow work (Claude calls) runs in the background and the
// frontend polls a fast status endpoint until it's done. This exists because
// long-lived fetchWithTimeout() calls from the browser to this host were failing
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

// POST variant that carries an image — GET/query-string can't hold a base64
// photo, so this exists alongside the plain-text GET route above.
app.post("/api/chat-image", async (req, res) => {
  const message = (req.body?.message || "").toString().trim();
  const images = req.body?.images || (req.body?.image ? [req.body.image] : []);
  if (!images.length || images.some((img) => !img?.data || !img?.mediaType)) {
    return res.status(400).json({ error: "at least one valid image is required" });
  }
  const id = startJob(() => runGM(message, message || `📎 ${images.length > 1 ? images.length + " صور" : "صورة"}`, images));
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

// POST variant that carries an image (e.g. an invoice or ID card) to a
// specific department.
app.post("/api/department/:id/image", async (req, res) => {
  const { id } = req.params;
  const message = (req.body?.message || "").toString().trim();
  const images = req.body?.images || (req.body?.image ? [req.body.image] : []);
  if (!DEPTS[id]) return res.status(404).json({ error: "unknown department" });
  if (!images.length || images.some((img) => !img?.data || !img?.mediaType)) {
    return res.status(400).json({ error: "at least one valid image is required" });
  }
  const jobId = startJob(async () => {
    const responseText = await callDepartment(id, message, images);
    appendDeptLog(id, message || `📎 ${images.length > 1 ? images.length + " صور" : "صورة"}`, responseText);
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

app.get("/api/price-history/refresh", (req, res) => {
  const jobId = startJob(() => generateMonthlyPricePoint());
  res.json({ jobId });
});

app.get("/api/reset", (req, res) => {
  store = { gmMessages: [], gmDisplayLog: [], deptLogs: {}, dailyBriefing: null, secretaryBriefing: null, competitorReport: null, archive: {}, priceHistory: [] };
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
  if (new Date().getDate() === 1) {
    console.log("[cron] generating monthly price point…");
    try { await generateMonthlyPricePoint(); } catch (e) { console.error("[cron] price point failed:", e.message); }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Loop GM server running on port ${PORT}`));
