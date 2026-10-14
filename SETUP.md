# LOCKDOWN setup

LOCKDOWN runs entirely in the browser. Without any setup it already works offline: practice
against bots, local guest progress, and private rooms between browser tabs on one device.
Online play (accounts, friends, parties, matchmaking, rooms across the internet) needs a
free Firebase project. Hosting is GitHub Pages. You will need about 15 minutes.

Nothing here costs money: everything fits Firebase's free **Spark** plan and GitHub's free
Pages hosting.

---

## 1. Create the Firebase project

1. Open <https://console.firebase.google.com> and sign in with a Google account.
2. Click **Create a project** (or **Add project**).
3. Enter a name, e.g. `lockdown-game`, and click **Continue**.
4. Google Analytics: switch it **off** (not needed), then click **Create project**. Wait for
   it to finish, then click **Continue**.

## 2. Register the web app (gets you the config values)

1. On the project overview page, click the **web icon `</>`** ("Add an app to get started").
2. App nickname: `lockdown-web`. Leave "Also set up Firebase Hosting" **unchecked**.
3. Click **Register app**. The page shows a `firebaseConfig` object like:

   ```js
   const firebaseConfig = {
     apiKey: "AIza...",
     authDomain: "lockdown-game.firebaseapp.com",
     projectId: "lockdown-game",
     storageBucket: "...",
     messagingSenderId: "...",
     appId: "1:1234:web:abcd"
   };
   ```

   Keep this tab open: you need `apiKey`, `authDomain`, `projectId` and `appId`.
   (`databaseURL` is added in step 5.) Click **Continue to console**.

## 3. Turn on sign-in methods

1. Left menu: **Build → Authentication**, then **Get started**.
2. Tab **Sign-in method**. Enable each of these and click **Save**:
   - **Anonymous** (guests: everyone starts as a guest with cloud saves)
   - **Google** (pick a support email when asked)
   - **Email/Password** (only the first toggle; leave "Email link" off)
3. Tab **Settings → Authorized domains → Add domain**: add `YOUR-GITHUB-USERNAME.github.io`
   (for this repository: `jacobkalka.github.io`). `localhost` is already listed.

## 4. Create the Firestore database

1. Left menu: **Build → Firestore Database → Create database**.
2. Edition: **Standard**. Location: pick the one closest to your players (cannot be changed later).
3. Start in **production mode**, then click **Create**.
4. Open the **Rules** tab, replace everything with the contents of
   [`firebase/firestore.rules`](firebase/firestore.rules) from this repository, click **Publish**.

## 5. Create the Realtime Database

1. Left menu: **Build → Realtime Database → Create Database**.
2. Location: closest to your players. Security rules: **Start in locked mode**. Click **Enable**.
3. Copy the database URL shown at the top of the **Data** tab, e.g.
   `https://lockdown-game-default-rtdb.europe-west1.firebasedatabase.app`.
   This is your `databaseURL`.
4. Open the **Rules** tab, replace everything with the contents of
   [`firebase/database.rules.json`](firebase/database.rules.json), click **Publish**.

> Alternative to pasting rules: `npx firebase-tools login`, copy `.firebaserc.example` to
> `.firebaserc` with your project id, then `npx firebase-tools deploy --only firestore:rules,database`.

## 6. Add the config to GitHub (repository secrets)

The build reads the config from environment variables; nothing is committed.

1. On GitHub open the repository → **Settings → Secrets and variables → Actions**.
2. Click **New repository secret** for each of these (name → value from steps 2 and 5):

   | Secret name | Value |
   | --- | --- |
   | `VITE_FIREBASE_API_KEY` | `apiKey` |
   | `VITE_FIREBASE_AUTH_DOMAIN` | `authDomain` |
   | `VITE_FIREBASE_PROJECT_ID` | `projectId` |
   | `VITE_FIREBASE_DATABASE_URL` | the Realtime Database URL |
   | `VITE_FIREBASE_APP_ID` | `appId` |

   Firebase web config values are not passwords (they end up in the public JavaScript of any
   Firebase site, and access is enforced by the security rules), but keeping them out of git
   makes forks and staging projects easy.

## 7. Turn on GitHub Pages

1. Repository → **Settings → Pages**.
2. **Build and deployment → Source: GitHub Actions**.
3. The workflow `.github/workflows/deploy.yml` builds and deploys on every push to `main`
   (and can be run by hand: **Actions → Deploy to GitHub Pages → Run workflow**).
4. The site appears at `https://YOUR-GITHUB-USERNAME.github.io/REPOSITORY/`
   (for this repository: <https://jacobkalka.github.io/Gulag/>).

## 8. (Optional) TURN relay for strict networks

Players connect peer-to-peer with WebRTC. Public STUN servers handle most home networks, but
two players behind strict NATs (some corporate/university/mobile networks) need a TURN relay.
Without one they see "Connection timed out (a TURN relay may be required on this network)".

Free option, Metered (<https://www.metered.ca/stun-turn>), free tier with monthly relay quota:

1. Sign up, open **Dashboard → TURN Server → Create App** (name it `lockdown`).
2. Either:
   - copy the **API key** credential URL, like
     `https://lockdown.metered.live/api/v1/turn/credentials?apiKey=XXXX`, and add the GitHub
     secret `VITE_TURN_CREDENTIALS_URL` with it; in Metered, restrict the key to your
     `github.io` domain if offered; **or**
   - create a static credential and add three secrets: `VITE_TURN_URLS` (comma-separated, e.g.
     `turn:global.relay.metered.ca:80,turns:global.relay.metered.ca:443?transport=tcp`),
     `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL`.
3. Re-run the deploy workflow.

Any provider that returns standard `RTCIceServer` JSON works the same way (Twilio, Xirsys,
Cloudflare Calls TURN behind your own credential endpoint). Note that a static site cannot hide
TURN credentials from players; prefer short-lived credentials or domain-restricted keys.

---

## Local development

```bash
npm ci
npm run dev              # http://localhost:5173 (offline mode unless .env.local has a config)
```

Put a Firebase config in `.env.local` (gitignored) to use your project locally; see
[`.env.example`](.env.example). Remember `localhost` must stay an authorized domain.

### Firebase Emulator Suite (no real project needed)

Requires Java 11+.

```bash
npm run emulators                      # auth :9099, firestore :8080, database :9000
# load the RTDB rules into the emulator (the CLI's own upload may be skipped by test configs):
curl -X PUT -H "Authorization: Bearer owner" --data-binary @firebase/database.rules.json \
  "http://127.0.0.1:9000/.settings/rules.json?ns=demo-lockdown"
```

Then open <http://localhost:5173/?emulators=1>. Every browser profile/incognito window is a
separate guest account, so you can test friends, parties and matchmaking alone.

### Tests

```bash
npm test                 # unit + simulation + netcode tests (Vitest)
npm run test:rules       # Firestore/RTDB security rules against the emulators
npm run e2e              # Playwright: two-tab WebRTC match (builds + previews the site)
E2E_EMULATORS=1 npx playwright test e2e/online.spec.ts   # online flow (emulators running)
```

Useful URL flags: `?quality=low|medium|high|ultra`, `?offline=1` (ignore Firebase config),
`?net=local` (rooms over BroadcastChannel even when online), `?emulators=1`.
