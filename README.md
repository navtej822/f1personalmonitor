# F1 Personal Monitor (MVP)

This web app pulls race lap data from the OpenF1 API and lets you:

- view lap times for all drivers in a race session,
- filter drivers from a searchable list,
- compare multiple drivers in a table and line chart.

## Run locally

```bash
python3 -m http.server 4173
```

Then open <http://localhost:4173>.

## OpenF1 integration details

- API base: `https://api.openf1.org/v1`
- Race sessions are loaded via `/sessions?year=<YEAR>&session_name=Race`
- Driver and lap data are loaded via `/drivers?session_key=<SESSION_KEY>` and `/laps?session_key=<SESSION_KEY>`
- The app defaults to the Australian race for the selected year when present.
