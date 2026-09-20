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
        body: { type: "string", description: "نص الرسالة الكامل. اكتبه بفقرات منظمة، وافصل بين كل فقرة والتي بعدها بسطر فارغ تمامًا (سطرين جديدين متتاليين)، بحيث تظهر مرتبة وسهلة القراءة — لا تكتبها كتلة نص واحدة متصلة." },
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
  <div style="font-size:13px;color:#333;font-weight:bold;">Nawaf Alzaabi</div>
  <div style="font-size:12px;color:#666;">Founder</div>
  <div style="font-size:12px;color:#666;margin-top:4px;">Travel & Tourism Agency — United Arab Emirates</div>
  <div style="font-size:12px;color:#666;">WhatsApp: +971 54 544 4003</div>
</div>`;

function toEmailHtml(bodyText) {
  // Real <p>/<br> tags instead of relying on CSS white-space — some webmail
  // clients (Outlook.com's reader included) don't reliably honor pre-wrap,
  // but literal paragraph/line-break tags always render correctly.
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const paragraphs = String(bodyText || "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 14px;">${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.6;">${paragraphs}</div>${EMAIL_SIGNATURE_HTML}`;
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
