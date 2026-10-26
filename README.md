# ACC Daily Briefing (v2)

Pulls Arizona Corporation Commission activity straight from ACC systems every morning,
summarizes it in plain language with Claude (via Netlify AI Gateway), and shows a briefing
you can copy into Gmail with formatting and links intact.

## What it pulls
- **Docket activity, last 48 hours** — eDocket's own data feed (`efiling.azcc.gov/api/eDocket/GetRecentDockets`),
  plus each docket's newly filed documents (type, filer, party, date) with direct links.
- **Events & hearings, today + 7 days** — the ACC calendar feed (`GetDates`), with rooms, dockets and dial-in lines.
- **ACC news releases, last 48 hours** — azcc.gov/news/home, full release text summarized.
- **Local press, last 48 hours** — Claude web search; any article whose link didn't come from the actual
  search results is dropped.

## How it runs
- `netlify/functions/daily-briefing.mts` — scheduled, 6:00 AM Arizona (13:00 UTC; Arizona has no DST).
- `netlify/functions/generate.mts` — background function (up to 15 min) that builds the briefing and saves it to Netlify Blobs.
- `netlify/functions/briefing.mts` — `GET /api/briefing` returns the latest briefing (or `?date=YYYY-MM-DD`).
- `netlify/lib/briefing.mts` — data collection, Claude calls, and email-safe HTML rendering.

## Deploy (from this folder, in a normal terminal)
```
npx netlify-cli login
npx netlify-cli deploy --build --prod --site 845385c6-ef51-4494-aac5-48cf21ccd589
```

## AI credentials
By default the Anthropic SDK uses the credentials Netlify AI Gateway injects (credit-based plans, after the first
production deploy). To use your own Anthropic key instead, set `ANTHROPIC_API_KEY` in
Site configuration → Environment variables (scope: Functions) and redeploy. Optional: `BRIEFING_MODEL` to pin a model.

## Email delivery (Resend)
- `netlify/functions/send-briefing.mts` — scheduled 6:30 AM Arizona (13:30 UTC), 30 min after the build.
  Sends today's briefing once per day. If today's build failed or the summaries failed, it goes to the
  team only, marked "[Not sent]" / "[Held for review]", and never to the distribution list.
- `POST /api/send-test` — sends the latest briefing to the team only (max one per 10 minutes).

Netlify environment variables (Site configuration → Environment variables, scope: Functions):

| Variable | Value |
|---|---|
| `RESEND_API_KEY` | API key from resend.com → API Keys (sending access) |
| `BRIEFING_FROM` | optional; default `Pacheco ACC Briefing <briefing@pachecoaz.com>` |
| `BRIEFING_REPLY_TO` | team addresses, comma-separated. Replies go to all of them; they're on the To: line. |
| `BRIEFING_RECIPIENTS` | distribution list, comma-separated (sent as Bcc). Leave empty to send to the team only. |

Resend setup: add and verify the domain `pachecoaz.com` (Resend shows the SPF/DKIM DNS records to add).
