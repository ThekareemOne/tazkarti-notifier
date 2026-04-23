require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { chromium } = require('playwright');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── In-memory state ─────────────────────────────────────────────────────────
// Key: "Match No. X"  Value: full match summary text
const knownMatches = new Map();
let isFirstRun = true;
let lastChecked = null;
let lastError = null;

// ─── WhatsApp via TextMeBot ───────────────────────────────────────────────────
async function sendWhatsApp(message) {
  const phone = process.env.WHATSAPP_PHONE;
  const apiKey = process.env.TEXTMEBOT_API_KEY;

  if (!phone || !apiKey) {
    console.warn('[notifier] WHATSAPP_PHONE or TEXTMEBOT_API_KEY not set – skipping notification');
    return;
  }

  // TextMeBot expects the number without a leading '+' sign
  const recipient = phone.replace(/^\+/, '');
  const url = `https://api.textmebot.com/send.php?recipient=${recipient}&apikey=${apiKey}&text=${encodeURIComponent(message)}`;

  try {
    const res = await axios.get(url, { timeout: 15000 });
    console.log('[notifier] WhatsApp response:', res.status, String(res.data).slice(0, 200));
  } catch (err) {
    const body = err.response?.data ? String(err.response.data).slice(0, 300) : '(no body)';
    console.error(`[notifier] Failed to send WhatsApp: ${err.message} | body: ${body}`);
  }
}

// ─── Scraper ──────────────────────────────────────────────────────────────────
/**
 * Returns an array of match objects:
 *   { id, homeTeam, awayTeam, date, time, stadium, tournament, status, raw }
 */
async function scrapeMatches() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
    ],
  });

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    await page.goto('https://www.tazkarti.com/#/matches', {
      waitUntil: 'networkidle',
      timeout: 60000,
    });

    // Give Angular time to fully render
    await page.waitForTimeout(3000);

    // Click every "View More" button until none remain or it stays disabled
    const btnLocator = page.locator('button').filter({
      hasText: /view more/i,
    }).first();

    let clicks = 0;
    while (clicks < 10) {
      // Wait up to 8 s for the button to appear and become enabled
      const enabled = await btnLocator
        .waitFor({ state: 'visible', timeout: 8000 })
        .then(() => btnLocator.isEnabled({ timeout: 8000 }))
        .catch(() => false);

      if (!enabled) break;

      await btnLocator.click();
      // Wait for new content to load before looking for the button again
      await page.waitForTimeout(2000);
      clicks++;
    }

    // Extract match data from the rendered DOM
    const matches = await page.evaluate(() => {
      // tazkarti uses Angular – match rows are typically inside repeated elements
      // We look for any container whose text contains "Match No."
      const allEls = Array.from(document.querySelectorAll('*'));
      const matchContainers = allEls.filter((el) => {
        const direct = Array.from(el.childNodes).some(
          (n) => n.nodeType === Node.TEXT_NODE && /Match No\./i.test(n.textContent)
        );
        return direct || (el.children.length < 20 && /Match No\./i.test(el.innerText || '') &&
          !/Match No\./i.test(el.parentElement?.innerText?.replace(el.innerText, '') || ''));
      });

      // If Angular component approach is available, use it
      const cards = document.querySelectorAll(
        'app-match-card, app-event-card, [class*="match-card"], [class*="match-item"], [class*="event-card"], [class*="event-item"]'
      );

      const source = cards.length > 0 ? Array.from(cards) : matchContainers;

      return source.map((el) => {
        const text = (el.innerText || el.textContent || '').trim().replace(/\s{2,}/g, ' ');
        return text;
      }).filter((t) => t.length > 20 && /Match No\./i.test(t));
    });

    return matches;
  } finally {
    await browser.close();
  }
}

// ─── Match parser ─────────────────────────────────────────────────────────────
function parseMatch(raw) {
  // Extract "Match No. X" as unique ID
  const idMatch = raw.match(/Match No\.\s*(\d+)/i);
  const id = idMatch ? `match-${idMatch[1]}` : null;

  // Teams: "Team A vs Team B"
  const vsMatch = raw.match(/(.+?)\s+vs\s+(.+?)(?:\s+[A-Z][a-z]|\s+\d)/);
  const homeTeam = vsMatch ? vsMatch[1].trim() : '';
  const awayTeam = vsMatch ? vsMatch[2].trim() : '';

  // Date + time
  const dateMatch = raw.match(/(\w{3}\s+\d{1,2}\s+\w+\s+\d{4})/);
  const timeMatch = raw.match(/Time\s*:\s*(\d{1,2}\s*:\s*\d{2}\s*[AP]M)/i);

  // Stadium
  const stadiumMatch = raw.match(/([^,\n]+Stadium[^,\n]*)/i);

  // Tournament
  const tournamentMatch = raw.match(/Tournament\s+(.+?)(?:\s+Match|\s+Group|$)/i);

  // Status
  const status = /Match Ended/i.test(raw)
    ? 'ended'
    : /Book Ticket/i.test(raw)
    ? 'available'
    : /Sold Out/i.test(raw)
    ? 'sold_out'
    : 'unknown';

  return {
    id,
    homeTeam,
    awayTeam,
    date: dateMatch ? dateMatch[1] : '',
    time: timeMatch ? timeMatch[1] : '',
    stadium: stadiumMatch ? stadiumMatch[1].trim() : '',
    tournament: tournamentMatch ? tournamentMatch[1].trim() : '',
    status,
    raw,
  };
}

// ─── Core check ──────────────────────────────────────────────────────────────
async function checkForNewMatches() {
  console.log(`[${new Date().toISOString()}] Checking tazkarti.com for new matches…`);

  try {
    const rawMatches = await scrapeMatches();
    lastChecked = new Date();
    console.log(`[scraper] Found ${rawMatches.length} match block(s) on page`);

    const parsed = rawMatches.map(parseMatch).filter((m) => m.id !== null);

    if (isFirstRun) {
      // Populate baseline – don't send notifications for existing matches
      parsed.forEach((m) => knownMatches.set(m.id, m));
      isFirstRun = false;
      console.log(`[state] First run complete – stored ${knownMatches.size} known match(es)`);
      return;
    }

    // Detect genuinely new matches (ID not seen before)
    const newMatches = parsed.filter((m) => !knownMatches.has(m.id));

    if (newMatches.length > 0) {
      console.log(`[state] ${newMatches.length} new match(es) detected!`);

      // Register all new matches first
      newMatches.forEach((m) => knownMatches.set(m.id, m));

      // Build one combined message for all new matches
      const matchLines = newMatches.map((match) => {
        return [
          `⚽ ${match.homeTeam} vs ${match.awayTeam}`,
          match.date && match.time ? `📅 ${match.date}  🕐 ${match.time}` : match.date || '',
          match.stadium ? `🏟️ ${match.stadium}` : '',
          match.tournament ? `🏆 ${match.tournament}` : '',
          match.status === 'available' ? `✅ Tickets available` : `Status: ${match.status}`,
        ].filter(Boolean).join('\n');
      });

      const message = [
        `🎟️ ${newMatches.length} new match(es) on Tazkarti!`,
        ``,
        matchLines.join('\n\n'),
        ``,
        `https://www.tazkarti.com/#/matches`,
      ].join('\n');

      await sendWhatsApp(message);
    } else {
      console.log('[state] No new matches found');
    }

    lastError = null;
  } catch (err) {
    lastError = err.message;
    console.error('[error]', err.message);
  }
}

// ─── Express routes ───────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    service: 'tazkarti-notifier',
    status: 'running',
    knownMatches: knownMatches.size,
    isFirstRun,
    lastChecked: lastChecked ? lastChecked.toISOString() : null,
    lastError: lastError || null,
  });
});

// Manual trigger (useful for testing)
app.get('/check', async (_req, res) => {
  res.json({ message: 'Check triggered – see server logs' });
  await checkForNewMatches();
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`[server] Tazkarti notifier listening on port ${PORT}`);
  // Run immediately on startup
  await checkForNewMatches();
});

// Schedule every 5 minutes
cron.schedule('*/5 * * * *', checkForNewMatches);
