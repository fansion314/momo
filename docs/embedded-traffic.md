# Embedded usage analytics

The usage page adapts the Overview, Rules, Domains, Regions and Proxies modules
from the supplied neko-master dashboard. It runs inside the existing Electron
renderer and Vite build. It does not start Next.js, a collector, an agent, a
second HTTP listener or a backend-selection service. The application owns the
window header, language and theme; the embedded toolbar contains module
navigation, the time range, refresh and recording/display settings.

## Data integration

`src/renderer/src/components/traffic/embedded/` contains the embedded UI and its
query adapter. The existing IPC methods `trafficHistoryStatus` and
`queryTrafficHistory` access the authenticated kernel `/traffic-history` API:

- Overview: `summary`, `series`, and `groups` for domains, policies, proxies,
  countries and destination IPs.
- Rules: top-level policy distribution and rankings. This uses the API's
  `policy` dimension (last chain hop). The related **Matched rules** table
  groups original `rule,rulePayload` pairs, with exact filtering on both fields.
- Domains: domain/IP rankings, search, sorting, pagination and CSV/JSON export.
- Regions: a bundled offline world map plus country usage details. Local and
  unknown values remain visible in the table even when no map polygon exists.
- Proxies: first-chain-hop proxy distribution and rankings.
- Related details: exact filters propagate to domain/IP/proxy/country groups,
  original rules, ordered rule/policy/chain routes and retained connection
  records. Further drilldowns retain preceding filters. Connection paging
  freezes its range; refresh or changing the selection resets it.

Queries share fixed range bounds per dashboard refresh. Reads run sequentially
and stop issuing further requests after their view is disposed. Background
refresh waits ten seconds after the prior read completes and skips hidden
documents. Failed refreshes leave the last successful dashboard visible with
an error; changing the query clears the previous dashboard.

Daily queries retain the existing saved-timezone boundaries, permanent daily
aggregation and raw-record retention controls. They never request individual
connections. Connection counts mean newly observed connections, rather than
sums of participating connections across days. Average speed divides recorded
bytes by the actual bucket duration, including partial raw buckets and DST
days; it does not infer live speed from a sliding cumulative total.

The kernel returns at most 1,000 top groups. Loaded group counts, shares and
exports describe those results; truncated counts show `+` and the UI indicates
that additional results exist. Empty and failed reads have distinct states.

## Upstream attribution

Adapted from neko-master's dashboard content, stats cards, overview ranking
cards, interactive rules/proxies, domain tables and country-map design:
`apps/web/app/[locale]/dashboard/components/content/`,
`apps/web/components/overview/`, and `apps/web/components/features/`.
The MIT notice is retained in `resources/licenses/neko-master.txt`.

`world-map.json` contains preprojected SVG country paths derived from the
supplied `apps/web/public/topojson/countries-110m.json` (Natural Earth / world
atlas geography). The map uses a Natural Earth projection fitted to a
960 × 470 viewbox; ISO numeric identifiers are matched to ISO alpha-2 codes.
All geometry and flag assets ship locally; no remote map or favicon requests
are made.

## Validation

Run the repository format, lint and TypeScript checks, the embedded adapter and
existing traffic-history tests, and `pnpm run build:linux`. The adapter tests
cover shared query bounds, truncation, failed reads, compound exact filters,
gap filling, partial buckets and 25-hour days. Browser QA uses an isolated
preview harness with fixture IPC responses; it does not write user history or
change the running kernel's settings.
