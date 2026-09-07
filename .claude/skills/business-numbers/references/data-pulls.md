# Data pulls: the exact queries, tested September 2026

Tool names are session-specific. Discover them with ToolSearch before the first call:

- Shopify: search `select:mcp__Shopify__run-analytics-query,mcp__Shopify__graphql_query,mcp__Shopify__validate_graphql_codeblocks`
- Windsor.ai (Meta and Google Ads): `select:mcp__Windsor_ai__get_data,mcp__Windsor_ai__get_connectors`
- Meta Ads (optional cross-check): `select:mcp__Meta_connector__ads_get_ad_entities`
- Google Drive (optional supplier sheet): `select:mcp__Google_Drive__read_file_content`

Run every pull for the current period and again for the comparison period. All the calls below are independent, so fire them in one batch. Replace `START` / `END` with `YYYY-MM-DD` dates; both ends are inclusive in every source.

## Shopify (ShopifyQL via `run-analytics-query`)

Sales by market. This is the revenue base. `net_sales` = gross - discounts - returns, before tax and shipping; `total_sales` adds shipping and tax and is what the customer paid (the base for payment fees and the GST provision).

```
FROM sales SHOW orders, gross_sales, discounts, returns, net_sales, shipping_charges, taxes, total_sales, average_order_value GROUP BY billing_country ORDER BY net_sales DESC SINCE START UNTIL END
```

Units by market and product. Drives COGS. Note the column is `net_items_sold` (not `net_quantity`). Raise LIMIT if the store adds products.

```
FROM sales SHOW net_items_sold, net_sales, orders GROUP BY billing_country, product_title ORDER BY net_sales DESC SINCE START UNTIL END LIMIT 60
```

Customers:

```
FROM sales SHOW customers, new_customers, returning_customers, returning_customer_rate SINCE START UNTIL END
```

Sessions and conversion by country:

```
FROM sessions SHOW sessions, sessions_that_completed_checkout, conversion_rate GROUP BY session_country ORDER BY sessions DESC SINCE START UNTIL END LIMIT 10
```

Daily trend (optional, for the "what changed" read and for spotting a broken day):

```
FROM sales SHOW orders, net_sales TIMESERIES day SINCE START UNTIL END
```

Check: the by-country `net_sales` rows must sum to the store total from a query without GROUP BY. If they do not, something is off with the date range; re-run before continuing.

## Shopify product unit costs (GraphQL via `graphql_query`)

Already validated against the Admin schema. Pass `variables: {"first": 50}`.

```graphql
query ProductCosts($first: Int!, $after: String) {
  products(first: $first, after: $after, query: "status:active") {
    pageInfo { hasNextPage endCursor }
    nodes {
      title
      variants(first: 20) {
        nodes { title sku price inventoryItem { unitCost { amount currencyCode } } }
      }
    }
  }
}
```

Map each ShopifyQL `product_title` to the unit cost of its variants (variants of one product share a cost here). Apply the per-market overrides in `willow-haven.md`. A variant with `unitCost: null` has no cost in Shopify; use the reference table's estimate and list it under data gaps.

## Shopify payment fee check (GraphQL, only when re-verifying rates)

```graphql
query OrderFees($first: Int!, $after: String, $q: String) {
  orders(first: $first, after: $after, query: $q, sortKey: CREATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      name createdAt billingAddress { countryCodeV2 }
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      transactions(first: 5) { kind status amountSet { shopMoney { amount } } fees { amount { amount currencyCode } rate type } }
    }
  }
}
```

`variables: {"first": 10, "q": "created_at:>=START"}`. Read `fees[].rate` and `type` (`processing_fee`, `foreign_exchange_fee`). Sum the rates per market. Do not paginate the whole period; five orders per market is enough to confirm the rate table.

## Meta Ads spend (Windsor.ai `get_data`, connector `facebook`)

Always scope to the Willow Haven account. Windsor's `date_from`/`date_to` are inclusive.

```
get_data(connector="facebook",
         accounts=["1057831906408126"],
         fields=["campaign","spend","impressions","clicks","actions_purchase","action_values_purchase"],
         date_from="START", date_to="END")
```

`actions_purchase` and `action_values_purchase` are Meta-attributed, not Shopify orders. Use them for platform ROAS/CPA only. Assign each campaign to a market by its name (rules in `willow-haven.md`).

Optional cross-check with the Meta connector (account-level `amount_spent` over the same `time_range`): the two should agree within about 2%. If they do not, report both and use Windsor for the P&L, since it is the one with campaign detail.

## Google Ads spend (Windsor.ai `get_data`, connector `google_ads`)

```
get_data(connector="google_ads",
         fields=["country","campaign","spend","impressions","clicks","conversions","conversion_value"],
         date_from="START", date_to="END")
```

`country` splits each campaign's spend by the user's location, which maps straight to the AU / US markets. `conversions` is fractional (data-driven attribution); treat it as a platform claim like Meta's. `spend` and `cost` are the same field. Currency is AUD.

## Supplier sheet (optional)

Only when the user asks to reconcile COGS against what the supplier actually billed, or when Shopify unit costs look wrong. Read the Drive file by id (see `willow-haven.md`), find the period blocks (rows begin with a date-range label such as `May16-May23`), and compare "Actual Shipment Amount (AUD)" for the overlapping period against the COGS the script computed. The text export of this file is partial; if the period is missing from the export, say so rather than estimating.

## Alignment notes

- Shopify reports in AEST; Meta and Google accounts are also set to Australian time, so calendar dates line up. Do not mix "last 30 days" presets across tools; always pass explicit dates so every source covers the same days.
- Yesterday is the last complete day in every source. Do not include today; ad spend for today is partial and Meta attribution for the last one to two days is still filling in.
- ShopifyQL `SINCE` / `UNTIL` and Windsor `date_from` / `date_to` are all inclusive of both ends.
