# Tazkarti New Match Notifier

Scrapes [tazkarti.com/#/matches](https://www.tazkarti.com/#/matches) every **5 minutes** and sends you a **WhatsApp notification** the moment a new match appears.

---

## Setup

### 1. Activate WhatsApp (CallMeBot — free, no account needed)

1. Save **+34 644 52 74 88** as a contact in WhatsApp (name it "CallMeBot")
2. Send the message: `I allow callmebot to send me messages`
3. You will receive your **API key** within seconds

### 2. Configure environment variables

Copy `.env.example` → `.env` and fill in your values:

```
WHATSAPP_PHONE=201012345678     ← your number, no + sign
CALLMEBOT_API_KEY=123456        ← the key CallMeBot sent you
```

### 3. Install & run

```bash
npm install   # also runs playwright install chromium
npm start
```

The server starts on port 3000. Visit `http://localhost:3000` to see status.
Use `GET /check` to manually trigger a scrape.

---

## Hosting

### Option A – Railway.app (recommended free tier)

Railway is **always-on** with no sleep, which is better than Replit's free tier.

1. Push this repo to GitHub
2. Create a new project at [railway.app](https://railway.app)
3. "Deploy from GitHub repo"
4. Add the env vars under **Variables**
5. Railway auto-detects Node.js and runs `npm start`

Free tier: 500 hours/month – more than enough for a single always-on service.

### Option B – Replit

1. Upload this folder or link your GitHub repo
2. Add env vars under **Secrets**
3. Click **Run**
4. To prevent the free-tier sleep: create a free [UptimeRobot](https://uptimerobot.com) monitor that pings your Replit URL every 5 minutes

---

## How it works

| Step | Detail |
|------|--------|
| Browser | Playwright (Chromium, headless) navigates to the matches page |
| View More | Clicks "View More" repeatedly until it disappears |
| Parsing | Extracts teams, date, time, stadium, tournament from each match block |
| Deduplication | Uses `Match No. X` as a unique key stored in memory |
| First run | Silently populates the baseline – no spam for existing matches |
| Notification | Sends a WhatsApp message for each new match ID seen for the first time |
