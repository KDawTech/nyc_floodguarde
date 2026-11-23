# NYC FloodGuard 2.0 — AI Assistant Backend Deployment Guide (Render + GitHub Pages)

GitHub Pages (`https://kdawtech.github.io/nyc_floodguarde/`) hosts the static frontend only and cannot run Node.js routes or store secret API keys. To enable the **AI FloodGuard Assistant** on GitHub Pages without exposing `GEMINI_API_KEY`, deploy the existing Express backend (`server.ts`) to **Render** and point the frontend build to your Render URL via `VITE_ASSISTANT_API_URL`.

---

## Step 1: Deploy the Backend to Render

This repository includes a ready-to-use `render.yaml` Blueprint.

### Option A — Deploy with Blueprint (Recommended)
1. Push your latest code (including `render.yaml` and `server.ts`) to GitHub.
2. Sign in to [Render](https://render.com) → click **New +** → **Blueprint**.
3. Connect your GitHub repository (`nyc_floodguarde`).
4. Render will detect `render.yaml` (`nyc-floodguard-api`) automatically:
   - **Build Command:** `npm install`
   - **Start Command:** `npm run start:api`
   - **Health Check Path:** `/api/health`
   - **Environment Variables:**
     - `NODE_ENV=production`
     - `ALLOWED_ORIGINS=https://kdawtech.github.io`
     - `RATE_LIMIT_WINDOW_MS=60000`
     - `RATE_LIMIT_MAX_REQUESTS=15`
5. When prompted for `GEMINI_API_KEY`, paste your Google Gemini API key (stored securely on Render's servers; never committed to Git).
6. Click **Apply** and wait for the service status to turn **Live**.

### Option B — Manual Web Service Setup on Render
1. Render → **New +** → **Web Service** → select your repository.
2. Configure:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm run start:api`
   - **Health Check Path:** `/api/health`
3. Add Environment Variables:
   - `NODE_ENV` = `production`
   - `GEMINI_API_KEY` = `<your Gemini API key>`
   - `ALLOWED_ORIGINS` = `https://kdawtech.github.io`
   - `RATE_LIMIT_WINDOW_MS` = `60000`
   - `RATE_LIMIT_MAX_REQUESTS` = `15`

### Verify the Render Backend
Once deployed, open your Render URL (for example `https://nyc-floodguard-api.onrender.com`):
- `GET https://<your-render-url>/api/health` → should return `{"status":"ok","assistantConfigured":true,...}`
- `GET https://<your-render-url>/api/assistant/status` → should return `{"available":true,...}`

---

## Step 2: Connect GitHub Pages to Your Render Backend

1. Open your GitHub repository → **Settings** → **Secrets and variables** → **Actions** → **Variables** tab.
2. Click **New repository variable**:
   - **Name:** `VITE_ASSISTANT_API_URL`
   - **Value:** `https://<your-render-service>.onrender.com` *(no trailing slash)*
3. Verify your existing Supabase variables are still present under **Variables**:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_PUBLISHABLE_KEY`
4. Trigger a fresh deployment: go to **Actions** → **Deploy NYC FloodGuard** → **Run workflow** (or push a commit to `main`).

The workflow (`.github/workflows/deploy.yml`) passes `VITE_ASSISTANT_API_URL` into Vite at build time. Because `GEMINI_API_KEY` stays strictly on Render, it is never bundled into GitHub Pages.

---

## Security & Operational Notes

- **CORS Policy:** By default, `server.ts` permits `https://kdawtech.github.io` and local development origins (`http://localhost:3000`, `http://localhost:5173`). Add any custom domain to `ALLOWED_ORIGINS` (comma-separated, scheme + host only, e.g. `https://kdawtech.github.io,https://your-domain.com`). Requests from unlisted origins receive `HTTP 403`.
- **Rate Limiting:** `POST /api/assistant` enforces a per-IP rate limit (default: 15 requests per 60 seconds, honoring Render's reverse-proxy `X-Forwarded-For` header) and returns `HTTP 429` with `Retry-After` if exceeded.
- **Render Free-Tier Cold Starts:** Render's free web services sleep after 15 minutes of inactivity and take ~20–35 seconds to wake on the first request. The frontend uses extended timeouts and clear status feedback during wake-up.
- **Local Full-Stack Development:** Leave `VITE_ASSISTANT_API_URL` empty in your local `.env` to use the local same-origin `/api/assistant` server automatically.
