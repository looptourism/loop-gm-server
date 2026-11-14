# Trading Desk — news, fundamentals and earnings: provider proposal (Stage 3)

**Decision (2026-11-13): Option A.** Terms of Service read and accepted by the owner (2026-11-14).

## What is built (2026-11-14)

| Piece | What it does | Confirmed by a real call? |
|---|---|---|
| Provider layer | One interface; `DATA_PROVIDERS` in `trading/config.js` names the provider per capability | — |
| Finnhub — stocks | Profile, fundamentals, earnings, company news | **Yes** (22 stocks, see below) |
| Finnhub — crypto | General crypto headlines (not per coin) | **Yes** (92 articles, 2026-11-14) |
| CoinGecko — crypto | Market cap, rank, supply, volume for the 9 coins | **Yes** — all 9 coins fully covered in the real coverage run (2026-11-14 09:19 UTC, 9 calls in 24 s); the hand-written coin IDs, including FET, passed the ticker check |
| SEC EDGAR — stocks | Official filings with dates and links: the last 2 annual, 4 quarterly and 15 current reports | **Yes** — filings stored for all 21 monitored stocks with no problems (2026-11-14); the list contents were inspected for MSTR only |
| Research job | Stores all of the above on a schedule; agents will read only the stored rows | **Yes** — two manual runs on 2026-11-14 (09:14 and 09:22 UTC), 30 instruments, no problems: 93 research rows and 2,488 news articles stored; the second run added only what had changed. Runs triggered by the schedule itself have not been observed yet |

Schedule (runs only when `TRADING_MONITOR_ENABLED` is `true`, the same switch as price
monitoring): profile, fundamentals, earnings and filings once a day; news every 6 hours.
Per day: about 180 Finnhub calls (ceiling 40/minute; limit 60), 9 CoinGecko calls (about 270
a month of the 10,000 allowed), about 45 SEC calls (ceiling 60/minute; limit 10/second).
An answer identical to the stored one adds no row — only its "last confirmed" time moves.

## Steps to finish the setup (phone)

1. **Merge** the branch on GitHub and wait for Render to deploy.
2. **CoinGecko key:** coingecko.com → API → create a free Demo account → copy the key. In
   Render → **loop-gm-server-1** → **Environment**, add `COINGECKO_API_KEY`.
3. **SEC identification:** the SEC requires every program to say who is calling. In Render add
   `SEC_USER_AGENT` with your name and an email of your choice, e.g. `Your Name you@example.com`.
   It is sent only to sec.gov. Without it the SEC part stays off; everything else works.
4. **Save, rebuild, and deploy.**
5. Log in to the console, then open `/api/trading/admin/migrate?confirm=003_research` (adds the two tables for research data).
6. `/api/trading/providers/status` — every line should show `"usable": true`.
7. `/api/trading/providers/test?symbol=BTC&class=crypto` — **send me the output** (first real CoinGecko and crypto-news call).
8. `/api/trading/providers/test?symbol=MSTR` — **send me the `filings` part** (first real SEC call).
9. `/api/trading/providers/coverage?class=crypto&start=yes`, wait a minute, then
   `/api/trading/providers/coverage?class=crypto` — coverage of the 9 coins.
10. `/api/trading/research/run?confirm=yes&all=yes`, wait about 5 minutes, then
    `/api/trading/research/status` — **send me the output**: it shows what was stored and every problem.
11. `/api/trading/research/view?symbol=MSTR` — exactly what an agent will be given.

## Limitations

1. CoinGecko, SEC EDGAR and Finnhub's crypto headlines are not confirmed by a real call yet;
   their documentation could not be opened from the coding session. Steps 7–8 are the proof.
2. The coin-ID mapping for CoinGecko is written by hand (e.g. FET → `fetch-ai`). If CoinGecko
   returns a different ticker for an ID, the answer is refused and reported — not stored.
3. SEC EDGAR gives the list of filings with links, not the figures inside them. Financial
   figures come from Finnhub (a secondary source).
4. NVO and WYFI have no upcoming earnings date on Finnhub; it is stored as unknown.
5. News is stored as the provider returns it; whether an article is really about the company
   is not checked. Crypto news is general, not per coin.
6. Estimated storage: roughly 100 MB a year for research data, on top of price snapshots.

**Coverage result (real run on the Render server, 2026-11-14 08:30 UTC, Finnhub free key):**
all 22 stocks checked, 110 calls in 2 min 44 s, no errors and no rate limiting.
- **Fully covered (20):** MSTR, BABA, ADBE, ORCL, NKE, TTD, HIMS, NEM, INTU, GRAB, TMDX, PLAB,
  VISN, SE, AMPX, GRRR, MRAM, ENPH, INOD, OPTT.
- **Gaps (2):** NVO and WYFI — profile, fundamentals, past earnings and news are there, but
  Finnhub's calendar has no upcoming earnings date for them in the next 120 days.
- The adapter's paths and field names are confirmed by these real answers.
- What the test does NOT show: whether the figures are correct, or whether the news articles
  are really about the company. It measures presence only.
- Still open: Check 1 below (reading the Terms of Service).

## Check 1 — Finnhub's free terms (personal investing)

What could be established without opening finnhub.io (it stayed unreachable from the coding
session; these are search-result snippets of Finnhub's own pages, 2026-11-13):

- Pricing page: the Free plan's licence line reads "Personal Use", "Terms apply"; 60 API calls/minute.
- Sign-up page: you confirm you are either "a qualified non-professional (personal use)" or a
  commercial / professional user with written approval.

That matches your use (your own investing decisions, nothing shown or sold to others). **It is
not a full confirmation: the Terms of Service text itself was not read.** Please read it once
on your phone (finnhub.io → footer → Terms of Service) and check three points:
1. the definition of "non-professional" — whether it fits someone investing only their own money;
2. nothing forbids storing the data on your own server for your own use;
3. nothing forbids feeding the data to an AI model or an automated tool.
If any of the three is unclear, send me the paragraph.

## Check 2 — coverage of your 22 stocks (phone)

1. finnhub.io → **Get free API key** → sign up (choose the personal / non-professional option) → copy the key.
2. Render → **loop-gm-server-1** → **Environment** → add `FINNHUB_API_KEY` = the key → **Save, rebuild, and deploy**.
3. Log in to the console, then open `/api/trading/providers/status` — expect `"usable": true` four times under `stock`.
4. Open `/api/trading/providers/test?symbol=MSTR` — one stock with Finnhub's raw answers.
   **Send me this output first**: the adapter's paths and field names have not been proven by a
   real call yet, and this shows whether they are right.
5. Open `/api/trading/providers/coverage?start=yes`, wait about 3 minutes, then open
   `/api/trading/providers/coverage` and send me the output. `gaps` lists every stock and
   capability that is missing or thin; `fullyCovered` lists the rest.

The test makes 110 calls at no more than 40 per minute (Finnhub's free limit: 60).
What counts as a gap: profile — symbol unknown; fundamentals — more than 3 of 10 core figures
missing (a missing P/E for a loss-making company is not counted); earnings — no past quarter
with an actual figure (`partial`: fewer than 4 quarters, or no upcoming date); news — no
article in 30 days (`partial`: fewer than 5).

## Switching to Option B later

`DATA_PROVIDERS` in `trading/config.js` is the only place that names a provider, per
capability (`profile`, `fundamentals`, `earnings`, `news`). Everything else asks the layer for
a capability. Switching the stock side to FMP is then: change `"finnhub"` to `"fmp"` on the
lines you want, add `FMP_API_KEY` in Render, deploy. It can be partial (e.g. only `fundamentals`).

**One honest caveat:** the FMP adapter itself (one file, `trading/providers/fmp.js`, plus one
line registering it) is **not written yet**. FMP's documentation could not be opened from the
coding session and there is no key to test with; an adapter written blind would be untested
code. Until it exists, naming `"fmp"` in the config makes that capability unavailable (it
fails closed, with no silent fallback to Finnhub). The coverage test runs unchanged against any provider.

---

# The original proposal (for reference)

**How reliable the figures below are:** the providers' own websites could not be opened from
this session (blocked by its network settings), so prices and limits come from web search
results on 2026-11-13 — mostly snippets of the official pricing pages, some third-party.
Where sources disagreed or a point could not be confirmed, it says so. **Confirm the price on
the provider's page before paying**, and I will confirm each free endpoint with a real call
from the Render server (a protected test route, as in Stage 1) before building on it.

Your lists: 22 US-listed stocks (several are small caps: WYFI, VISN, GRRR, OPTT, AMPX, MRAM,
INOD, PLAB, TMDX) and 9 coins. A daily refresh is roughly 70–100 calls a day in total.

## Coverage at a glance

| Provider | Cost | Stocks | Crypto |
|---|---|---|---|
| **Finnhub** | Free: 60 calls/min | Company news (1 year back), earnings calendar (1 month, US), earnings surprises (last 4 quarters). Ratios ("basic financials") exist but free access is unconfirmed | General crypto news feed only — not per coin (to confirm). No coin fundamentals |
| **CoinGecko** | Free "Demo": 10,000 calls/month. Paid from $35/month | **Nothing** | Market cap, circulating/total/max supply, rank, categories, price history for all 9 coins. A news endpoint is unconfirmed |
| **SEC EDGAR** (official, US regulator) | Free, no key, max 10 requests/second | Official filings and reported financials (10-K, 10-Q, 8-K; also 20-F / 6-K for foreign companies such as BABA, NVO, GRAB, SE). No news, no ratios, no future earnings dates | **Nothing** |
| **Financial Modeling Prep (FMP)** | Free: 250 calls/day. Starter: $22/month | Financial statements, ratios, company news, earnings calendar. Free plan is end-of-day with ~5 years of history; which of news / earnings are on Free is unconfirmed | Crypto prices and crypto news reported on Starter (third-party source). No supply or on-chain fundamentals |
| **Alpha Vantage** | Free: 25 calls/day. Paid from $49.99/month | Fundamentals, earnings, news with sentiment scores | News with sentiment also for crypto tickers (to confirm); prices. No coin fundamentals |

## Three options

### Option A — free: Finnhub + CoinGecko (+ SEC EDGAR)   ← recommended start
- **Stocks:** news, earnings dates and surprises from Finnhub; official financial statements from SEC EDGAR.
- **Crypto:** fundamentals from CoinGecko; general crypto headlines from Finnhub.
- **Cost:** $0.
- **Pros:** costs nothing to try; each source is used for what it is best at; EDGAR is the primary source for company figures.
- **Cons:** three integrations; crypto news is general, not per coin; Finnhub's free plan is described by third parties as personal / non-commercial use, and one source claims a much lower free limit (5 calls/min) — both need checking on its site; small-cap coverage is untested.

### Option B — low cost: FMP Starter ($22/month) + CoinGecko free
- **Stocks:** statements, ratios, news and earnings calendar from one provider.
- **Crypto:** crypto news from FMP (to confirm); fundamentals from CoinGecko.
- **Cost:** about $22/month. FMP's free plan (250 calls/day) may be enough to test first.
- **Pros:** ready-made ratios, so less calculation code than EDGAR; two integrations; a paid plan with clear terms.
- **Cons:** monthly cost; FMP restates company figures (a secondary source); crypto side still needs CoinGecko.

### Option C — one provider for news on both sides: Alpha Vantage (from $49.99/month) + CoinGecko free
- **Stocks:** fundamentals, earnings, news with sentiment. **Crypto:** news with sentiment (to confirm); fundamentals from CoinGecko.
- **Pros:** the only option here whose news feed is reported to cover stocks and coins in the same format, with sentiment scores.
- **Cons:** the free plan (25 calls/day) cannot cover 31 instruments, so it means paying from day one; the most expensive of the three.

Not proposed: CryptoPanic (per-coin crypto news; a free tier is listed but its current terms
could not be confirmed) and Marketaux (news for both stocks and crypto; free plan reported as
100 requests/day with 3 articles each — too thin). Either can be added later for per-coin news.

## Recommendation

Start with **Option A** and test it for free. If Finnhub's free terms or its small-cap
coverage turn out to be a problem, move the stock side to FMP Starter (Option B).
No single low-cost provider covers stock fundamentals **and** coin fundamentals well; every
option uses CoinGecko for the coins.

## What I need from you

1. Which option (A, B or C).
2. For the chosen providers, create the free accounts and add the keys in Render — I will give
   the exact env var names and steps once you choose. No keys are needed for SEC EDGAR.

## Sources (search results, 2026-11-13)

- Finnhub: https://finnhub.io/pricing , https://finnhub.io/docs/api/market-news
- CoinGecko: https://www.coingecko.com/en/api/pricing
- SEC EDGAR: https://www.sec.gov/search-filings/edgar-application-programming-interfaces , https://www.sec.gov/about/developer-resources
- FMP: https://site.financialmodelingprep.com/pricing-plans
- Alpha Vantage: https://www.alphavantage.co/premium/ (price list via https://multiples.vc/compare/alpha-vantage-api-alternatives/md)
- CryptoPanic: https://cryptopanic.com/developers/api/about · Marketaux: https://marketaux.com/pricing
