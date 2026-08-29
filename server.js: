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
// Storage — simple JSON file on disk. Good enough for one company's data.
// On some free hosts the disk resets on redeploy; swap this for a real DB
// (e.g. a free Supabase/Postgres instance) once this proves itself out.
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { gmMessages: [], gmDisplayLog: [], deptLogs: {}, dailyBriefing: null, secretaryBriefing: null };
  }
}
function saveStore(store) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), "utf8");
}
let store = loadStore();

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
    sheetUrl: null, sheetColumns: null,
    system: `أنت رئيس قسم الاستراتيجية في Loop Travel & Tourism. ${LOOP_CONTEXT}
أنت عضو فعلي من فريق Loop، تتحدث بصيغة "نحن" لا "أنتم"، وتقدّم تقاريرك مباشرة للمدير العام.
مسؤوليتك: خطط النمو والتوسع، الشراكات، تحليل المنافسين والسوق، وأولويات المشروع على المدى المتوسط والبعيد.
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
};

const GM_SYSTEM = `أنت المدير العام لشركة Loop Travel & Tourism — عضو فعلي من فريق قيادة الشركة، ورئيس نواف المباشر في هرمها الإداري، وليس مستشارًا خارجيًا أو طرفًا ثالثًا. أنت جزء من الشركة، فتحدّث عنها دائمًا بصيغة "نحن" — ممنوع منعًا باتًا استخدام "أنتم". أنت أيضًا مساعد نواف الشخصي — تجاوبه على أي سؤال عام مباشرة بمعرفتك العامة دون استخدام أي أداة.
${LOOP_CONTEXT}
عندما يطلب منك نواف تحديثًا أو استشارة تخص الشركة وتحتاج خبرة قسم معين (المالية، التسويق، الاستراتيجية، الاتصال)، استخدم أداة الاستشارة الخاصة بذلك القسم، ويمكنك استشارة أكثر من قسم بنفس الرسالة. بعد استلام ردود الأقسام، لخّصها بأسلوب تنفيذي واضح ومباشر، وادمجها في توصية واحدة متماسكة — وأنت من يملك القرار النهائي بصفتك المدير العام.
لا تختلق أرقامًا أو حقائق عن الشركة؛ إن لم تكن المعلومة متوفرة، وضّح ذلك. تحدث بالعربية دائمًا.
مهم جدًا: ردّك النهائي يجب أن يبدأ مباشرة بالمعلومة أو التوصية نفسها — بدون أي مقدمة تشرح خطواتك أو تسرد أنك استشرت قسمًا معينًا.`;

const SECRETARY_SYSTEM = `أنت السكرتير الشخصي لنواف داخل منصة Loop. مهمتك الوحيدة صباح كل يوم: تجهيز إحاطة صباحية شخصية لا علاقة لها بأعمال الشركة.
نفّذ الخطوات التالية باستخدام أداة البحث على الإنترنت (web_search):
1. سعر البيتكوين الحالي (BTC/USD) ونسبة تغيره خلال 24 ساعة.
2. سعر الذهب الحالي (XAU/USD للأونصة) وتغيره اليومي.
3. سعر النفط الحالي (خام WTI، دولار للبرميل) وتغيره اليومي.
4. محفظة نواف: ETH 0.1866579 (تكلفة 2319.68)، SOL 4.49919209 (84.2080)، ATOM 196.52547694 (1.3853)، XLM 1555.19247268 (0.17510)، FET 1839.18182198 (0.14800)، SUI 243.6238336 (1.0932)، DOGE 962.56531898 (0.10960). احسب نسبة ربح/خسارة إجمالية واحدة فقط، بدون تفاصيل كل عملة.
5. اليوم في الخليج (UTC+4): سبت/أحد → رأس الخيمة، غير ذلك → أبوظبي.
6. طقس تلك المدينة اليوم: أعلى/أقل حرارة، الحالة، احتمال الأمطار.
7. أجب مباشرة بالشكل التالي بالضبط، بدون أي مقدمة أو سرد لخطوات البحث:

صباح الخير ☀️

**بيتكوين:** $[السعر] ([+/-X.XX]% خلال 24 ساعة)

**الذهب:** $[السعر]/أونصة ([+/-X.XX]%)

**النفط (WTI):** $[السعر]/برميل ([+/-X.XX]%)

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

async function runGM(userText) {
  let messages = [...store.gmMessages.slice(-16), { role: "user", content: userText }];
  let finalText = null;
  let consultedAll = [];

  for (let round = 0; round < 3 && finalText === null; round++) {
    const res = await callClaude({ system: GM_SYSTEM, messages, tools: TOOLS });
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
  store.gmDisplayLog.push({ role: "user", text: userText, ts: Date.now() });
  store.gmDisplayLog.push({ role: "gm", text: reply, depts, ts: Date.now() });
  store.gmDisplayLog = store.gmDisplayLog.slice(-100);
  saveStore(store);
  return { reply, depts };
}

async function generateDailyBriefing() {
  const result = await runGM("قدّم لي إحاطة صباحية تنفيذية عن وضع الشركة اليوم، بالتنسيق مع الأقسام الأربعة حسب الحاجة، وأبرز ما يستحق انتباهي الآن.");
  store.dailyBriefing = { text: result.reply, depts: result.depts, ts: Date.now(), day: todayKey() };
  saveStore(store);
  return store.dailyBriefing;
}

async function generateSecretaryBriefing() {
  const res = await callClaude({
    system: SECRETARY_SYSTEM,
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
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));
app.use(express.json());

app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get("/api/state", (req, res) => {
  res.json({
    gmDisplayLog: store.gmDisplayLog,
    deptLogs: store.deptLogs,
    dailyBriefing: store.dailyBriefing,
    secretaryBriefing: store.secretaryBriefing,
  });
});

app.post("/api/chat", async (req, res) => {
  const message = (req.body?.message || "").trim();
  if (!message) return res.status(400).json({ error: "message is required" });
  try {
    const result = await runGM(message);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message || "internal error" });
  }
});

app.post("/api/department/:id", async (req, res) => {
  const { id } = req.params;
  const message = (req.body?.message || "").trim();
  if (!DEPTS[id]) return res.status(404).json({ error: "unknown department" });
  if (!message) return res.status(400).json({ error: "message is required" });
  try {
    const responseText = await callDepartment(id, message);
    appendDeptLog(id, message, responseText);
    res.json({ reply: responseText });
  } catch (e) {
    res.status(500).json({ error: e.message || "internal error" });
  }
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

app.post("/api/briefing/daily/refresh", async (req, res) => {
  try {
    res.json(await generateDailyBriefing());
  } catch (e) {
    res.status(500).json({ error: e.message || "internal error" });
  }
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

app.post("/api/briefing/secretary/refresh", async (req, res) => {
  try {
    res.json(await generateSecretaryBriefing());
  } catch (e) {
    res.status(500).json({ error: e.message || "internal error" });
  }
});

app.post("/api/reset", (req, res) => {
  store = { gmMessages: [], gmDisplayLog: [], deptLogs: {}, dailyBriefing: null, secretaryBriefing: null };
  saveStore(store);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Scheduled jobs — this is the actual "runs while you're asleep" part.
// 3:00 UTC = 7:00 AM Gulf Standard Time (UTC+4).
// ---------------------------------------------------------------------------
cron.schedule("0 3 * * *", async () => {
  console.log("[cron] generating daily briefing…");
  try { await generateDailyBriefing(); } catch (e) { console.error("[cron] daily briefing failed:", e.message); }
  console.log("[cron] generating secretary briefing…");
  try { await generateSecretaryBriefing(); } catch (e) { console.error("[cron] secretary briefing failed:", e.message); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Loop GM server running on port ${PORT}`));
