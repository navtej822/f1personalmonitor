# F1 Personal Monitor (MVP)

This web app pulls race lap data from the OpenF1 API and lets you:

- view lap times for all drivers in a race session,
- filter drivers from a searchable list,
- compare multiple drivers in a table and line chart,
- compare a specific lap range (for example lap 10 to lap 20) across selected drivers,
- inspect Phase 1 analytics:
  - average/median race pace cards,
  - two-driver head-to-head race pace delta,
  - qualifying best-lap delta,
  - stint timeline by compound.

## Run locally

```bash
python3 -m http.server 4173
```

Then open <http://localhost:4173>.

## OpenF1 integration details

- API base: `https://api.openf1.org/v1`
- Race sessions are loaded via `/sessions?year=<YEAR>&session_name=Race`
- Driver/lap/stint data are loaded via:
  - `/drivers?session_key=<SESSION_KEY>`
  - `/laps?session_key=<SESSION_KEY>`
  - `/stints?session_key=<SESSION_KEY>`
- API client includes rate-limit handling (paced requests), retry-on-429 with backoff, and short-lived response caching to reduce duplicate calls
- Qualifying comparison loads qualifying session within the same meeting via:
  - `/sessions?meeting_key=<MEETING_KEY>&session_name=Qualifying`
  - `/laps?session_key=<QUALI_SESSION_KEY>`
