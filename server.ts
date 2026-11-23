import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const MODEL_NAME = 'gemini-4-hydrogen';

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build'
      }
    }
  });
}

function buildSystemInstruction(): string {
  return [
    'You are the NYC FloodGuard 2.0 Informational Assistant.',
    'Explain urban flood monitoring, storm-drain blockages, rainfall impacts on NYC drainage systems, and pedestrian flood safety in clear, plain language.',
    'Always stay honest and grounded in the telemetry and weather snapshot provided in the user prompt:',
    '- Distinguish clearly between OBSERVED prototype sensor readings (tabletop 3D-printed NYC street model with Arduino GIGA R1 WiFi + HC-SR04) and LIVE NYC weather forecasts (Open-Meteo).',
    '- If the dashboard is in DEMO MODE, mention that readings are simulated rather than live hardware.',
    '- If no sensor is connected or weather is unavailable, say so honestly instead of inventing numbers.',
    '- Never claim NYC FloodGuard is an official NYC emergency dispatch or validated citywide forecasting service.',
    '- Keep answers concise (3–6 short sentences or brief bullet points) and easy to understand during a classroom demonstration or public walkthrough.'
  ].join('\n');
}

function formatContextBlock(context: Record<string, unknown> | undefined): string {
  if (!context || typeof context !== 'object') {
    return 'Dashboard context: Not provided.';
  }

  const lines: string[] = ['Current NYC FloodGuard Dashboard Snapshot:'];
  if (context.sourceMode) lines.push(`- Data Source Mode: ${String(context.sourceMode)}`);
  if (context.status) lines.push(`- Flood Status: ${String(context.status)}`);
  if (context.depthCm !== null && context.depthCm !== undefined) {
    lines.push(`- Filtered Water Depth: ${Number(context.depthCm).toFixed(2)} cm`);
  }
  if (context.distanceCm !== null && context.distanceCm !== undefined) {
    lines.push(`- Sensor Distance: ${Number(context.distanceCm).toFixed(2)} cm`);
  }
  if (context.trend) lines.push(`- Water Trend: ${String(context.trend)}`);
  if (context.rateCmPerMin !== null && context.rateCmPerMin !== undefined) {
    lines.push(`- Rate of Change: ${Number(context.rateCmPerMin).toFixed(2)} cm/min`);
  }
  if (context.sensorQuality) lines.push(`- Sensor Quality: ${String(context.sensorQuality)}`);
  if (context.riskLevel) lines.push(`- Rule-Based Risk Level: ${String(context.riskLevel)}`);
  if (typeof context.blockedDrainSuspected === 'boolean') {
    lines.push(`- Blocked Drain Flag: ${context.blockedDrainSuspected ? 'Suspected' : 'Not flagged'}`);
  }
  if (context.weatherSummary) {
    lines.push(`- Live NYC Weather Forecast (Open-Meteo): ${String(context.weatherSummary)}`);
  }
  return lines.join('\n');
}

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/assistant/status', (_req, res) => {
    const configured = Boolean((process.env.GEMINI_API_KEY || '').trim());
    res.json({
      available: configured,
      model: MODEL_NAME,
      note: configured
        ? 'Server-side Gemini AI Assistant is ready (informational explanations only).'
        : 'Server-side GEMINI_API_KEY is not configured in the server environment.'
    });
  });

  app.post('/api/assistant', async (req, res) => {
    try {
      const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
      const context =
        req.body?.context && typeof req.body.context === 'object'
          ? (req.body.context as Record<string, unknown>)
          : undefined;

      if (!question) {
        return res.status(400).json({ error: 'Please enter a question for the FloodGuard Assistant.' });
      }
      if (question.length > 600) {
        return res.status(400).json({ error: 'Question is too long (maximum 600 characters).' });
      }

      const ai = getGeminiClient();
      if (!ai) {
        return res.status(503).json({
          error:
            'AI Assistant is currently unavailable because GEMINI_API_KEY is not configured on the server. Rule-based FloodGuard Risk Intelligence remains fully active.'
        });
      }

      const prompt = `${formatContextBlock(context)}\n\nUser Question: ${question}`;

      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: prompt,
        config: {
          systemInstruction: buildSystemInstruction(),
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
        }
      });

      const answer = (response.text || '').trim();
      if (!answer) {
        return res.status(502).json({
          error: 'The AI service returned an empty response. Please try asking again.'
        });
      }

      return res.json({
        answer,
        model: MODEL_NAME,
        informationalOnly: true,
        generatedAt: new Date().toISOString()
      });
    } catch (err: unknown) {
      const rawMessage = err instanceof Error ? err.message : 'Unexpected server error calling Gemini API.';
      const status =
        typeof err === 'object' && err !== null && 'status' in err && Number.isFinite(Number((err as { status?: number }).status))
          ? Number((err as { status?: number }).status)
          : 500;

      if (status === 403 || status === 400 || /API_KEY_INVALID|PERMISSION_DENIED/i.test(rawMessage)) {
        return res.status(status === 403 ? 403 : 400).json({
          error: 'Gemini API key was rejected. Check GEMINI_API_KEY in the server environment.'
        });
      }
      if (status === 429 || /RESOURCE_EXHAUSTED/i.test(rawMessage)) {
        return res.status(429).json({
          error: 'Gemini API rate limit reached. Please wait a moment and try again.'
        });
      }
      if (status === 503 || /UNAVAILABLE|high demand|overloaded/i.test(rawMessage)) {
        return res.status(503).json({
          error:
            'The AI service is temporarily experiencing high demand. Please try again in a few seconds — rule-based FloodGuard Risk Intelligence remains active.'
        });
      }
      let friendlyMsg = rawMessage;
      try {
        const parsed = JSON.parse(rawMessage);
        if (parsed?.error?.message) {
          friendlyMsg = String(parsed.error.message);
        }
      } catch {
        // Keep rawMessage if not JSON
      }
      return res.status(502).json({
        error: `AI Assistant request failed: ${friendlyMsg}`
      });
    }
  });

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const hmrDisabled = process.env.DISABLE_HMR === 'true';

    // When DISABLE_HMR=true (preview proxy environments), Vite 6 middlewareMode still
    // injects /@vite/client and defaults its WebSocket target to port 24678, causing
    // "[vite] failed to connect to websocket" / "WebSocket closed without opened" errors.
    // Serve a lightweight no-WebSocket shim for /@vite/client and strip the injected tag
    // while keeping full CSS/ESM serving intact. In normal local dev (DISABLE_HMR !== 'true'),
    // attach Vite's HMR WebSocket directly to the shared Express HTTP server on PORT.
    if (hmrDisabled) {
      const noWsViteClientShim = [
        'const sheetsMap = new Map();',
        'export function updateStyle(id, content) {',
        '  let style = sheetsMap.get(id);',
        '  if (!style) {',
        '    style = document.createElement("style");',
        '    style.setAttribute("type", "text/css");',
        '    style.setAttribute("data-vite-dev-id", id);',
        '    document.head.appendChild(style);',
        '    sheetsMap.set(id, style);',
        '  }',
        '  style.textContent = content;',
        '}',
        'export function removeStyle(id) {',
        '  const style = sheetsMap.get(id);',
        '  if (style) {',
        '    style.remove();',
        '    sheetsMap.delete(id);',
        '  }',
        '}',
        'export function createHotContext() {',
        '  return {',
        '    data: {},',
        '    accept() {},',
        '    acceptExports() {},',
        '    dispose() {},',
        '    prune() {},',
        '    invalidate() {},',
        '    on() {},',
        '    off() {},',
        '    send() {}',
        '  };',
        '}',
        'export function injectQuery(url) { return url; }',
        'export class ErrorOverlay {}'
      ].join('\n');

      app.get('/@vite/client', (_req, res) => {
        res.type('application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(noWsViteClientShim);
      });
    }

    const vite = await createViteServer({
      plugins: hmrDisabled
        ? [
            {
              name: 'nyc-floodguard-strip-hmr-client',
              transformIndexHtml: {
                order: 'post',
                handler(html: string) {
                  return html.replace(
                    /\s*<script\s+type="module"\s+src="[^"]*\/@vite\/client"[^>]*><\/script>\s*/gi,
                    '\n'
                  );
                }
              }
            }
          ]
        : [],
      server: {
        middlewareMode: true,
        ws: !hmrDisabled,
        hmr: hmrDisabled ? false : { server: httpServer }
      },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`NYC FloodGuard 2.0 server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start NYC FloodGuard 2.0 server:', err);
  process.exit(1);
});
