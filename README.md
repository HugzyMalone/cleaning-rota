# Flat Cleaning Rota

A one-page rota for three housemates. Open the link on your phone, tick things off as you do them, everyone sees it live. No accounts, no app to install.

**Rooms:** kitchen, bathroom, living room · **Start:** Monday 14 September 2026 · **Week:** Monday to Sunday, do it whenever suits.

## How the rotation works

Three people, three rooms, so it cycles every three weeks and nobody can end up with the kitchen twice in a row:

| Week of | 🍳 Kitchen | 🛁 Bathroom | 🛋️ Living room |
|---|---|---|---|
| Mon 14 Sep | Hugo | Adam | Harry |
| Mon 21 Sep | Harry | Hugo | Adam |
| Mon 28 Sep | Adam | Harry | Hugo |
| …and repeat | | | |

It's worked out from the date, not stored anywhere, so it keeps going forever. Tap a name to swap rooms with someone — that applies to **that week only**.

## Setup (once)

### 1. Create the database

1. Sign up at [supabase.com](https://supabase.com) (free, GitHub login works) and create a project — any name, any region near the UK.
2. Open **SQL Editor** → New query → paste all of [`supabase/schema.sql`](supabase/schema.sql) → **Run**.
3. Go to **Project Settings → API** and copy the **Project URL** and the **anon public** key.

### 2. Point the app at it

Put those two values in [`config.js`](config.js):

```js
export const SUPABASE_URL = "https://xxxxxxxx.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOi…";
```

Commit and push — GitHub Pages redeploys in about a minute.

### 3. Share it

Send the link to your housemates. On a phone: **Share → Add to Home Screen** gives it an icon and opens it fullscreen like an app.

## Changing things

| What | Where |
|---|---|
| Tasks (add, rename, delete) | In the app — expand a room, tap **Edit tasks** |
| Who lives here | `PEOPLE` in `config.js` |
| Start date | `START_MONDAY` in `config.js` (must be a Monday) |
| Room names and emoji | The `rooms` table in Supabase |

## Running it locally

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Notes

- **Without Supabase configured** the app still works, but saves only to that one device — the footer says so.
- The anon key being public is how Supabase is designed to work, but it does mean anyone with the link can tick a box. Fine for a cleaning rota; if it ever matters, add a shared passphrase gate.
- Ticks are stored per week, so old weeks stay intact and you can look back at who actually did what.
