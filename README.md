# F1 Personal Monitor (MVP)

This starter web app pulls race lap data from the OpenF1 API and lets you:

- view lap times for all drivers in a race session,
- filter drivers from a searchable list,
- compare multiple drivers in a table and line chart.

## Run locally

```bash
python3 -m http.server 4173
```

Then open <http://localhost:4173>.

## Notes

- Data source: `https://api.openf1.org/v1`
- Current implementation is a front-end MVP with direct API calls.
- Next iterations can add backend caching, telemetry overlays, and advanced analytics.
