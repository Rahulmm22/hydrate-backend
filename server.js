// server.js - Hydrate backend (final updated version)

require('dotenv').config();
const express = require('express');
const webpush = require('web-push');
const bodyParser = require('body-parser');
const cors = require('cors');
const cron = require('node-cron');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '256kb' }));

const PORT = Number(process.env.PORT) || 4000;

// VAPID keys from env (set these via fly secrets)
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || null;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || null;

// Frontend URL used in notification payloads (override with env if you host elsewhere)
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://rahulmm22.github.io/hydrate-frontend';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails('mailto:you@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    console.log('VAPID keys loaded');
  } catch (e) {
    console.warn('Failed to set VAPID details:', e && e.message);
  }
} else {
  console.warn('VAPID keys are not set. Push will fail until configured.');
}

// Persistent storage path (Fly volume mounted at /data)
const DATA_DIR = '/data';
const DB_PATH = path.join(DATA_DIR, 'db.json');

// --- DB helpers ---
async function ensureDataDir() {
  try {
    await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  } catch (e) {
    // ignore mkdir errors; we'll catch write errors later
  }
}
async function readDB() {
  try {
    const raw = await fs.readFile(DB_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { users: [] };
  }
}
async function writeDB(data) {
  const tmp = DB_PATH + '.tmp';
  await ensureDataDir();
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, DB_PATH);
}

// --- helpers to manage users/reminders ---
function findUserByEndpoint(data, endpoint) {
  return data.users.find(u => u.subscription && u.subscription.endpoint === endpoint);
}
function addOrUpdateUserInData(data, subscription) {
  const endpoint = subscription.endpoint;
  let user = findUserByEndpoint(data, endpoint);
  if (!user) {
    user = { id: crypto.randomBytes(8).toString('hex'), subscription, reminders: [] };
    data.users.push(user);
  } else {
    user.subscription = subscription;
  }
  return user;
}

// --- endpoints ---

// health
app.get('/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// return public VAPID key (frontend fetches this)
app.get('/vapidPublicKey', (req, res) => {
  if (!VAPID_PUBLIC_KEY) return res.status(500).send('VAPID key not configured');
  res.send(VAPID_PUBLIC_KEY);
});

// subscribe - store subscription and return assigned userId
app.post('/subscribe', async (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });

  const db = await readDB();
  const user = addOrUpdateUserInData(db, sub);
  await writeDB(db);
  res.json({ success: true, userId: user.id });
});

// add reminder - expects subscription + time + options
app.post('/addReminder', async (req, res) => {
  const { subscription, time, timezoneOffsetMinutes, repeatEveryMinutes, repeatUntil } = req.body;
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'subscription required' });
  if (!time) return res.status(400).json({ error: 'time (HH:MM) required' });

  const db = await readDB();
  const user = addOrUpdateUserInData(db, subscription);

  const newRem = {
    id: crypto.randomBytes(6).toString('hex'),
    time,
    timezoneOffsetMinutes: Number(timezoneOffsetMinutes || 0),
    repeatEveryMinutes: Number(repeatEveryMinutes || 0),
    repeatUntil: repeatUntil || null,
    lastSentISO: null
  };

  user.reminders = user.reminders || [];
  user.reminders.push(newRem);

  await writeDB(db);
  res.json({ success: true, reminders: user.reminders });
});

// sendNotification - manual broadcast (keeps existing logic)
app.post('/sendNotification', async (req, res) => {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return res.status(500).json({ error: 'VAPID keys not set' });

  const payload = req.body.payload || {
    title: 'Hydrate',
    body: 'Time to drink water 💧',
    url: FRONTEND_URL
  };

  webpush.setVapidDetails('mailto:you@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const db = await readDB();
  const results = [];

  for (const user of (db.users || []).slice()) {
    try {
      await webpush.sendNotification(user.subscription, JSON.stringify(payload));
      results.push({ endpoint: user.subscription.endpoint, success: true });
    } catch (err) {
      results.push({ endpoint: user.subscription.endpoint, success: false, error: err && (err.statusCode || err.body || err.message) });
      if (err && (err.statusCode === 410 || err.statusCode === 404)) {
        const idx = db.users.findIndex(u => u.subscription.endpoint === user.subscription.endpoint);
        if (idx >= 0) db.users.splice(idx, 1);
      }
    }
  }

  await writeDB(db);
  res.json({ success: true, results });
});

// list subscriptions (summary)
app.get('/subs', async (req, res) => {
  const db = await readDB();
  const users = (db.users || []).map(u => ({ id: u.id, reminders: (u.reminders || []).length }));
  res.json({ count: users.length, users });
});

// get full reminders for a user id (frontend depends on this)
app.get('/user/:id/reminders', async (req, res) => {
  const id = req.params.id;
  const db = await readDB();
  const user = (db.users || []).find(u => u.id === id);
  if (!user) return res.status(404).json({ success: false, error: 'user not found' });
  res.json({ success: true, reminders: user.reminders || [] });
});

// delete a reminder by id (frontend delete button calls this)
app.post('/deleteReminder', async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ success: false, error: 'id required' });

  const db = await readDB();
  let changed = false;

  for (const user of db.users || []) {
    const idx = (user.reminders || []).findIndex(r => r.id === id);
    if (idx !== -1) {
      user.reminders.splice(idx, 1);
      changed = true;
      break;
    }
  }

  if (changed) {
    await writeDB(db);
    return res.json({ success: true });
  } else {
    return res.status(404).json({ success: false, error: 'not found' });
  }
});

// --- scheduling helpers ---
function shouldFireReminder(rem, nowUtcMs) {
  const tz = Number(rem.timezoneOffsetMinutes || 0);
  const userLocalMs = nowUtcMs - tz * 60 * 1000;
  const userLocal = new Date(userLocalMs);
  const [sh, sm] = (rem.time || '00:00').split(':').map(Number);

  // no repeat: fire exactly at the minute
  if (!rem.repeatEveryMinutes || rem.repeatEveryMinutes <= 0) {
    if (userLocal.getHours() === sh && userLocal.getMinutes() === sm) {
      if (rem.lastSentISO) {
        const last = new Date(rem.lastSentISO);
        if (nowUtcMs - last.getTime() < 70 * 1000) return false;
      }
      return true;
    }
    return false;
  }

  // repeated schedule
  const scheduledLocalStart = new Date(userLocal.getFullYear(), userLocal.getMonth(), userLocal.getDate(), sh, sm, 0, 0);
  const scheduledUtcMs = scheduledLocalStart.getTime() + tz * 60 * 1000;
  if (nowUtcMs < scheduledUtcMs) return false;

  if (rem.repeatUntil) {
    const [uh, um] = rem.repeatUntil.split(':').map(Number);
    const untilLocal = new Date(userLocal.getFullYear(), userLocal.getMonth(), userLocal.getDate(), uh, um, 59, 999);
    const untilUtcMs = untilLocal.getTime() + tz * 60 * 1000;
    if (nowUtcMs > untilUtcMs) return false;
  }

  const diffMin = Math.floor((nowUtcMs - scheduledUtcMs) / (60 * 1000));
  if (diffMin < 0) return false;
  if (diffMin % rem.repeatEveryMinutes === 0) {
    if (rem.lastSentISO) {
      const last = new Date(rem.lastSentISO);
      if (nowUtcMs - last.getTime() < 70 * 1000) return false;
    }
    return true;
  }
  return false;
}

// Cron: runs every minute and sends notifications when scheduled
cron.schedule('* * * * *', async () => {
  try {
    const db = await readDB();
    const nowUtcMs = Date.now();

    for (const user of (db.users || []).slice()) {
      user.reminders = user.reminders || [];
      for (const rem of user.reminders.slice()) {
        try {
          if (shouldFireReminder(rem, nowUtcMs)) {
            const payload = {
              title: 'Hydrate — Reminder',
              body: `Time: ${rem.time} — Drink water 💧`,
              url: FRONTEND_URL
            };

            try {
              if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) throw new Error('VAPID keys missing');
              await webpush.sendNotification(user.subscription, JSON.stringify(payload));
              rem.lastSentISO = new Date().toISOString();
              console.log('Sent reminder to', user.subscription.endpoint, 'time', rem.time);
            } catch (err) {
              console.warn('Send error', err && (err.statusCode || err.message));
              if (err && (err.statusCode === 410 || err.statusCode === 404)) {
                const idx = db.users.findIndex(u => u.subscription.endpoint === user.subscription.endpoint);
                if (idx >= 0) db.users.splice(idx, 1);
              }
            }
          }
        } catch (innerErr) {
          console.error('Reminder check error', innerErr && innerErr.message);
        }
      } // end rem loop
    } // end user loop

    await writeDB(db);
  } catch (e) {
    console.error('Cron error', e && e.message);
  }
});

// simple root page so visiting / doesn't return "Cannot GET /"
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`
    <html>
      <head><title>Hydrate Backend</title>
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <style>
          body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px;background:#071021;color:#e6eef8}
          a{color:#9be7ff}
          .box{max-width:780px;padding:24px;border-radius:12px;background:#071a2b;}
        </style>
      </head>
      <body>
        <div class="box">
          <h1>Hydrate Backend</h1>
          <p>Server is running. Available endpoints:</p>
          <ul>
            <li><a href="/subs" target="_blank">/subs</a> — subscription list (JSON)</li>
            <li><a href="/vapidPublicKey" target="_blank">/vapidPublicKey</a> — public VAPID key</li>
            <li>POST <code>/subscribe</code>, <code>/addReminder</code>, <code>/deleteReminder</code>, <code>/sendNotification</code></li>
            <li>GET <code>/user/:id/reminders</code> — reminders for a specific user</li>
            <li>GET <code>/health</code> — health check</li>
          </ul>
          <p>Frontend URL used in notifications: <code>${FRONTEND_URL}</code></p>
        </div>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
