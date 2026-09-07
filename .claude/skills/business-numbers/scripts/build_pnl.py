#!/usr/bin/env python3
"""
Build a true-profit P&L from a JSON input file and print it as markdown tables.

Usage:
    python build_pnl.py input.json            # markdown report to stdout
    python build_pnl.py input.json --json     # machine-readable result instead
    python build_pnl.py --example             # print an example input file

The script does the arithmetic only. Every number in the input must come from a
live connector pull or from the user; the script never invents a value. If a
block is missing (for example no Google Ads rows) the corresponding lines show
as 0 and the report lists the gap under "Data gaps", so a missing source is
visible rather than silently absorbed.

Input schema (all money in one currency, the store's base currency):

{
  "currency": "AUD",
  "period": {"label": "Last 30 days", "start": "2026-08-08", "end": "2026-09-06", "days": 30},
  "markets": {                      # one entry per market; key is the label used everywhere
    "AU": {"orders": 370, "gross_sales": 42472.64, "discounts": -1263.08, "returns": -802.07,
           "net_sales": 40407.49, "shipping_charges": 0, "taxes": 0, "total_sales": 40407.49,
           "sessions": 15292, "checkouts": 344},
    "US": {...},
    "Other": {...}
  },
  "products": [                    # per market and product; units drive COGS
    {"market": "US", "title": "Acacia Wood Slider", "units": 374, "net_sales": 40726.6,
     "unit_cost": 26.0}
  ],
  "ads": [                          # one row per platform x campaign (already scoped to this store)
    {"platform": "Meta", "campaign": "WH - USA - Scaling", "market": "US",
     "spend": 57372.91, "purchases": 809, "purchase_value": 117408.04,
     "impressions": 943972, "clicks": 57365}
  ],
  "fee_rates": {"AU": 0.016, "US": 0.054, "Other": 0.054},   # payment + FX fee as share of total_sales
  "gst": {"market": "AU", "rate": 0.0909090909, "collected": 0},   # provision = rate x (total_sales - collected)
  "fixed_costs": [{"name": "Shopify plan", "amount": 0, "note": "confirm"}],
  "customers": {"customers": 1217, "new": 1191, "returning": 51},
  "previous": { ...same shape as the top level, without "previous"... }   # optional comparison period
}

Ad rows whose "market" is not one of the market keys (e.g. "Shared") are shown
on their own line and charged to the total, never to one market. Google Ads
rows without a market are treated as shared unless the caller assigns one.
"""
import json
import sys
from collections import OrderedDict, defaultdict

EXAMPLE = {
    "currency": "AUD",
    "period": {"label": "Last 30 days", "start": "2026-08-08", "end": "2026-09-06", "days": 30},
    "markets": {
        "AU": {"orders": 370, "gross_sales": 42472.64, "discounts": -1263.08, "returns": -802.07,
               "net_sales": 40407.49, "shipping_charges": 0, "taxes": 0, "total_sales": 40407.49,
               "sessions": 15292, "checkouts": 344},
        "US": {"orders": 875, "gross_sales": 129840.78, "discounts": -1691.26, "returns": -1161.41,
               "net_sales": 126988.11, "shipping_charges": 0, "taxes": 149.74, "total_sales": 127137.85,
               "sessions": 26881, "checkouts": 835},
        "Other": {"orders": 1, "gross_sales": 151.75, "discounts": 0, "returns": 0,
                  "net_sales": 151.75, "shipping_charges": 0, "taxes": 0, "total_sales": 151.75,
                  "sessions": 341, "checkouts": 2}
    },
    "products": [
        {"market": "US", "title": "Acacia Wood Slider", "units": 374, "net_sales": 40726.6, "unit_cost": 26.0},
        {"market": "AU", "title": "Acacia Wood Slider", "units": 196, "net_sales": 17123.67, "unit_cost": 28.0}
    ],
    "ads": [
        {"platform": "Meta", "campaign": "WH - USA - Scaling", "market": "US", "spend": 57372.91,
         "purchases": 809, "purchase_value": 117408.04, "impressions": 943972, "clicks": 57365},
        {"platform": "Meta", "campaign": "WH - AUD - Scaling", "market": "AU", "spend": 17347.53,
         "purchases": 303, "purchase_value": 32361.4, "impressions": 854006, "clicks": 24379},
        {"platform": "Google", "campaign": "PMax no negative", "market": "Shared", "spend": 3304.34,
         "purchases": 169.9, "purchase_value": 21363.71, "impressions": 94808, "clicks": 2133}
    ],
    "fee_rates": {"AU": 0.016, "US": 0.054, "Other": 0.054},
    "gst": {"market": "AU", "rate": 1 / 11, "collected": 0},
    "fixed_costs": [{"name": "Shopify plan + apps", "amount": 0, "note": "not provided - confirm"}],
    "customers": {"customers": 1217, "new": 1191, "returning": 51}
}


def money(x, cur="", digits=0):
    if x is None:
        return "n/a"
    sign = "-" if x < 0 else ""
    return f"{sign}{cur}{abs(x):,.{digits}f}"


def pct(x, digits=1):
    if x is None:
        return "n/a"
    if abs(x) < 10 ** -(digits + 2):
        x = 0.0
    return f"{x * 100:.{digits}f}%"


def ratio(x, digits=2):
    return "n/a" if x is None else f"{x:.{digits}f}"


def div(a, b):
    return None if not b else a / b


def compute(data):
    markets = OrderedDict(data["markets"])
    keys = list(markets.keys())
    fee_rates = data.get("fee_rates", {})
    gst = data.get("gst") or {}
    gaps = []

    # --- revenue block per market
    rev = {k: dict(markets[k]) for k in keys}
    for k in keys:
        m = rev[k]
        m.setdefault("shipping_charges", 0)
        m.setdefault("taxes", 0)
        m.setdefault("total_sales", m["net_sales"] + m["shipping_charges"] + m["taxes"])

    # --- COGS per market from product units x unit cost
    cogs = defaultdict(float)
    units = defaultdict(float)
    prod_rows = []
    missing_cost = []
    for p in data.get("products", []):
        mk = p.get("market", "Other")
        if mk not in rev:
            mk = "Other" if "Other" in rev else keys[-1]
        uc = p.get("unit_cost")
        if uc is None:
            missing_cost.append(p.get("title", "?"))
            uc = 0.0
        line = p.get("units", 0) * uc
        cogs[mk] += line
        units[mk] += p.get("units", 0)
        prod_rows.append({"market": mk, "title": p.get("title", "?"), "units": p.get("units", 0),
                          "net_sales": p.get("net_sales", 0), "unit_cost": uc, "cogs": line,
                          "gross_margin": div(p.get("net_sales", 0) - line, p.get("net_sales", 0)) if p.get("units", 0) else None})
    if missing_cost:
        gaps.append("No unit cost for: " + ", ".join(sorted(set(missing_cost))) + " (COGS understated)")
    if not data.get("products"):
        gaps.append("No product rows supplied - COGS is 0, gross profit is overstated")

    # --- ad spend per market and shared
    ads = data.get("ads", [])
    spend = defaultdict(float)
    spend_by_platform = defaultdict(float)
    spend_by_platform_market = defaultdict(float)
    plat_purchases = defaultdict(float)
    plat_value = defaultdict(float)
    for a in ads:
        mk = a.get("market") or "Shared"
        if mk not in rev:
            mk = "Shared"
        spend[mk] += a.get("spend", 0)
        spend_by_platform[a.get("platform", "?")] += a.get("spend", 0)
        spend_by_platform_market[(a.get("platform", "?"), mk)] += a.get("spend", 0)
        plat_purchases[a.get("platform", "?")] += a.get("purchases", 0) or 0
        plat_value[a.get("platform", "?")] += a.get("purchase_value", 0) or 0
    platforms = sorted(spend_by_platform.keys())
    if not ads:
        gaps.append("No ad spend rows supplied - profit is overstated by the full ad cost")
    for needed in ("Meta", "Google"):
        if needed not in spend_by_platform:
            gaps.append(f"No {needed} rows in ads - if {needed} ran this period, spend is missing")

    # --- per market P&L
    pl = OrderedDict()
    for k in keys:
        m = rev[k]
        fr = fee_rates.get(k)
        if fr is None:
            gaps.append(f"No fee rate for {k} - payment fees for {k} set to 0")
            fr = 0.0
        fees = m["total_sales"] * fr
        gross_profit = m["net_sales"] - cogs[k]
        contribution = gross_profit - fees - spend[k]
        gst_prov = 0.0
        if gst and gst.get("market") == k:
            gst_prov = max(0.0, gst.get("rate", 0) * m["total_sales"] - gst.get("collected", 0))
        pl[k] = {
            "orders": m["orders"], "gross_sales": m["gross_sales"], "discounts": m.get("discounts", 0),
            "returns": m.get("returns", 0), "net_sales": m["net_sales"], "total_sales": m["total_sales"],
            "aov": div(m["net_sales"], m["orders"]), "units": units[k],
            "cogs": cogs[k], "cogs_pct": div(cogs[k], m["net_sales"]),
            "gross_profit": gross_profit, "gross_margin": div(gross_profit, m["net_sales"]),
            "fees": fees, "fee_rate": fr, "ad_spend": spend[k],
            "mer": div(m["net_sales"], spend[k]), "cpa": div(spend[k], m["orders"]),
            "ad_pct": div(spend[k], m["net_sales"]),
            "contribution": contribution, "contribution_margin": div(contribution, m["net_sales"]),
            "gst_provision": gst_prov,
            "contribution_after_gst": contribution - gst_prov,
            "profit_per_order": div(contribution, m["orders"]),
            "profit_per_order_after_gst": div(contribution - gst_prov, m["orders"]),
            "sessions": m.get("sessions"), "checkouts": m.get("checkouts"),
            "conversion_rate": div(m.get("checkouts") or 0, m.get("sessions")) if m.get("sessions") else None,
            "spend_by_platform": {p: spend_by_platform_market.get((p, k), 0.0) for p in platforms},
            # break-even ROAS: net sales needed per ad dollar so contribution is zero
            "breakeven_roas": div(1.0, (div(gross_profit - fees - gst_prov, m["net_sales"]) or 0)) if m["net_sales"] else None,
        }

    # --- totals
    tot = {}
    sum_keys = ["orders", "gross_sales", "discounts", "returns", "net_sales", "total_sales", "units", "cogs",
                "gross_profit", "fees", "ad_spend", "contribution", "gst_provision", "contribution_after_gst"]
    for sk in sum_keys:
        tot[sk] = sum(pl[k][sk] for k in keys)
    tot["shared_ad_spend"] = spend.get("Shared", 0.0)
    tot["ad_spend"] += tot["shared_ad_spend"]
    tot["contribution"] -= tot["shared_ad_spend"]
    tot["contribution_after_gst"] -= tot["shared_ad_spend"]
    fixed = data.get("fixed_costs", []) or []
    tot["fixed_costs"] = sum(f.get("amount", 0) or 0 for f in fixed)
    if not fixed or all((f.get("amount") or 0) == 0 for f in fixed):
        gaps.append("Fixed costs (Shopify plan, apps, subscriptions, contractors) not provided - net profit excludes them")
    tot["net_profit"] = tot["contribution"] - tot["fixed_costs"]
    tot["net_profit_after_gst"] = tot["contribution_after_gst"] - tot["fixed_costs"]
    tot["aov"] = div(tot["net_sales"], tot["orders"])
    tot["cogs_pct"] = div(tot["cogs"], tot["net_sales"])
    tot["gross_margin"] = div(tot["gross_profit"], tot["net_sales"])
    tot["mer"] = div(tot["net_sales"], tot["ad_spend"])
    tot["ad_pct"] = div(tot["ad_spend"], tot["net_sales"])
    tot["cpa"] = div(tot["ad_spend"], tot["orders"])
    tot["contribution_margin"] = div(tot["contribution"], tot["net_sales"])
    tot["net_margin"] = div(tot["net_profit"], tot["net_sales"])
    tot["net_margin_after_gst"] = div(tot["net_profit_after_gst"], tot["net_sales"])
    tot["profit_per_order"] = div(tot["net_profit"], tot["orders"])
    tot["profit_per_order_after_gst"] = div(tot["net_profit_after_gst"], tot["orders"])
    tot["discount_rate"] = div(-tot["discounts"], tot["gross_sales"])
    tot["return_rate"] = div(-tot["returns"], tot["gross_sales"])
    tot["spend_by_platform"] = dict(spend_by_platform)
    tot["platform_purchases"] = dict(plat_purchases)
    tot["platform_value"] = dict(plat_value)
    tot["platform_roas"] = {p: div(plat_value[p], spend_by_platform[p]) for p in platforms}
    tot["platform_cpa"] = {p: div(spend_by_platform[p], plat_purchases[p]) for p in platforms}
    all_sessions = sum((rev[k].get("sessions") or 0) for k in keys)
    all_checkouts = sum((rev[k].get("checkouts") or 0) for k in keys)
    tot["sessions"] = all_sessions or None
    tot["conversion_rate"] = div(all_checkouts, all_sessions) if all_sessions else None
    days = data.get("period", {}).get("days") or 0
    tot["days"] = days
    tot["net_sales_per_day"] = div(tot["net_sales"], days)
    tot["ad_spend_per_day"] = div(tot["ad_spend"], days)
    tot["net_profit_per_day"] = div(tot["net_profit"], days)
    tot["orders_per_day"] = div(tot["orders"], days)
    cust = data.get("customers") or {}
    if cust:
        tot["customers"] = cust.get("customers")
        tot["new_customers"] = cust.get("new")
        tot["returning_customers"] = cust.get("returning")
        tot["repeat_rate"] = div(cust.get("returning", 0), cust.get("customers"))
    platform_orders = sum(plat_purchases.values())
    tot["platform_reported_purchases"] = platform_orders
    tot["platform_overcount"] = div(platform_orders, tot["orders"])

    return {"markets": pl, "totals": tot, "products": prod_rows, "ads": ads, "platforms": platforms,
            "shared_spend": tot["shared_ad_spend"], "fixed_costs": fixed, "gaps": gaps, "keys": keys}


def delta(cur, prev):
    if cur is None or prev in (None, 0):
        return ""
    d = (cur - prev) / abs(prev)
    arrow = "+" if d >= 0 else ""
    return f" ({arrow}{d * 100:.0f}%)"


def render(data, res, prev_res=None):
    cur = data.get("currency", "")
    sym = "$"
    p = data.get("period", {})
    keys = res["keys"]
    T = res["totals"]
    PT = prev_res["totals"] if prev_res else None
    out = []
    A = out.append

    A(f"# Business numbers: {p.get('label', 'period')} ({p.get('start')} to {p.get('end')}, {cur})")
    A("")
    A("## Headline")
    A("")
    A("| Metric | This period | vs previous |")
    A("|---|---|---|")

    def row(label, val, prevval=None, fmt=money):
        A(f"| {label} | {fmt(val)} | {fmt(prevval) + delta(val, prevval) if PT and prevval is not None else ''} |")

    row("Net sales", T["net_sales"], PT and PT["net_sales"])
    row("Orders", T["orders"], PT and PT["orders"], lambda v: "n/a" if v is None else f"{v:,.0f}")
    row("Total ad spend (all platforms)", T["ad_spend"], PT and PT["ad_spend"])
    row("MER (net sales / ad spend)", T["mer"], PT and PT["mer"], ratio)
    row("Contribution profit (after COGS, fees, ads)", T["contribution"], PT and PT["contribution"])
    row("Net profit as collected (after fixed costs)", T["net_profit"], PT and PT["net_profit"])
    row("Net profit GST-provisioned", T["net_profit_after_gst"], PT and PT["net_profit_after_gst"])
    row("Net margin (GST-provisioned)", T["net_margin_after_gst"], PT and PT["net_margin_after_gst"], pct)
    row("Profit per order (GST-provisioned)", T["profit_per_order_after_gst"], PT and PT["profit_per_order_after_gst"])
    A("")

    # Sales and ads by market
    A("## Sales and ad spend by market")
    A("")
    hdr = ["Line"] + keys + ["Shared", "Total"]
    A("| " + " | ".join(hdr) + " |")
    A("|" + "---|" * len(hdr))

    def mrow(label, key, fmt=money, shared="", total_key=None):
        cells = [label]
        for k in keys:
            cells.append(fmt(res["markets"][k].get(key)))
        cells.append(shared)
        cells.append(fmt(T.get(total_key or key)))
        A("| " + " | ".join(cells) + " |")

    mrow("Orders", "orders", lambda v: "n/a" if v is None else f"{v:,.0f}")
    mrow("Gross sales", "gross_sales")
    mrow("Discounts", "discounts")
    mrow("Returns / refunds", "returns")
    mrow("Net sales", "net_sales")
    mrow("AOV (net)", "aov")
    for plat in res["platforms"]:
        cells = [f"{plat} spend"]
        for k in keys:
            cells.append(money(res["markets"][k]["spend_by_platform"].get(plat, 0)))
        shared_p = sum(a.get("spend", 0) for a in res["ads"]
                       if a.get("platform") == plat and (a.get("market") or "Shared") not in keys)
        cells.append(money(shared_p))
        cells.append(money(T["spend_by_platform"].get(plat, 0)))
        A("| " + " | ".join(cells) + " |")
    mrow("Total ad spend", "ad_spend", shared=money(res["shared_spend"]))
    mrow("MER (net sales / ad spend)", "mer", ratio)
    mrow("Ad spend as % of net sales", "ad_pct", pct)
    mrow("Blended CPA (ad spend / Shopify orders)", "cpa")
    mrow("Sessions", "sessions", lambda v: "n/a" if v is None else f"{v:,.0f}")
    mrow("Conversion rate", "conversion_rate", pct, total_key="conversion_rate")
    A("")

    # P&L waterfall
    A("## Profit and loss")
    A("")
    A("| Line | " + " | ".join(keys) + " | Total | % of net sales |")
    A("|---|" + "---|" * (len(keys) + 2))

    def wrow(label, key, sign=1, total_override=None, pct_key=None):
        cells = [label]
        for k in keys:
            cells.append(money(sign * res["markets"][k][key]))
        tv = T[key] if total_override is None else total_override
        cells.append(money(sign * tv))
        cells.append(pct(div(sign * tv, T["net_sales"])) if T["net_sales"] else "")
        A("| " + " | ".join(cells) + " |")

    wrow("Net sales", "net_sales")
    wrow("Cost of goods (units x unit cost)", "cogs", -1)
    wrow("Gross profit", "gross_profit")
    wrow("Payment + FX fees", "fees", -1)
    market_spend = sum(res["markets"][k]["ad_spend"] for k in keys)
    wrow("Ad spend charged to market", "ad_spend", -1, total_override=market_spend)
    A(f"| Shared / unallocated ad spend | " + " | ".join("" for _ in keys) + f" | {money(-res['shared_spend'])} | {pct(div(-res['shared_spend'], T['net_sales']))} |")
    wrow("Contribution profit", "contribution")
    A(f"| Fixed costs | " + " | ".join("" for _ in keys) + f" | {money(-T['fixed_costs'])} | {pct(div(-T['fixed_costs'], T['net_sales']))} |")
    A(f"| Net profit (as collected) | " + " | ".join("" for _ in keys) + f" | **{money(T['net_profit'])}** | {pct(T['net_margin'])} |")
    wrow("GST provision (not yet collected)", "gst_provision", -1)
    A(f"| Net profit (GST-provisioned) | " + " | ".join("" for _ in keys) + f" | **{money(T['net_profit_after_gst'])}** | {pct(T['net_margin_after_gst'])} |")
    A("")

    # Unit economics
    A("## Unit economics per order")
    A("")
    A("| Per order | " + " | ".join(keys) + " | Total |")
    A("|---|" + "---|" * (len(keys) + 1))

    def urow(label, fn, total_fn):
        cells = [label] + [fn(res["markets"][k]) for k in keys] + [total_fn(T)]
        A("| " + " | ".join(cells) + " |")

    urow("Net sales (AOV)", lambda m: money(m["aov"]), lambda t: money(t["aov"]))
    urow("COGS", lambda m: money(div(m["cogs"], m["orders"])), lambda t: money(div(t["cogs"], t["orders"])))
    urow("COGS % of net sales", lambda m: pct(m["cogs_pct"]), lambda t: pct(t["cogs_pct"]))
    urow("Fees", lambda m: money(div(m["fees"], m["orders"])), lambda t: money(div(t["fees"], t["orders"])))
    urow("Ad cost (blended CPA)", lambda m: money(m["cpa"]), lambda t: money(t["cpa"]))
    urow("Profit per order before GST", lambda m: money(m["profit_per_order"]), lambda t: money(t["profit_per_order"]))
    urow("Profit per order after GST provision", lambda m: money(m["profit_per_order_after_gst"]), lambda t: money(t["profit_per_order_after_gst"]))
    urow("Break-even MER (ad-inclusive)", lambda m: ratio(m["breakeven_roas"]), lambda t: "")
    urow("Actual MER", lambda m: ratio(m["mer"]), lambda t: ratio(t["mer"]))
    A("")
    A("Break-even MER is net sales per ad dollar at which contribution hits zero for that market, using its own COGS, fee rate and GST rule. Actual MER above the line means the market is contributing; below means every ad dollar loses money.")
    A("")

    # Ad platform detail
    A("## Ad platforms and campaigns")
    A("")
    A("| Platform | Campaign | Market | Spend | Platform purchases | Platform ROAS | Platform CPA | CPM | CPC |")
    A("|---|---|---|---|---|---|---|---|---|")
    for a in sorted(res["ads"], key=lambda x: -x.get("spend", 0)):
        sp = a.get("spend", 0)
        pu = a.get("purchases") or 0
        pv = a.get("purchase_value") or 0
        imp = a.get("impressions") or 0
        cl = a.get("clicks") or 0
        A(f"| {a.get('platform')} | {a.get('campaign')} | {a.get('market') or 'Shared'} | {money(sp)} | {pu:,.0f} | {ratio(div(pv, sp))} | {money(div(sp, pu))} | {money(div(sp, imp / 1000) if imp else None, digits=2)} | {money(div(sp, cl), digits=2)} |")
    for plat in res["platforms"]:
        A(f"| **{plat} total** | | | {money(T['spend_by_platform'][plat])} | {T['platform_purchases'][plat]:,.0f} | {ratio(T['platform_roas'][plat])} | {money(T['platform_cpa'][plat])} | | |")
    A("")
    if T["orders"]:
        A(f"Platforms together report {T['platform_reported_purchases']:,.0f} purchases against {T['orders']:,} Shopify orders "
          f"({ratio(T['platform_overcount'])}x). Platform ROAS and CPA are attribution claims; the P&L above uses Shopify orders and net sales as truth and platform spend as cost.")
    A("")

    # Products
    A("## Products")
    A("")
    A("| Market | Product | Units | Net sales | Unit cost | COGS | Gross margin |")
    A("|---|---|---|---|---|---|---|")
    for pr in sorted(res["products"], key=lambda x: -x["net_sales"]):
        A(f"| {pr['market']} | {pr['title']} | {pr['units']:,.0f} | {money(pr['net_sales'])} | {money(pr['unit_cost'])} | {money(pr['cogs'])} | {pct(pr['gross_margin'])} |")
    A("")

    # Other numbers
    A("## Other numbers")
    A("")
    A("| Metric | Value |")
    A("|---|---|")
    A(f"| Days in period | {T['days']} |")
    A(f"| Net sales per day | {money(T['net_sales_per_day'])} |")
    A(f"| Orders per day | {ratio(T['orders_per_day'], 1)} |")
    A(f"| Ad spend per day | {money(T['ad_spend_per_day'])} |")
    A(f"| Net profit per day (as collected) | {money(T['net_profit_per_day'])} |")
    A(f"| Discount rate (discounts / gross sales) | {pct(T['discount_rate'])} |")
    A(f"| Return / refund rate (returns / gross sales) | {pct(T['return_rate'])} |")
    A(f"| Gross margin after COGS | {pct(T['gross_margin'])} |")
    A(f"| Contribution margin | {pct(T['contribution_margin'])} |")
    if T.get("customers") is not None:
        A(f"| Customers / new / returning | {T['customers']:,} / {T['new_customers']:,} / {T['returning_customers']:,} |")
        A(f"| Repeat customer rate | {pct(T['repeat_rate'])} |")
    if T.get("conversion_rate") is not None:
        A(f"| Store conversion rate (checkouts / sessions) | {pct(T['conversion_rate'], 2)} |")
    A(f"| GST provision this period | {money(T['gst_provision'])} |")
    A("")
    if res["fixed_costs"]:
        A("Fixed costs included:")
        A("")
        for f in res["fixed_costs"]:
            A(f"- {f.get('name')}: {money(f.get('amount', 0))}" + (f" ({f['note']})" if f.get("note") else ""))
        A("")

    A("## Data gaps and estimates")
    A("")
    if res["gaps"]:
        for g in res["gaps"]:
            A(f"- {g}")
    else:
        A("- None: every line above came from a live pull or a user-confirmed cost.")
    A("")
    return "\n".join(out)


def main():
    if "--example" in sys.argv:
        print(json.dumps(EXAMPLE, indent=2))
        return
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    data = json.load(open(sys.argv[1]))
    res = compute(data)
    prev = data.get("previous")
    prev_res = compute(prev) if prev else None
    if "--json" in sys.argv:
        print(json.dumps({"current": res, "previous": prev_res}, indent=2, default=str))
    else:
        print(render(data, res, prev_res))


if __name__ == "__main__":
    main()
