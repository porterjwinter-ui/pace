# Pace

A phone-first calendar that schedules your tasks for you. Add a task, say when it's due and how long it'll take ("History essay, due Friday, 5h"), and Pace spreads the work across your free time before the deadline, finishing early so there's buffer. Add something personal like swimming and the plan moves around it. Check sessions off as you go.

**Live app:** https://porterjwinter-ui.github.io/pace/

## Install on your phone

1. Open the link above in Safari (iPhone) or Chrome (Android).
2. iPhone: tap **Share → Add to Home Screen**. Android: tap **⋮ → Add to Home screen / Install app**.
3. Open Pace from your home screen. It runs full-screen and works offline.

## First-time setup

### 1. A private repository for your data
Create an empty **private** repository, for example `pace-data`
([new private repo](https://github.com/new?name=pace-data&visibility=private)).

### 2. A GitHub token that can only touch that repo
[Create a fine-grained token](https://github.com/settings/personal-access-tokens/new?name=Pace%20sync&contents=write&expires_in=366):
- **Repository access:** Only select repositories → your data repo
- **Permissions → Repository → Contents:** Read and write
- Nothing else

### 3. Create your account in Pace
Choose **My private GitHub repo**, enter the repo as `owner/name`, and paste the token.
Your username and password are yours alone. There's no reset, so keep the password somewhere safe.

On another device, choose **Sign in → First time on this device? Sign in with GitHub** and enter the same repo and token once.

### 4. (Optional) The assistant
Tap a day (or the Assistant tab) and paste an [OpenRouter API key](https://openrouter.ai/keys). The default model is
**Gemini Flash (latest)** (`~google/gemini-flash-latest`). You can switch models in Settings → Assistant. Consider setting a credit limit on the key.

The assistant sees your plan for the day/week/month you opened it from and can add tasks and events, move or check off sessions, and replan. Every change it makes can be undone from the chat.

## How the planner works

- **Work hours:** Pace only schedules inside the hours you set in Settings → Schedule (presets for after school, 9–5, evenings, or custom per day).
- **Busy events** (yours or imported) block time, with a short break before and after.
- **Tasks** are planned earliest-deadline-first. Each task's hours are spread evenly over the days available, in sessions between your shortest and longest session length, never exceeding your daily maximum.
- **Buffer:** tasks aim to finish a set time before they're due (default 1 day). If that's impossible Pace uses the buffer and marks the task *Tight*; if even that isn't enough it shows *Not enough time*.
- **Missed sessions** stay visible (striped) until you check them off or reschedule them; the time is made up later.
- **Drag** (long-press on a phone) a session to pin it to a time; the rest of the plan flows around it.

## Importing calendars

Anything that exports **.ics** or **.csv** works: Google Calendar, Apple Calendar, Outlook, school portals like Canvas, etc.
- **File:** Calendar tab → Tasks → *Import a calendar*, or drop a file onto the app on a computer.
- **Link:** paste a calendar's iCal/webcal link (e.g. Google's "Secret address in iCal format"). Pace refreshes links when you open it.
- **Assignments:** when importing a school feed, choose *Assignments to work on*. Each item becomes a task and Pace schedules the work before it's due.

Some calendar servers block browsers from loading links directly. If that happens, import the file instead, or deploy the one-file proxy in [`tools/cors-proxy-worker.js`](tools/cors-proxy-worker.js) (free on Cloudflare Workers) and paste its address in Settings → Account and sync.

## Security

- Everything is encrypted **in your browser** before it's stored or synced: AES-256-GCM, with a random data key that's wrapped by a key derived from your password (PBKDF2-SHA256, 600,000 iterations). Data is gzip-compressed before encryption.
- The repository only ever contains `pace/users/<hash>/account.json` (salt + wrapped key, no data) and `vault.enc` (ciphertext). Usernames are stored as one-way hashes. Commit messages say only "Sync".
- Your GitHub token and OpenRouter key are stored encrypted with the same key.
- Pace refuses to store data in a public repository.
- Each user has their own key. Several people can share one data repo (each with their own username and password), or each person can use their own repo.
- The app itself is static files on GitHub Pages with a strict Content Security Policy. There is no server.

Things to know: if you forget your password, the data can't be recovered. Anyone with your unlocked phone can see your plan while you're signed in. Turn off *Keep me signed in* on shared devices.

## Development

No build step. Serve the folder and open it:

```bash
python3 -m http.server 8765
```

Files: `js/` (app logic: `scheduler.js` planner, `crypto.js` encryption, `store.js` sync and merge, `agent.js` assistant, `import.js` ICS/CSV parsing), `js/ui/` (views), `css/app.css`, `vendor/ical.js` ([ical.js](https://github.com/kewisch/ical.js), MPL-2.0).
