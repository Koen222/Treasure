# Willow Haven: accounts, scope, and cost table

Everything the P&L needs that is not in a live feed. Re-verify anything marked "verify" when it matters; when a live number disagrees with this file, trust the live number and say so in the report's data-gaps section.

## Accounts

| Source | Identifier | Notes |
|---|---|---|
| Shopify store | `willowhavenstore.com` (`xcwp1z-hr.myshopify.com`) | Base currency AUD, timezone AEST. All Shopify money is already in AUD. |
| Meta ad account | `1057831906408126` ("Willow Haven", business LensCreation) | Currency AUD. Windsor.ai connector `facebook`, account id `1057831906408126`. |
| Google Ads | `388-687-6870` ("Willow Haven") | Currency AUD. Windsor.ai connector `google_ads`. Only one Google account is connected, so no account filter needed. |
| Supplier cost sheet | Google Drive file "Willow Sales Record.sxlsx.xlsx", id `1dvBKMvwANGYZBWTucDGHGGrllHE7LI-A` | Shared by the supplier. Contains actual per-period dropship charges. The Drive text export is partial for this large file; use it as a cost check, not as a primary feed. |

## Ad spend scope

The Windsor `facebook` connector also carries the "New Burn Q" account (Weber Q campaigns). That is a separate brand. Always pass `accounts=["1057831906408126"]` on Meta pulls, and only count campaigns in that account. Within the Willow Haven account, count every campaign that ran in the period; assign markets by campaign name:

| Campaign name pattern | Market |
|---|---|
| contains `AUD` or `AU` | AU |
| contains `USA` or `US` | US |
| contains `NL`, `EU`, `BE` | Other |
| `Prospecting`, `English`, `Chute`, anything without a market token | Shared (charged to the total, not to a market) |

Google Ads campaigns ("PMax no negative", "Shopping Campaign", "PMAX 1") run in both AU and US. Pull them with the `country` field so spend splits by market exactly. If the country field ever fails, put Google spend on the Shared line rather than guessing a split.

## Markets

Group Shopify `billing_country` into three markets: `AU` (Australia), `US` (United States), `Other` (everything else: Netherlands, Belgium, Poland, Canada, NZ, UK, Ireland). Other is small and has no dedicated ad spend most months; keep it as one line so nothing falls out of the total.

## Cost of goods per unit (AUD)

Primary source: Shopify `inventoryItem.unitCost` per variant (pull live with the ProductCosts query in `data-pulls.md`). Cross-check: the supplier sheet's "Dropshipping Unit Price (AUD)". Where the supplier charges a different price for a market (US, NL, BE), use the market price. Values as of September 2026:

| Product (Shopify title) | AU | US | Other (NL/BE) | Source and notes |
|---|---|---|---|---|
| Acacia Wood Slider | 28 | 26 | 31 (NL) / 34 (BE) | Shopify 28; supplier sheet 26 for US, 31 NL, 34 BE |
| Bamboo Slider | 22 | 22 | 26 (NL) / 29 (BE) | Shopify 22; supplier sheet matches for AU/US |
| Ebony Walnut Slider | 40 | 40 | 40 | Shopify 40; not yet seen on the supplier sheet, verify |
| Acacia Wood Mixing Bowl | 88 | 88 | 92 (NL) / 98 (BE) | Shopify 88; supplier 85 AU/US. Keep 88 (conservative) |
| Cord Organizer for Stand Mixers (2 pack) | 6 | 6 | 6 | Shopify 6 per 2-pack; supplier 3.50 per unit |
| Stainless Steel Flex Edge Beater | 14 | 14 | 14 | Shopify 14; supplier 13 |
| Flex Edge Beater for 6 Qt Bowl-Lift (white) | 14 | 14 | 14 | No cost in Shopify; assume same as the other beater, flag as estimate |
| Pouring Chute | 12 | 12 | 12 | Shopify 10, supplier 12. Use 12 (conservative) |
| Attachment Holders, Two-Pack | 3.5 | 3.5 | 3.5 | Shopify 3.5 |
| Attachment Holders, Four-Pack | 7 | 7 | 7 | No cost in Shopify; 2 x two-pack, flag as estimate |
| Board & Bowl Butter | 14 | 14 | 14 | Shopify 14 |

Rows with an empty product title in ShopifyQL are adjustment lines (small negative net sales, 0 units). Keep their net sales in the market total (they are already inside the by-country pull) and give them zero COGS.

Unit costs include the supplier's shipping to the customer (dropship price). There is no separate freight line. Sliders sold in a bundle or as add-ons still cost their unit price each.

## Payment and FX fees

Shopify Payments, verified from order transactions (September 2026):

| Market | Rate applied to total sales | Detail |
|---|---|---|
| AU | 1.6% | domestic processing fee |
| US | 5.4% | 3.4% processing + 2.0% foreign-exchange fee |
| Other | 5.4% | treat like US (international card + FX) |

Re-verify by pulling five recent orders per market with the OrderFees query and reading `transactions.fees`. If the rates changed, update this table.

## GST

Willow Haven collects $0 GST on AU orders in Shopify (the `taxes` column for Australia is 0). AU turnover is far above the A$75k registration threshold, so GST is an accruing liability. The report shows profit two ways: "as collected" and "GST-provisioned", where the provision is 1/11 of AU total sales. US and Other are exports and carry no GST. The user should confirm registration status with their accountant; the skill does not give tax advice.

US `taxes` (a few hundred dollars) is US sales tax collected and remitted through Shopify; it is outside net sales and needs no adjustment.

## Fixed costs (monthly, AUD)

Not available from any connector. Ask the user once and record the answer here so future runs include it without asking again. Until filled, the report shows fixed costs as 0 and lists them under data gaps.

| Item | Monthly AUD | Status |
|---|---|---|
| Shopify plan | | not provided |
| Shopify apps (Klaviyo, reviews, upsell, etc.) | | not provided |
| Contractors / creative / VA | | not provided |
| Software (Windsor.ai, Canva, other) | | not provided |
| Other | | not provided |

When the period is not a calendar month, pro-rate fixed costs by days (monthly amount x days / 30.4).

## Sanity ranges (September 2026)

Use these to catch a broken pull, not as targets. Numbers far outside them mean check the query before trusting the report.

| Metric | Typical range (30 days) |
|---|---|
| Net sales | A$140k to A$180k |
| Orders | 1,000 to 1,300 |
| Meta spend (WH account) | A$55k to A$80k |
| Google spend | A$3k to A$6k |
| Blended MER | 2.0 to 2.8 |
| COGS as % of net sales | 22% to 30% |
| Return rate | 1% to 2% |
| Repeat customer rate | 4% to 6% |
| US AOV | A$145 to A$160; AU AOV A$105 to A$115 |
