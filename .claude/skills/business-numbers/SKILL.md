---
name: business-numbers
description: >-
  Pull live data from Shopify, Meta Ads and Google Ads (via the Shopify, Windsor.ai and Meta
  connectors), build a full profit-and-loss with cost of goods, payment fees, ad spend and a GST
  provision, and report true net profit with every sales and ad number in tables. Use this whenever
  the user wants an overview of the business numbers, asks how the business or the store is doing,
  says "p&l", "profit", "true profit", "am I making money", "margins", "cost analysis", "business
  numbers", "monthly numbers", "how much did we make", "revenue and ad spend", "MER", or wants
  sales and ad figures side by side for any period. Trigger even when only one source is named
  (for example "what did Shopify do last month") because the point of the skill is the combined
  picture; and trigger for period comparisons ("this month vs last month"). Do not use it for ad
  account decisions (which campaign to scale or cut); that is the charlie-meta-ads skill, which
  can run after this one.
---

# Business numbers: true profit from Shopify, Meta and Google

This skill produces one reliable overview of the business for a period: sales, ad spend, cost of goods, fees, tax provision and the profit that is left. It exists because platform dashboards each tell a flattering, partial story. Shopify shows revenue without ad cost, Meta and Google each claim credit for purchases, and none of them know what the supplier charges. The user wants the number that matters: what was actually made after everything, and which market and cost line drove it.

The default business is Willow Haven (Shopify `willowhavenstore.com`, Meta account `1057831906408126`, Google Ads `388-687-6870`, all AUD). Account details, campaign scope, the cost-of-goods table, fee rates and the GST rule live in `references/willow-haven.md`. The exact, tested queries for every source are in `references/data-pulls.md`. The arithmetic is done by `scripts/build_pnl.py` so the maths is the same every run.

## Reliability rules

These are what make the skill trustworthy enough to run every week without re-checking.

1. **Always pull live, every source, every run.** Never reuse numbers from an earlier conversation or from memory, even for "quick" questions. If one source fails, say which one and show that line as missing; do not fill it with an estimate and do not present a profit figure as complete when a cost is absent.
2. **Shopify is the truth for orders and revenue; platforms are the truth for spend only.** Meta and Google each report purchases they take credit for, and together they over-count. The P&L uses Shopify orders and net sales, and the platforms' own spend. Platform ROAS and CPA are shown, labelled as platform claims.
3. **Same calendar days in every source.** Pass explicit start and end dates everywhere. The period ends yesterday (the last complete day), never today.
4. **Every estimate is labelled.** Unit costs without a Shopify value, the fee rate table, the GST provision and any missing fixed costs all appear in the report's data-gaps section. The user should never discover later that a number was assumed.
5. **Reconcile before presenting.** By-country sales must add up to the store total; Meta spend from Windsor should match the Meta connector within about 2% when both are available; platform-reported purchases against Shopify orders are shown as a ratio. If a check fails, fix the pull before writing the report.
6. **Scope the ad accounts.** The Windsor Meta connector also carries another brand ("New Burn Q"). Only the Willow Haven account counts. Details in `references/willow-haven.md`.

## Workflow

### 1. Fix the period

Default: the last 30 complete days ending yesterday, compared with the 30 days before that. Honour anything the user says instead ("August", "this month so far", "last week", "since the 1st", explicit dates). For a calendar month that has ended, compare with the previous calendar month. State the exact dates in the report title. Today's date comes from the environment; work out the ranges before pulling.

### 2. Discover tools and pull everything

Tool names change per session, so run ToolSearch for the Shopify, Windsor.ai and (optionally) Meta connector tools first. Then fire every pull in `references/data-pulls.md` for both periods in one batch; they are independent. The set is:

- Shopify: sales by billing country; units and net sales by country and product; customers; sessions and conversion by country; product unit costs (GraphQL).
- Windsor.ai `facebook`, scoped to account `1057831906408126`: spend, impressions, clicks, purchases and purchase value by campaign.
- Windsor.ai `google_ads`: spend, clicks, conversions by campaign and country.
- Optional: Meta connector account-level spend as a cross-check; supplier sheet from Drive when the user asks to reconcile cost of goods.

### 3. Map to markets and costs

Group billing countries into `AU`, `US`, `Other`. Assign Meta campaigns to a market by name; Google rows carry a country already. Unmatched campaigns go on the `Shared` line, charged to the total and not to any market. For each product and market, take the unit cost from the Shopify pull, then apply the per-market overrides in `references/willow-haven.md` (the supplier charges more for US, NL and BE sliders). Fee rates, the GST rule and any fixed costs the user has given also come from that file.

### 4. Run the calculator

Write the input JSON (schema in the docstring of `scripts/build_pnl.py`; `python3 scripts/build_pnl.py --example` prints a filled example) to the scratch directory, with the comparison period under `"previous"`, then:

```
python3 <skill-path>/scripts/build_pnl.py <input.json>
```

It prints the whole report in markdown: headline with deltas, sales and ad spend by market, the P&L waterfall (as collected and GST-provisioned), unit economics per order with break-even MER, campaign table, product table, other numbers, and data gaps. Do not re-type these tables by hand; paste the output. If a number in the output looks wrong against the sanity ranges in `references/willow-haven.md`, the fault is almost always in the input mapping; fix the input and re-run rather than editing the output.

### 5. Read the numbers

After the tables, add a short read, at most six bullets, in plain language:

- Whether net profit went up or down and the one cost or revenue line that moved it most.
- Which market is carrying the profit and whether any market's MER is below its break-even line.
- Anything that crossed a sanity range or moved more than 20% period over period (return rate, discount rate, AOV, conversion, repeat rate, CPM).
- The single most useful next action if there is an obvious one, or a pointer to the charlie-meta-ads skill for campaign-level decisions.
- The data gaps that change the answer (missing fixed costs, estimated unit costs) and the one thing the user could supply to close them.

Keep prose short. Numbers belong in the tables above, not repeated in sentences. No hype, no reassurance, no sign-off.

### 6. Persist what the user tells you

If the user supplies fixed costs, a corrected unit cost or a changed fee rate, update `references/willow-haven.md` (or tell the user exactly which table to update if the skill files are read-only) so the next run does not ask again. Save a dated copy of the report when the user asks for it or when a workspace folder for reports already exists.

## What the report answers

- How much was sold, by market, after discounts and refunds.
- What every platform spent and what that spend cost per Shopify order.
- What the goods cost and what margin is left after them.
- What payment processing and FX took.
- Profit before and after the GST provision, in total and per order.
- Break-even MER for each market against its actual MER.
- Conversion, sessions, AOV, repeat rate, discount and return rates, run-rates per day.
- Everything that was estimated or missing.

## Reference files

- `references/data-pulls.md`: tool discovery, the exact ShopifyQL, GraphQL and Windsor calls (all tested), alignment notes and the reconciliation checks. Read before pulling.
- `references/willow-haven.md`: account ids, campaign-to-market rules, unit cost table with per-market overrides, fee rates, the GST rule, fixed-cost table, sanity ranges. Read before mapping.
- `scripts/build_pnl.py`: the calculator. `--example` prints a sample input; `--json` returns machine-readable results.
