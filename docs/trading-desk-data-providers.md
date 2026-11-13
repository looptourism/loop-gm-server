# Trading Desk — news, fundamentals and earnings: provider proposal (Stage 3)

**Nothing here is integrated.** This is a proposal for you to choose from. eToro's API gives
prices only; news, company fundamentals and earnings dates need another source.

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
