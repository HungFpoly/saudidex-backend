import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
// NOTE: crawlee (PlaywrightCrawler / CheerioCrawler) is intentionally NOT imported
// at the top level. Crawlee attempts to initialise local file-system storage on
// module load, which crashes Vercel's read-only serverless runtime before the
// health-check route can even respond.  These are dynamically imported inside
// advancedScrape() so every other route (health, enrichment, AI jobs) remains
// available even on environments that don't support browser crawling.
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { Groq } from "groq-sdk";
import { Mistral } from "@mistralai/mistralai";
import { HfInference } from "@huggingface/inference";
import { getProvider, AIProvider } from "./shared/config/aiProviders";
import { classifyPage, prioritizePages, getEnrichmentPageOrder } from "./shared/lib/pageClassifier";
import { parserRegistry } from "./shared/lib/adapters"; // Imports ALL adapters via barrel (auto-registers them)
import { canonicalizeUrl } from "./shared/lib/urlCanonicalizer";
import { canFetch as canFetchRobots, getCrawlDelay as getRobotsCrawlDelay } from "./shared/lib/robotsPolicy";
import { waitForSlot, releaseSlot, extractDomainFromUrl } from "./shared/lib/rateLimiter";
import { validator } from "./shared/lib/validator";
import { queueManager, QueueType, JobStatus } from "./shared/lib/queueManager";
import { processClaimedJob } from "./shared/lib/queueRuntime";
import {
  extractCompanyName,
  extractEmails,
  extractPhones,
  extractSocialLinks,
  extractAddress,
  extractDescription,
  extractLogoUrl,
  extractWebsiteUrl,
} from "./shared/lib/extractors";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const BUILD_ID = process.env.BUILD_ID || `dev-${Date.now()}`;
const corsOrigin = (process.env.CORS_ORIGIN || "").trim();
app.use(
  cors({
    origin: corsOrigin
      ? corsOrigin.split(",").map((o) => o.trim()).filter(Boolean)
      : true, // allow all in dev / unspecified
    credentials: true,
  })
);
app.use(express.json());

type AppRole = 'admin' | 'moderator' | 'user';

const hasRole = (role: AppRole, minimum: AppRole) => {
  const order: Record<AppRole, number> = { user: 0, moderator: 1, admin: 2 };
  return (order[role] ?? 0) >= (order[minimum] ?? 0);
};

const requireRole = (minimum: AppRole = 'user') => {
  return async (req: any, res: any, next: any) => {
    try {
      const header = (req.headers?.authorization || '').toString();
      const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
      if (!token) {
        return res.status(401).json({ error: 'Missing Authorization bearer token.' });
      }

      const { supabaseAdmin } = await import('./shared/lib/supabase');
      if (!supabaseAdmin) {
        return res.status(500).json({ error: 'Supabase admin client is not configured.' });
      }

      const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
      if (userErr || !userData?.user) {
        return res.status(401).json({ error: 'Invalid or expired token.' });
      }

      const user = userData.user;
      const { data: roleRow, error: roleErr } = await supabaseAdmin
        .from('users')
        .select('role')
        .eq('id', user.id)
        .maybeSingle();

      if (roleErr) {
        return res.status(500).json({ error: 'Failed to load user role.' });
      }

      const role = ((roleRow?.role as AppRole) || 'user') as AppRole;
      if (!hasRole(role, minimum)) {
        return res.status(403).json({ error: 'Insufficient permissions.' });
      }

      req.user = user;
      req.userRole = role;
      next();
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || 'Auth failure.' });
    }
  };
};

const requireModerator = requireRole('moderator');
const requireAdmin = requireRole('admin');

const turndownService = new TurndownService();

// Map each backend provider to its required environment variable name.
const ENV_KEY_MAP: Record<string, string> = {
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  huggingface: 'HUGGINGFACE_API_KEY',
  openai: 'OPENAI_API_KEY',
};

const parseQueueType = (value: string): QueueType | null => {
  const valid = Object.values(QueueType) as string[];
  return valid.includes(value) ? (value as QueueType) : null;
};

const parseJobStatus = (value: string): JobStatus | null => {
  const valid = Object.values(JobStatus) as string[];
  return valid.includes(value) ? (value as JobStatus) : null;
};

// ─── Robust JSON Parsing Helper ──────────────────────────────────
// AI models often wrap JSON in markdown blocks or add preamble.
// This extracts the first valid JSON object or array found in text.

function safeJsonParse<T = any>(str: string, fallback: T): T {
  if (!str) return fallback;
  
  try {
    // Fast path for clean JSON
    return JSON.parse(str);
  } catch (e) {
    // Look for JSON blocks ```json ... ``` or just { ... } / [ ... ]
    const jsonMatch = str.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        // Remove markdown artifacts if present
        let cleaned = jsonMatch[0];
        return JSON.parse(cleaned);
      } catch (innerError) {
        console.warn("[JSON Parse] Failed to parse matched JSON block:", innerError);
      }
    }
    console.warn("[JSON Parse] Could not find valid JSON in response:", str.slice(0, 100));
    return fallback;
  }
}

// ─── Evidence Storage Helper ─────────────────────────────────────
// Stores extracted field evidence in the DB for provenance tracking.
// Called after deterministic extraction — before any AI enrichment.

async function storeFieldEvidence(
  companyId: string | undefined,
  evidences: Array<{
    field_name: string;
    value: unknown;
    source_url: string;
    extraction_method: string;
    extraction_detail?: string;
    confidence: number;
  }>
): Promise<void> {
  try {
    const { supabaseAdmin } = await import("./shared/lib/supabase");
    if (!supabaseAdmin) return;

    const rows = evidences
      .filter(e => e.value != null && e.value !== '' && e.confidence > 0)
      .map(e => ({
        company_id: companyId ?? null,
        field_name: e.field_name,
        value: typeof e.value === 'object' ? JSON.stringify(e.value) : String(e.value),
        source_url: e.source_url,
        extraction_method: e.extraction_method,
        extraction_detail: e.extraction_detail,
        confidence: e.confidence,
      }));

    if (rows.length === 0) return;

    const { error } = await supabaseAdmin.from('field_evidence').insert(rows);
    if (error) {
      console.warn('[Evidence] Failed to store field evidence (non-critical):', error.message);
    }
  } catch (err) {
    console.warn('[Evidence] Failed to store field evidence (non-critical):', (err as Error).message);
  }
}

// ─── Robots + Rate Limit Aware Fetch Wrapper ─────────────────────
// Wraps smartFetch with robots.txt checking and rate limiting.

async function safeFetch(url: string, timeout = 45000): Promise<{ html: string | null; markdown: string; url: string; blocked: boolean }> {
  // Only http(s) URLs are fetchable. Skip mailto:, tel:, javascript:, etc.
  if (!/^https?:\/\//i.test(url || '')) {
    return { html: null, markdown: '', url, blocked: true };
  }
  // Check robots.txt
  const allowed = await canFetchRobots(url);
  if (!allowed) {
    console.log(`[Robots] Blocked by robots.txt: ${url}`);
    return { html: null, markdown: '', url, blocked: true };
  }

  // Wait for rate limit slot
  const domain = extractDomainFromUrl(url) || url;
  await waitForSlot(domain);

  try {
    // Respect crawl-delay from robots.txt
    const delay = await getRobotsCrawlDelay(url);
    if (delay > 0) {
      await new Promise(r => setTimeout(r, delay * 1000));
    }

    const result = await smartFetch(url, timeout);
    return { ...result, blocked: false };
  } finally {
    releaseSlot(domain);
  }
}

// Smart fetch: automatically detects JS-heavy sites and uses browser rendering
async function smartFetch(url: string, timeout = 45000): Promise<{ html: string | null; markdown: string; url: string }> {
  const lower = url.toLowerCase();
  const isJSHeavy =
    lower.includes('.aspx') ||
    lower.includes('mcci.org.sa') ||
    lower.includes('saudiindustryguide.com') ||
    lower.includes('angular') ||
    lower.includes('react') ||
    lower.includes('vue.js') ||
    lower.includes('__dopostback') ||
    lower.includes('/home/factories');

  const scrapingBeeKey = process.env.SCRAPINGBEE_API_KEY;
  const browserlessToken = process.env.BROWSERLESS_TOKEN;

  // High-intensity targets: Government portals and high-security directories
  const isHighIntensity = 
    lower.includes('gov.sa') || 
    lower.includes('mcci.org.sa') || 
    lower.includes('fsc.org.sa') ||
    lower.includes('modon') ||
    lower.includes('eamana');

  const finalTimeout = isHighIntensity ? Math.max(timeout, 90000) : timeout;

  // If ScrapingBee is configured, use it as the primary path
  if (scrapingBeeKey) {
    try {
      console.log(`[Scraper] ${isHighIntensity ? '🔥 High-Intensity' : '📡 Standard'} ScrapingBee for ${url}`);
      
      const params = new URLSearchParams({
        api_key: scrapingBeeKey,
        url: url,
        render_js: 'true',
        wait_browser: 'networkidle2',
        premium_proxy: isHighIntensity ? 'true' : 'false',
        country_code: 'sa' // Prioritize Saudi proxies for gov.sa sites
      });

      const response = await fetch(`https://app.scrapingbee.com/api/v1?${params.toString()}`, { 
        signal: AbortSignal.timeout(finalTimeout) 
      });

      if (!response.ok) throw new Error(`ScrapingBee error: ${response.statusText}`);
      const html = await response.text();
      const $ = cheerio.load(html);
      $("script, style, nav, footer, header, iframe, noscript, svg, path").remove();
      const body = $("body").html() || "";
      const htmlLimit = url.toLowerCase().includes('saudiindustryguide.com') ? 600000 : 200000;
      const mdLimit = url.toLowerCase().includes('saudiindustryguide.com') ? 90000 : 40000;
      return {
        html: html.slice(0, htmlLimit),
        markdown: turndownService.turndown(body).slice(0, mdLimit),
        url
      };
    } catch (e: any) {
      console.error(`ScrapingBee failed: ${e.message}`);
    }
  }

  if (isJSHeavy) {
    // Prevent Playwright from crashing Vercel's read-only serverless environment
    // UNLESS we are using Browserless.io (remote browser)
    if (process.env.VERCEL === '1' && !browserlessToken) {
      console.warn(`[Scraper] Local browser scraping requested on Vercel. Falling back to HTTP fetch. Add SCRAPINGBEE_API_KEY for high-intensity gov.sa targets.`);
      return fetchUrlContent(url, finalTimeout);
    }
    
    try {
      return await fetchWithBrowser(url, finalTimeout);
    } catch (browserError) {
      console.warn(`Browser fetch failed for ${url}, falling back to HTTP:`, (browserError as Error).message);
      return fetchUrlContent(url, finalTimeout);
    }
  }

  // Default path: try HTTP fetch first; if the response is a WAF block page,
  // retry with browser rendering to bypass Mod_Security/anti-bot protections.
  const httpResult = await fetchUrlContent(url, finalTimeout);
  const html = httpResult.html || '';
  const looksBlocked =
    /mod_security/i.test(html) ||
    /not acceptable/i.test(html) ||
    /access denied/i.test(html);
  if (looksBlocked) {
    console.warn(`[Scraper] WAF block detected for ${url}; retrying with browser rendering.`);
    try {
      return await fetchWithBrowser(url, finalTimeout);
    } catch (e: any) {
      console.warn(`[Scraper] Browser retry failed for ${url}; using blocked HTTP content:`, e?.message || e);
      return httpResult;
    }
  }
  return httpResult;
}

// Fetch with browser rendering (Playwright) for JS-heavy sites
async function fetchWithBrowser(url: string, timeout = 45000): Promise<{ html: string | null; markdown: string; url: string }> {
  try {
    const browserlessToken = process.env.BROWSERLESS_TOKEN;
    const playwright = (await import('playwright')) as any;
    const chromium = playwright.chromium;
    
    let browser;
    if (browserlessToken) {
      console.log(`[Scraper] Connecting to Browserless.io (CDP)...`);
      browser = await chromium.connectOverCDP(`wss://chrome.browserless.io?token=${browserlessToken}`);
    } else {
      browser = await chromium.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      });
    }

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

    try {
      await page.waitForLoadState('networkidle', { timeout: 15000 });
    } catch { }

    await page.waitForTimeout(2000);

    const html = await page.content();
    const $ = cheerio.load(html);
    $("script, style, nav, footer, header, iframe, noscript, svg, path").remove();
    const body = $("body").html() || "";
    const markdown = turndownService.turndown(body);

    await browser.close();

    const htmlLimit = url.toLowerCase().includes('saudiindustryguide.com') ? 600000 : 200000;
    const mdLimit = url.toLowerCase().includes('saudiindustryguide.com') ? 90000 : 40000;
    return {
      html: html.slice(0, htmlLimit),
      markdown: markdown.slice(0, mdLimit),
      url
    };
  } catch (error: any) {
    console.error(`Browser fetch failed for ${url}:`, error.message);
    return fetchUrlContent(url, timeout);
  }
}

// Helper to fetch and clean URL content with better timeout and error handling
// Returns both raw HTML and cleaned markdown
async function fetchUrlContent(url: string, timeout = 30000): Promise<{ html: string | null; markdown: string; url: string }> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Use browser-like headers to reduce Cloudflare/WAF blocks.
        // (Some directories block obvious bot user agents.)
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      }
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();

    const $ = cheerio.load(html);
    $("script, style, nav, footer, header, iframe, noscript, svg, path").remove();
    const body = $("body").html() || "";

    const markdown = turndownService.turndown(body);

    return {
      // Some Nuxt/SPA directories embed large JSON state in HTML (e.g. industry.com.sa).
      // Keep a higher cap so deterministic adapters can read the embedded data.
      html: html.slice(0, url.toLowerCase().includes('industry.com.sa') ? 600000 : 100000),
      markdown: markdown.slice(0, url.toLowerCase().includes('industry.com.sa') ? 90000 : 30000),
      url: response.url // Use the final URL after redirects
    };
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new Error(`Timeout (${timeout}ms) exceeded while fetching ${url}`);
    }
    throw error;
  }
}

// ─── AI Provider Call Helper ─────────────────────────────────────
// Centralized function to call different AI providers using their SDKs

async function callProvider(provider: AIProvider, prompt: string, instructions: string, model?: string) {
  const baseConfig = getProvider(provider as AIProvider);
  if (!baseConfig) {
    throw new Error(`Unsupported AI provider: ${provider}`);
  }

  // Prepare a full config with API key from environment
  const envKey = ENV_KEY_MAP[provider as string];
  const apiKey = process.env[envKey] || (provider === 'gemini' ? process.env.VITE_GEMINI_API_KEY : undefined);
  
  const config = {
    ...baseConfig,
    apiKey,
    defaultModel: baseConfig.discoveryModel // Use discoveryModel as the default fallback
  };

  if (provider !== 'webllm' && !config.apiKey) {
    throw new Error(`API key for ${provider} (${envKey}) is not configured on the server.`);
  }

  const startTime = Date.now();
  let result: any = null;
  let usage: any = null;
  let modelUsed: string | null = null;

  try {
    if (provider === 'groq') {
      const groq = new Groq({ apiKey: config.apiKey });
      const completion = await groq.chat.completions.create({
        messages: [
          { role: "system", content: instructions },
          { role: "user", content: prompt }
        ],
        model: model || config.defaultModel,
      });

      result = completion.choices[0]?.message;
      usage = completion.usage;
      modelUsed = completion.model;
    } else if (provider === 'mistral') {
      const mistral = new Mistral({ apiKey: config.apiKey });
      const chatResponse = await mistral.chat.complete({
        model: model || config.defaultModel,
        messages: [
          { role: "system", content: instructions },
          { role: "user", content: prompt }
        ]
      });

      result = chatResponse.choices[0]?.message;
      usage = { prompt_tokens: chatResponse.usage?.prompt_tokens, completion_tokens: chatResponse.usage?.completion_tokens, total_tokens: chatResponse.usage?.total_tokens };
      modelUsed = chatResponse.model;
    } else if (provider === 'huggingface') {
      // Hugging Face Inference API call
      const hf = new HfInference(config.apiKey);
      const inferenceResult = await hf.textGeneration({
        model: model || config.defaultModel,
        inputs: `System: ${instructions}\n\nUser: ${prompt}\n\nAssistant:`,
        parameters: {
          return_full_text: false,
          max_new_tokens: 2048,
        },
      });

      result = { content: inferenceResult.generated_text };
      // HF usage is not standard, estimating roughly (4 chars per token)
      usage = { 
        prompt_tokens: Math.round(prompt.length / 4), 
        completion_tokens: Math.round(inferenceResult.generated_text.length / 4),
        total_tokens: Math.round((prompt.length + inferenceResult.generated_text.length) / 4)
      };
    } else if (provider === 'openrouter') {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.apiKey}`,
          "HTTP-Referer": "https://saudidex.ae",
          "X-Title": "Saudidex Admin",
        },
        body: JSON.stringify({
          model: model || config.defaultModel,
          messages: [
            { role: "system", content: instructions },
            { role: "user", content: prompt }
          ]
        }),
      });
      const responseData = await response.json();
      if (!response.ok) {
        throw new Error(responseData?.error?.message || `OpenRouter request failed (${response.status})`);
      }
      result = responseData.choices?.[0]?.message;
      usage = responseData.usage;
      modelUsed = responseData.model;
    } else if (provider === 'gemini') {
      const selectedModel = model || config.defaultModel;
      const apiKey = (config.apiKey || "").trim();
      if (!apiKey) {
        throw new Error("GEMINI_API_KEY is not set in environment variables");
      }
      const requestBody = {
        contents: [
          {
            parts: [{ text: `${instructions}\n\n${prompt}` }],
          },
        ],
        // Keep this minimal for compatibility across model versions.
        // Some models reject newer/optional fields; the caller can still request JSON via instructions.
        generationConfig: {},
      };

      const callGemini = async (modelName: string, apiVersion: "v1" | "v1beta") => {
        const geminiResponse = await fetch(
          `https://generativelanguage.googleapis.com/${apiVersion}/models/${modelName}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey,
            },
            body: JSON.stringify(requestBody),
          }
        );
        const geminiData = await geminiResponse.json().catch(() => ({}));
        return { geminiResponse, geminiData };
      };

      const modelCandidates = Array.from(
        new Set([
          selectedModel,
          ...(Array.isArray(baseConfig.models) ? baseConfig.models : []),
        ])
      ).filter(Boolean);

      const isRetryableModelError = (status: number, msg: string) =>
        status === 429 ||
        status === 503 ||
        /high demand|try again later|resource exhausted|quota|rate limit|too many requests|temporarily unavailable/i.test(msg);

      let geminiResponse: globalThis.Response | null = null;
      let geminiData: any = null;
      let lastGeminiError: string | null = null;

      // Keep provider strict (gemini), but allow model fallback within gemini.
      for (let i = 0; i < modelCandidates.length; i++) {
        const candidateModel = modelCandidates[i];

        ({ geminiResponse, geminiData } = await callGemini(candidateModel, "v1"));
        if (!geminiResponse.ok) {
          const msg = geminiData?.error?.message || "";
          const shouldRetryV1beta =
            geminiResponse.status === 404 ||
            /is not found for API version v1|not supported for generateContent/i.test(msg);
          if (shouldRetryV1beta) {
            ({ geminiResponse, geminiData } = await callGemini(candidateModel, "v1beta"));
          }
        }

        if (geminiResponse.ok) {
          modelUsed = candidateModel;
          break;
        }

        const msg = geminiData?.error?.message || `Gemini request failed (${geminiResponse.status})`;
        lastGeminiError = msg;
        const canTryNextModel =
          i < modelCandidates.length - 1 && isRetryableModelError(geminiResponse.status, msg);

        if (canTryNextModel) {
          console.warn(`[Gemini] Model ${candidateModel} unavailable, trying fallback model...`, msg);
          continue;
        }

        throw new Error(msg);
      }

      if (!geminiResponse?.ok) {
        throw new Error(lastGeminiError || "Gemini request failed on all configured models.");
      }
      const content = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
      result = { content };
      modelUsed = modelUsed || selectedModel;
      
      // Map Gemini token usage if available
      if (geminiData.usageMetadata) {
        usage = {
          prompt_tokens: geminiData.usageMetadata.promptTokenCount,
          completion_tokens: geminiData.usageMetadata.candidatesTokenCount,
          total_tokens: geminiData.usageMetadata.totalTokenCount
        };
      } else {
        // Fallback usage estimation
        usage = { 
          prompt_tokens: Math.round(prompt.length / 4), 
          completion_tokens: Math.round(content.length / 4),
          total_tokens: Math.round((prompt.length + content.length) / 4)
        };
      }
    }

    // Log AI usage for observability (only if not in AI_DISABLED mode)
    if (process.env.AI_DISABLED !== 'true') {
      try {
        const { supabaseAdmin } = await import('./shared/lib/supabase');
        if (supabaseAdmin) {
          await supabaseAdmin.from('ai_logs').insert({
            provider,
            model_used: modelUsed || model || config.defaultModel,
            prompt_tokens: usage?.prompt_tokens || 0,
            completion_tokens: usage?.completion_tokens || 0,
            total_tokens: usage?.total_tokens || 0,
            response_time_ms: Date.now() - startTime,
            created_at: new Date().toISOString()
          });
        }
      } catch (logError) {
        console.warn('Failed to log AI usage:', logError);
      }
    }

    return result;
  } catch (error: any) {
    console.error(`AI provider ${provider} error:`, error);
    throw error;
  }
}

// ─── Validation Helper ───────────────────────────────────────────
// Validates extracted companies before they're returned to the client

async function validateAndCleanCompanies(companies: any[]) {
  // Sanitize all companies first
  const sanitizedCompanies = companies.map(company => validator.sanitizeCompany(company));

  // Then validate them
  const { valid, invalid } = validator.validateCompanies(sanitizedCompanies);

  // Log validation issues but don't fail completely
  if (invalid.length > 0) {
    console.warn(`Validation issues found in ${invalid.length} companies:`, 
                 invalid.map(i => ({ errors: i.errors, name: i.company.name_en || i.company.name_ar })));

    // Log invalid companies to review queue if it exists
    try {
      const { supabaseAdmin } = await import('./shared/lib/supabase');
      if (supabaseAdmin && invalid.length > 0) {
        // Add invalid companies to review queue for manual inspection
        const itemsToReview = invalid.map(item => ({
          item_type: 'company_extraction_issue',
          item_data: { company: item.company, errors: item.errors },
          severity: 'high',
          notes: `Validation failed for company: ${item.company.name_en || item.company.name_ar}`,
          created_at: new Date().toISOString()
        }));

        const { error } = await supabaseAdmin.from('review_queue_items').insert(itemsToReview);
        if (error) console.warn('Failed to add to review queue:', error);
      }
    } catch (e) {
      console.warn('Could not add validation issues to review queue:', e);
    }
  }

  return valid;
}

// ─── AI Disabled Checks for All AI Endpoints ─────────────────────
// Add AI_DISABLED checks to all AI-dependent endpoints to ensure they
// return appropriate responses when AI is disabled

// AI Disabled helper function
function isAIDisabled() {
  return process.env.AI_DISABLED === 'true';
}

// Advanced scraper using Crawlee + Playwright (with fallback)
// Returns: { url, content (markdown), html (raw, up to 100KB) }
// Crawlee is dynamically imported here (not at module level) to prevent
// serverless environments (Vercel) from crashing during function initialisation.
async function advancedScrape(url: string, maxPages = 20) {
  const results: { url: string; content: string; html: string | null }[] = [];

  // Fast path for known government domains that block headless browsers
  if (url.includes('mim.gov.sa')) {
    console.log("Using simple fetch for government domain to avoid browser blocks.");
    const fetched = await fetchUrlContent(url, 45000);
    return [{ url: fetched.url, content: fetched.markdown, html: fetched.html }];
  }

  try {
    console.log("Attempting CheerioCrawler crawl...");
    // Dynamic import keeps module load fast on Vercel / serverless runtimes
    const crawlee = (await import('crawlee')) as any;
    const CheerioCrawler = crawlee.CheerioCrawler;
    const cheerioCrawler = new CheerioCrawler({
      maxRequestsPerCrawl: maxPages,
      requestHandler: async (ctx: any) => {
        const { request, $, log, enqueueLinks } = ctx;
        log.info(`Processing ${request.url} (Cheerio)...`);

        // Get raw HTML before cleaning
        const rawHtml = $.html();

        // Clean content
        $("script, style, nav, footer, header, iframe, noscript, svg, path").remove();
        const body = $("body").html() || "";
        const markdown = turndownService.turndown(body);

        results.push({
          url: request.url,
          content: markdown.slice(0, 30000), // 30KB per page
          html: rawHtml.slice(0, 150000) // Store up to 150KB
        });

        if (results.length < maxPages) {
          await enqueueLinks({
            strategy: 'same-domain',
            transformRequestFunction: (req: any) => {
              if (req.url.match(/\.(jpg|jpeg|png|gif|pdf|zip|docx|xlsx|css|js)$/i)) return false;
              return req;
            }
          });
        }
      },
    });

    await cheerioCrawler.run([url]);

    if (results.length === 0) {
      throw new Error("Cheerio crawler finished with 0 results.");
    }

    return results;
  } catch (error: any) {
    console.error("Cheerio Error, falling back to Playwright (if possible):", error.message);

    try {
      const browserlessToken = process.env.BROWSERLESS_TOKEN;
      const scrapingBeeKey = process.env.SCRAPINGBEE_API_KEY;

      if (process.env.VERCEL === '1') {
        console.log("[Scraper] Vercel environment detected. Avoiding local PlaywrightCrawler.");
        
        if (scrapingBeeKey || browserlessToken) {
          console.log("[Scraper] Routing through remote serverless browser mechanism...");
          // Fallback to our existing smart fetch which handles Browserless/ScrapingBee natively 
          // (but only for the root URL, since deep crawling exceeds Vercel timeouts)
          const singleFallback = await smartFetch(url, 45000);
          return [{ url: singleFallback.url, content: singleFallback.markdown, html: singleFallback.html }];
        } else {
          console.warn("[Scraper] No remote browser tokens. Falling back to simple HTTP fetch.");
          throw new Error("No remote browser available in Vercel.");
        }
      }

      console.log("Attempting local Playwright crawl as fallback...");
      const crawlee = (await import('crawlee')) as any;
      const PlaywrightCrawler = crawlee.PlaywrightCrawler;
      const crawler = new PlaywrightCrawler({
        maxRequestsPerCrawl: maxPages,
        requestHandlerTimeoutSecs: 60,
        navigationTimeoutSecs: 60,
        requestHandler: async ({ request, page, log, enqueueLinks }: any) => {
          log.info(`Processing ${request.url}...`);

          try {
            // Wait for network to be idle to ensure JS content is loaded
            await page.waitForLoadState('networkidle', { timeout: 30000 });
          } catch (e) {
            log.warning(`Timeout waiting for network idle on ${request.url}, proceeding with partial content.`);
          }

          const html = await page.content();
          const $ = cheerio.load(html);

          // Clean content
          $("script, style, nav, footer, header, iframe, noscript, svg, path").remove();
          const body = $("body").html() || "";
          const markdown = turndownService.turndown(body);

          results.push({
            url: request.url,
            content: markdown.slice(0, 30000), // 30KB per page
            html: html.slice(0, 150000)
          });

          if (results.length < maxPages) {
            await enqueueLinks({
              strategy: 'same-domain',
              transformRequestFunction: (req: any) => {
                if (req.url.match(/\.(jpg|jpeg|png|gif|pdf|zip|docx|xlsx|css|js)$/i)) return false;
                return req;
              }
            });
          }
        },
        launchContext: {
          launchOptions: {
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
          },
        },
      });

      await crawler.run([url]);

      if (results.length === 0) {
        throw new Error("Playwright crawler finished with 0 results.");
      }

      return results;
    } catch (playwrightError: any) {
      console.error("Playwright/Fallback Error, falling back to simple fetch:", playwrightError.message);
      const simpleContent = await fetchUrlContent(url, 45000);
      return [{ url: simpleContent.url, content: simpleContent.markdown, html: simpleContent.html }];
    }
  }
}

// ─── AI Enrichment Taxonomy ───────────────────────────────────────────────────
// Controlled vocabulary used across all enrichment jobs.
// Merges categories from data.ts, the categories migration, and the user's
// domain knowledge (Industrial Automation, HVAC, Low Current, etc.).

const ENRICHMENT_TAXONOMY: string[] = [
  'Industrial Automation', 'Electrical Equipment', 'HVAC',
  'Construction & Building Materials', 'Medical Supplies & Healthcare',
  'IT Services & Technology', 'Industrial Equipment & Machinery',
  'Food Manufacturing & Beverage', 'Chemicals & Plastics', 'Automotive',
  'Energy & Utilities', 'Transport & Logistics', 'Low Current Systems',
  'Fire & Safety Systems', 'General Manufacturing', 'Metals & Mining',
  'Agriculture & Farming', 'Textiles & Apparel', 'Oil & Gas Services',
  'Water & Wastewater Treatment', 'Printing & Packaging',
  'Facility Management & Maintenance', 'MEP Contracting',
  'Trading & Distribution', 'Real Estate & Property',
];

// ─── AI Enrichment Helpers ────────────────────────────────────────────────────
// Pure functions: accept company data, return parsed AI result.
// No HTTP, no DB writes — only callProvider calls.
// Used by individual routes AND by the /api/ai/run-all batch endpoint.

async function ai_classifyCompany(company: any, provider: AIProvider): Promise<any> {
  const evidence = [
    company.name_en, company.name_ar, company.description_en,
    company.description_ar, company.scope_en, company.scope_ar,
    ...(Array.isArray(company.products) ? company.products : []),
    ...(Array.isArray(company.fields) ? company.fields : []),
  ].filter(Boolean).join('\n');

  const prompt = `You are a Saudi Arabia B2B company categorizer.

Company: ${company.name_en}${company.name_ar ? ` (${company.name_ar})` : ''}
Website: ${company.website_url || 'unknown'}
Evidence:
${evidence.slice(0, 3000)}

Available categories — use EXACT names from this list only:
${ENRICHMENT_TAXONOMY.join(', ')}

Task: Classify this company into 1-3 of the most relevant categories.

Return JSON:
{
  "categories": ["CategoryName1"],
  "primary_category": "CategoryName1",
  "confidence": 0.9,
  "reasoning": "Brief explanation"
}`;

  const config = getProvider(provider);
  const result = await callProvider(provider, prompt, "Classify company into categories as JSON.", config?.enrichmentModel);
  return safeJsonParse(result.content, { categories: [], primary_category: null, confidence: 0, reasoning: "Job failed" });
}

async function ai_normalizeCompany(company: any, provider: AIProvider): Promise<any> {
  const evidence = [
    company.description_en, company.description_ar,
    company.scope_en, company.scope_ar,
    ...(Array.isArray(company.products) ? company.products : []),
    ...(Array.isArray(company.fields) ? company.fields : []),
  ].filter(Boolean).join('\n');

  const prompt = `You are a B2B data normalizer for Saudi Arabian companies.

Company: ${company.name_en}
Raw offerings text:
${evidence.slice(0, 3000)}

Task: Extract and normalize products and services into clean structured lists.
Rules: remove duplicates, title case, max 5 words per item, separate products
(physical goods) from services (work performed).

Return JSON:
{
  "products": ["Product 1", "Product 2"],
  "services": ["Service 1", "Service 2"],
  "scope_summary_en": "One sentence summary in English",
  "scope_summary_ar": "نفس الملخص بالعربية",
  "tags": ["tag1", "tag2"]
}`;

  const config = getProvider(provider);
  const result = await callProvider(provider, prompt, "Normalize products/services as JSON.", config?.enrichmentModel);
  return safeJsonParse(result.content, { products: [], services: [], scope_summary_en: "", scope_summary_ar: "", tags: [] });
}

async function ai_detectBrands(company: any, provider: AIProvider): Promise<any> {
  const evidence = [
    company.description_en, company.description_ar,
    company.scope_en, company.scope_ar,
    ...(Array.isArray(company.brands) ? company.brands : []),
  ].filter(Boolean).join('\n');

  const prompt = `You are a brand relationship detector for B2B companies in Saudi Arabia.

Company: ${company.name_en}
Evidence:
${evidence.slice(0, 3000)}

Task: Detect brand relationships. Only extract clearly stated relationships.
Allowed relationship types: authorized_distributor | reseller | partner |
authorized_service_center | representative | manufacturer | oem

Return JSON:
{
  "brand_relationships": [
    {
      "brand": "Brand Name",
      "relationship": "authorized_distributor",
      "confidence": 0.9,
      "evidence": "exact text that supports this"
    }
  ],
  "raw_brands_detected": ["brand1", "brand2"]
}`;

  const config = getProvider(provider);
  const result = await callProvider(provider, prompt, "Detect brand relationships as JSON.", config?.enrichmentModel);
  return safeJsonParse(result.content, { brand_relationships: [], raw_brands_detected: [] });
}

async function ai_improveProfile(company: any, provider: AIProvider): Promise<any> {
  const products = [
    ...(Array.isArray(company.products) ? company.products : []),
    ...(Array.isArray(company.fields) ? company.fields : []),
  ].join(', ') || 'unknown';

  const prompt = `You are a professional B2B content writer specialising in Saudi Arabian companies.

Company: ${company.name_en}${company.name_ar ? ` (${company.name_ar})` : ''}
Current description EN: ${company.description_en || '(empty)'}
Current description AR: ${company.description_ar || '(empty)'}
Products / services: ${products}
Categories: ${(Array.isArray(company.categories) ? company.categories : []).join(', ') || 'unknown'}

Task: Write improved, professional company content.
Requirements:
- description_en: 2-3 sentences, professional, specific about what they do
- description_ar: accurate natural Arabic (not a literal translation)
- seo_title_en: max 60 chars, keyword-rich
- seo_title_ar: Arabic equivalent, max 60 chars
- seo_description_en: max 150 chars, compelling
- seo_description_ar: Arabic equivalent, max 150 chars

Return JSON:
{
  "description_en": "...",
  "description_ar": "...",
  "seo_title_en": "...",
  "seo_title_ar": "...",
  "seo_description_en": "...",
  "seo_description_ar": "..."
}`;

  const config = getProvider(provider);
  const result = await callProvider(provider, prompt, "Improve company profile content as JSON.", config?.enrichmentModel);
  return safeJsonParse(result.content, { description_en: "", description_ar: "", seo_title_en: "", seo_title_ar: "", seo_description_en: "", seo_description_ar: "" });
}

async function ai_mergeCompanies(master: any, duplicate: any, provider: AIProvider): Promise<any> {
  const heuristicMerge = {
    ...master,
    merged_from: Array.from(new Set([...(master.merged_from || []), duplicate.id])),
    source_links: Array.from(new Set([...(master.source_links || []), ...(duplicate.source_links || []), duplicate.website_url].filter(Boolean) as string[])),
    categories: Array.from(new Set([...(master.categories || []), ...(duplicate.categories || [])])),
    brands: Array.from(new Set([...(master.brands || []), ...(duplicate.brands || [])])),
    products: Array.from(new Set([...(master.products || []), ...(duplicate.products || [])])),
    secondary_emails: Array.from(new Set([...(master.secondary_emails || []), ...(duplicate.secondary_emails || []), duplicate.email, duplicate.sales_email, duplicate.procurement_email].filter(Boolean) as string[])),
    secondary_phones: Array.from(new Set([...(master.secondary_phones || []), ...(duplicate.secondary_phones || []), duplicate.phone, duplicate.whatsapp].filter(Boolean) as string[])),
    secondary_websites: Array.from(new Set([...(master.secondary_websites || []), ...(duplicate.secondary_websites || []), duplicate.website_url].filter(Boolean) as string[])),
    secondary_socials: Array.from(new Set([...(master.secondary_socials || []), ...(duplicate.secondary_socials || []), duplicate.linkedin_url, duplicate.instagram_url, duplicate.twitter_url, duplicate.facebook_url].filter(Boolean) as string[]))
  };

  const prompt = `Merge these company records into a single high-quality master record. 
        
RULES:
1. Preserve ALL unique emails and phone numbers into secondary_emails and secondary_phones.
2. Consolidate ALL social media links. Prioritize master link for primary fields, move alternatives to secondary_linkedin or secondary_socials.
3. Clean and normalize fields. If master is missing a field (e.g. logo, description) and duplicate has it, take it.
4. Merge categories, brands and products into a unique union.
5. Identify the best 'is_verified' status (if either is verified, result is verified).

Current Heuristic Merge (Base): ${JSON.stringify(heuristicMerge)}
Master Source: ${JSON.stringify(master)}
Duplicate Source: ${JSON.stringify(duplicate)}

Return the final merged company object in JSON.`;

  const config = getProvider(provider);
  const result = await callProvider(provider, prompt, "Merge company records as JSON.", config?.enrichmentModel);
  return safeJsonParse(result.content, heuristicMerge);
}

async function ai_suggestMissingFields(company: any, provider: AIProvider): Promise<any> {
  const missingFields = Object.entries({
    categories: !(Array.isArray(company.categories) && company.categories.length),
    products: !(Array.isArray(company.products) && company.products.length),
    description_en: !company.description_en?.trim(),
    description_ar: !company.description_ar?.trim(),
    brands: !(Array.isArray(company.brands) && company.brands.length),
    scope_en: !company.scope_en?.trim(),
    seo_title_en: !company.seo_title_en?.trim(),
    seo_description_en: !company.seo_description_en?.trim(),
  }).filter(([, missing]) => missing).map(([f]) => f);

  if (!missingFields.length) return { suggestions: [] };

  const evidence = [
    company.name_en, company.name_ar, company.description_en,
    company.description_ar, company.scope_en,
    ...(Array.isArray(company.products) ? company.products : []),
    ...(Array.isArray(company.fields) ? company.fields : []),
    ...(Array.isArray(company.brands) ? company.brands : []),
  ].filter(Boolean).join('\n');

  const prompt = `You are a data completeness expert for Saudi Arabian B2B companies.

Company: ${company.name_en}
Evidence:
${evidence.slice(0, 2000)}

Missing fields: ${missingFields.join(', ')}

For each missing field, suggest a value based on available evidence.
Only suggest if confidence > 0.5. Do NOT invent phone, email, website, or exact address.

Return JSON:
{
  "suggestions": [
    {
      "field": "field_name",
      "suggested_value": "string or [array]",
      "confidence": 0.8,
      "reason": "explanation"
    }
  ]
}`;

  const config = getProvider(provider);
  const result = await callProvider(provider, prompt, "Suggest missing fields as JSON.", config?.enrichmentModel);
  return safeJsonParse(result.content, { suggestions: [] });
}

function ai_scoreCompleteness(company: any): any {
  const s = (v: any): number => {
    if (v == null) return 0;
    if (Array.isArray(v)) return v.length > 0 ? 1 : 0;
    if (typeof v === 'string') return v.trim().length > 0 ? 1 : 0;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return 1;
  };

  const contact = (s(company.email) + s(company.phone) + s(company.website_url) + s(company.linkedin_url) + s(company.whatsapp)) / 5;
  const service = (s(company.products) * 2 + s(company.categories) * 2 + s(company.description_en) + s(company.scope_en)) / 6;
  const brand = s(company.brands);
  const social = (s(company.linkedin_url) + s(company.instagram_url) + s(company.twitter_url) + s(company.facebook_url)) / 4;
  const location = (s(company.full_address) + s(company.city_id) + s(company.region_id)) / 3;
  const evidence = (s(company.logo_url) + s(company.is_verified) + s(company.source_url)) / 3;
  const bilingual = (s(company.name_ar) + s(company.description_ar) + s(company.seo_title_ar)) / 3;
  const overall = (contact + service + brand + social + location + evidence + bilingual) / 7;

  const recommendations: string[] = [];
  if (contact < 0.4) recommendations.push('Add contact details (email, phone, LinkedIn)');
  if (service < 0.4) recommendations.push('Add product/service descriptions and categories');
  if (brand < 0.5) recommendations.push('Add represented brands');
  if (social < 0.25) recommendations.push('Add social media links');
  if (location < 0.5) recommendations.push('Complete location fields');
  if (bilingual < 0.5) recommendations.push('Add Arabic translations (name, description, SEO)');
  if (!company.logo_url) recommendations.push('Add company logo URL');

  return {
    scores: {
      contact: Math.round(contact * 100),
      service: Math.round(service * 100),
      brand: Math.round(brand * 100),
      social: Math.round(social * 100),
      location: Math.round(location * 100),
      evidence: Math.round(evidence * 100),
      bilingual: Math.round(bilingual * 100),
      overall: Math.round(overall * 100),
    },
    grade: overall >= 0.8 ? 'A' : overall >= 0.6 ? 'B' : overall >= 0.4 ? 'C' : 'D',
    recommendations,
  };
}

async function ai_summarizeEvidence(company: any, summaryType: string, provider: AIProvider): Promise<any> {
  const evidence = [
    company.description_en, company.description_ar, company.scope_en,
    ...(Array.isArray(company.products) ? company.products : []),
    ...(Array.isArray(company.brands) ? company.brands : []),
    ...(Array.isArray(company.categories) ? company.categories : []),
  ].filter(Boolean).join('\n');

  const questionMap: Record<string, string> = {
    category_evidence: `Explain why "${company.name_en}" belongs to categories: ${(Array.isArray(company.categories) ? company.categories : []).join(', ')}.`,
    brand_evidence: `Explain why "${company.name_en}" is associated with brands: ${(Array.isArray(company.brands) ? company.brands : []).join(', ')}.`,
    general: `Summarise what "${company.name_en}" does based on the available evidence.`,
  };

  const prompt = `You are a B2B data reviewer for a Saudi Arabian company directory.

Company: ${company.name_en}
Evidence:
${evidence.slice(0, 2000)}

${questionMap[summaryType] ?? questionMap.general}

Return JSON:
{
  "summary": "2-3 sentence explanation",
  "evidence_points": ["point 1", "point 2", "point 3"],
  "confidence": 0.85
}`;

  const config = getProvider(provider);
  const result = await callProvider(provider, prompt,
    'You are a precise evidence summariser. Return ONLY valid JSON.',
    config?.discoveryModel);
  return safeJsonParse(result.content, { summary: "", evidence_points: [], confidence: 0 });
}

// ─── API Routes ──────────────────────────────────────────────────────────────
// Define API routes and mount them on the app

function setupApiRoutes(app: express.Application) {
  const apiRouter = express.Router();

  apiRouter.get("/providers/health", async (req, res) => {
    const { provider } = req.query;

    // Swift verification of provider availability

    // We use a swift 4-second timeout to prevent Vercel's 10s ceiling
    // from crashing the route and throwing a 500 HTML page.
    const checkProvider = async (p: AIProvider) => {
      const config = getProvider(p);
      if (!config) {
        return { status: "unconfigured", message: "Provider not found in registry." };
      }

      // Client-side providers special message
      if (config.id === 'webllm') {
        return { status: "ready", model: config.discoveryModel, message: "WebLLM runs via WebGPU in the browser." };
      }

      // Backend providers: check env var presence first
      const envKey = ENV_KEY_MAP[p];
      const hasKey = envKey ? !!process.env[envKey] : false;

      if (!hasKey) {
         return {
          status: "unconfigured",
          model: config.discoveryModel,
          message: `${envKey} is not set in environment variables`
         };
      }

      // Ping to verify the key works (with a strict timeout)
      try {
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 4000));
        // Simple fast prompt
        const callPromise = callProvider(p, "hi", "reply in 1 word", config.discoveryModel);
        
        await Promise.race([callPromise, timeoutPromise]);

        return {
          status: "ready",
          model: config.discoveryModel,
          message: `${config.name} API key is verified and responsive`,
        };
      } catch (err: any) {
        console.warn(`[Health] ${config.name} ping failed:`, err.message);
        return {
          status: "error",
          model: config.discoveryModel,
          message: err.message === 'Timeout' ? "API timed out (4s)" : `API error: ${err.message}`
        };
      }
    };

    try {
      if (provider) {
        const result = await checkProvider(provider as AIProvider);
        return res.json(result);
      }

      const providers: AIProvider[] = ['gemini', 'groq', 'openrouter', 'mistral', 'huggingface'];
      const healthResults: Record<string, any> = {};
      
      // Execute all checks in parallel to save time
      const results = await Promise.all(providers.map(p => checkProvider(p)));
      providers.forEach((p, index) => {
        healthResults[p] = results[index];
      });

      res.json({ status: "ok", providers: healthResults });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  apiRouter.get("/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Queue administration endpoints (PR-4 foundation)
  apiRouter.post("/queue/enqueue", requireModerator, async (req, res) => {
    try {
      const { queueName, url, priority = 1, payload, idempotencyKey, maxAttempts } = req.body ?? {};
      const parsedQueue = parseQueueType(String(queueName || ''));
      if (!parsedQueue) {
        return res.status(400).json({ error: "Invalid queueName." });
      }
      if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: "url is required." });
      }

      const jobId = await queueManager.enqueue(
        parsedQueue,
        url,
        Number(priority) || 1,
        payload,
        typeof idempotencyKey === 'string' ? idempotencyKey : undefined,
        typeof maxAttempts === 'number' ? maxAttempts : undefined
      );

      res.json({ status: "queued", jobId, queueName: parsedQueue });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to enqueue job." });
    }
  });

  apiRouter.get("/queue/stats", requireModerator, async (req, res) => {
    try {
      const queueName = String(req.query.queueName || '');
      const parsedQueue = parseQueueType(queueName);
      if (!parsedQueue) {
        return res.status(400).json({ error: "Invalid queueName." });
      }
      const stats = await queueManager.getQueueStats(parsedQueue);
      res.json({ queueName: parsedQueue, stats });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to fetch queue stats." });
    }
  });

  apiRouter.get("/queue/jobs", requireModerator, async (req, res) => {
    try {
      const queueName = String(req.query.queueName || '');
      const status = String(req.query.status || '');
      const limit = Number(req.query.limit || 50);

      const parsedQueue = parseQueueType(queueName);
      const parsedStatus = parseJobStatus(status);
      if (!parsedQueue || !parsedStatus) {
        return res.status(400).json({ error: "Invalid queueName or status." });
      }

      const jobs = await queueManager.getJobsByStatus(parsedQueue, parsedStatus, Math.min(Math.max(limit, 1), 200));
      res.json({ queueName: parsedQueue, status: parsedStatus, count: jobs.length, jobs });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to fetch queue jobs." });
    }
  });

  apiRouter.post("/queue/retry-failed", requireModerator, async (req, res) => {
    try {
      const { queueName } = req.body ?? {};
      const parsedQueue = parseQueueType(String(queueName || ''));
      if (!parsedQueue) {
        return res.status(400).json({ error: "Invalid queueName." });
      }
      const retried = await queueManager.retryFailedJobs(parsedQueue);
      res.json({ queueName: parsedQueue, retried });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to retry failed jobs." });
    }
  });

  apiRouter.post("/queue/process-once", requireModerator, async (req, res) => {
    try {
      const { queueNames, timeoutMs = 20000 } = req.body ?? {};
      const requested = Array.isArray(queueNames) ? queueNames : [];
      const parsedQueues = (requested.length > 0 ? requested : [QueueType.CRAWL_DIRECTORY, QueueType.CRAWL_COMPANY])
        .map((value: unknown) => parseQueueType(String(value || '')))
        .filter((value): value is QueueType => !!value);

      if (parsedQueues.length === 0) {
        return res.status(400).json({ error: "No valid queue names provided." });
      }

      const workerId = `api-worker-${Date.now()}`;
      const job = await queueManager.claimJob(parsedQueues, workerId);
      if (!job) {
        return res.json({ status: "idle", message: "No pending jobs." });
      }

      const result = await processClaimedJob(job, { timeoutMs: Number(timeoutMs) || 20000 });
      res.json({
        status: result.ok ? "completed" : "failed",
        workerId,
        jobId: job.id,
        queueName: job.queue_name,
        message: result.message,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to process queue job." });
    }
  });

  apiRouter.post("/discover", requireModerator, async (req, res) => {
    const {
      provider,
      baseUrl,
      useAdvanced = false,
      maxPages = 20,
      contentOnly = false,
      allowAI = true,
      pageCursor,
    } = req.body;

    // contentOnly mode: just fetch and return page content, no AI extraction
    if (contentOnly && baseUrl) {
      try {
        const fetched = await safeFetch(baseUrl, 60000);
        if (fetched.blocked) {
          return res.status(403).json({ error: 'Blocked by robots.txt', content: '' });
        }
        const logoRes =
          fetched.html && fetched.html.includes("<")
            ? extractLogoUrl(fetched.html, fetched.url || baseUrl)
            : { value: null as string | null, confidence: 0, source: "" };
        return res.json({
          content: fetched.markdown,
          url: fetched.url,
          htmlLength: fetched.html?.length || 0,
          logo_url: logoRes.value || null,
        });
      } catch (error: any) {
        return res.status(500).json({ error: error.message, content: '' });
      }
    }

    // AI_DISABLED mode: only return deterministic results, skip all AI calls
    const aiDisabled = process.env.AI_DISABLED === 'true';
    const effectiveAllowAI = Boolean(allowAI) && !aiDisabled;

    try {
      let combinedContent = "";
      let targetUrls: string[] = [baseUrl];
      let adapterUsed = false;

      // Check if a source-specific adapter matches this URL
      const adapter = parserRegistry.getAdapter(baseUrl);
      if (adapter && adapter.id !== 'universal-ai') {
        console.log(`Using adapter "${adapter.name}" for ${baseUrl}`);
        // Use safe fetch (respects robots.txt + rate limiting)
        const fetched = await safeFetch(baseUrl, 60000);
        if (fetched.blocked) {
          return res.status(403).json({ error: 'Blocked by robots.txt' });
        }
        if (fetched.html) {
          const result = await adapter.parse(fetched.html, baseUrl);
          const paginatedUrls = adapter.discoverPagination?.(fetched.html, baseUrl) ?? [];
          const uniquePaginated = [...new Set(paginatedUrls)];

          // Factories incremental mode: crawl 1 page per request and return nextCursor for client looping.
          const isMcciFactories =
            adapter?.id === 'saudi-chamber' &&
            /\/home\/factories/i.test(baseUrl) &&
            /mcci\.org\.sa/i.test(baseUrl);

          const plannedUrls = isMcciFactories
            ? [baseUrl, ...uniquePaginated].slice(0, Math.max(1, Number(maxPages || 1)))
            : [baseUrl, ...uniquePaginated].slice(0, Math.max(1, Number(maxPages || 1)));

          const cursorNum = Number.isFinite(Number(pageCursor)) ? Math.max(0, Number(pageCursor)) : 0;
          const activeIdx = Math.min(cursorNum, plannedUrls.length - 1);
          const activeUrl = plannedUrls[activeIdx];

          let parsedPages: any[] = [];
          let activeResult: any = result;
          let activeFetchedHtml = fetched.html;

          if (isMcciFactories) {
            // Only parse ONE page per request.
            if (activeIdx === 0) {
              activeResult = result;
              activeFetchedHtml = fetched.html;
            } else {
              const page = await safeFetch(activeUrl, 60000);
              if (!page.blocked && page.html) {
                activeResult = await adapter.parse(page.html, activeUrl);
                activeFetchedHtml = page.html;
              } else {
                activeResult = { companies: [], totalFound: 0, parseMethod: 'adapter', adapterName: adapter.name, warnings: ['Failed to fetch pagination page.'] };
                activeFetchedHtml = '';
              }
            }

            parsedPages = []; // none in incremental mode
          } else {
            const paginationTargets = uniquePaginated.slice(0, Math.max(0, Number(maxPages || 1) - 1));
            const paginationResults = await Promise.allSettled(
              paginationTargets.map(async (url) => {
                const page = await safeFetch(url, 60000);
                if (page.blocked || !page.html) return null;
                return adapter.parse(page.html, url);
              })
            );

            parsedPages = paginationResults
              .filter((p): p is PromiseFulfilledResult<any> => p.status === 'fulfilled' && !!p.value)
              .map(p => p.value);
          }

          const allCompanies = isMcciFactories
            ? [...(activeResult.companies ?? [])]
            : [
                ...result.companies,
                ...parsedPages.flatMap(p => p.companies ?? []),
              ];

          // Dedupe: prefer the "most complete" record when same-name duplicates appear
          // (common on SaudiIndustryGuide where content repeats and earlier copy may miss Website line).
          const pickBetter = (a: any, b: any) => {
            const hasWebA = !!(a?.website_url || '').toString().trim();
            const hasWebB = !!(b?.website_url || '').toString().trim();
            if (hasWebA !== hasWebB) return hasWebB ? b : a;

            const hasEmailA = !!(a?.email || '').toString().trim();
            const hasEmailB = !!(b?.email || '').toString().trim();
            if (hasEmailA !== hasEmailB) return hasEmailB ? b : a;

            const hasPhoneA = !!(a?.phone || '').toString().trim();
            const hasPhoneB = !!(b?.phone || '').toString().trim();
            if (hasPhoneA !== hasPhoneB) return hasPhoneB ? b : a;

            const scoreA = Number(a?.confidence_score || 0);
            const scoreB = Number(b?.confidence_score || 0);
            if (scoreA !== scoreB) return scoreB > scoreA ? b : a;

            // Default: keep the earlier one for stability.
            return a;
          };

          const normalizeNameKey = (v: unknown) => {
            const raw = (v || '').toString().trim().toLowerCase();
            if (!raw) return '';
            // remove common suffixes and extra noise
            const noSuffix = raw.replace(/\s*\|\s*saudi\s+industry\s+guide\s*$/i, '').trim();
            return noSuffix
              .replace(/[\u00A0]/g, ' ')
              .replace(/[^\p{L}\p{N}\s.-]+/gu, ' ') // keep letters/numbers/spaces and .- (domains)
              .replace(/\s+/g, ' ')
              .trim();
          };

          const dedupMap = new Map<string, any>();
          for (const company of allCompanies) {
            const name = normalizeNameKey(company?.name_en || company?.name_ar);
            const website = (company?.website_url || '').toString().trim().toLowerCase();

            // Primary key: name (so a later duplicate that includes Website overrides earlier no-website copy).
            // If name is missing, fall back to website key.
            const key = name || (website ? `|||${website}` : '');
            if (!key) continue;

            const existing = dedupMap.get(key);
            if (!existing) dedupMap.set(key, company);
            else dedupMap.set(key, pickBetter(existing, company));
          }

          let dedupedCompanies = Array.from(dedupMap.values());

          // SaudiIndustryGuide-specific cleanup:
          // If a "profile" crawl yields a stub record (no website/email/phone) and a fuller record exists
          // under the same normalized name, drop the stub to prevent null-website entries from surfacing.
          if (adapter?.id === 'saudi-industry-guide') {
            const bestByName = new Map<string, any>();
            for (const c of dedupedCompanies) {
              const k = normalizeNameKey(c?.name_en || c?.name_ar);
              if (!k) continue;
              const existing = bestByName.get(k);
              bestByName.set(k, existing ? pickBetter(existing, c) : c);
            }
            dedupedCompanies = Array.from(bestByName.values());

            // Extra safety: also merge using an even stricter key (remove spaces/punctuation)
            // to avoid any Unicode / punctuation mismatch between homepage and profile titles.
            const strictKey = (v: unknown) =>
              normalizeNameKey(v).replace(/[\s.-]+/g, '');
            const bestByStrict = new Map<string, any>();
            for (const c of dedupedCompanies) {
              const k = strictKey(c?.name_en || c?.name_ar);
              if (!k) continue;
              const existing = bestByStrict.get(k);
              bestByStrict.set(k, existing ? pickBetter(existing, c) : c);
            }
            if (bestByStrict.size > 0) dedupedCompanies = Array.from(bestByStrict.values());
          }

          if (dedupedCompanies.length > 0) {
            adapterUsed = true;
            // Run deterministic extractors on the source page for additional fields
            const evidenceHtml = isMcciFactories ? (activeFetchedHtml || '') : fetched.html;
            const evidenceUrl = isMcciFactories ? activeUrl : baseUrl;
            const nameResult = extractCompanyName(evidenceHtml, evidenceUrl);
            const emailResult = extractEmails(evidenceHtml, evidenceUrl);
            const phoneResult = extractPhones(evidenceHtml, evidenceUrl);
            const socialResult = extractSocialLinks(evidenceHtml, evidenceUrl);
            const addrResult = extractAddress(evidenceHtml, evidenceUrl);
            const descResult = extractDescription(evidenceHtml, evidenceUrl);
            const logoResult = extractLogoUrl(evidenceHtml, evidenceUrl);
            const websiteResult = extractWebsiteUrl(evidenceHtml, evidenceUrl);

            // Page-level extractors (website/address/desc/logo/social/etc.) are only safe to
            // apply when this page represents ONE company. On multi-company directory pages,
            // these values can belong to the directory or a random listing and will corrupt data.
            const canApplyPageLevelExtractors = dedupedCompanies.length === 1;

            // Store evidence for the source page
            await storeFieldEvidence(undefined, [
              { field_name: 'page_html', value: fetched.html?.slice(0, 50000), source_url: baseUrl, extraction_method: 'http_fetch', confidence: 1.0 },
              { field_name: 'page_type', value: 'directory_listing', source_url: baseUrl, extraction_method: 'adapter', extraction_detail: adapter.name, confidence: 1.0 },
            ]);

            // Enrich adapter results with deterministic extractor data
            // where the adapter didn't provide certain fields
            // SaudiIndustryGuide: build a "best record" lookup across *all* crawled companies
            // so stub profile records can inherit website/email/phone from the homepage record.
            const sigStrictKey = (v: unknown) => normalizeNameKey(v).replace(/[\s.-]+/g, '');
            const sigBestByKey =
              adapter?.id === 'saudi-industry-guide'
                ? (() => {
                    const m = new Map<string, any>();
                    for (const c of allCompanies) {
                      const k = sigStrictKey(c?.name_en || c?.name_ar);
                      if (!k) continue;
                      const existing = m.get(k);
                      m.set(k, existing ? pickBetter(existing, c) : c);
                    }
                    return m;
                  })()
                : null;

            const cleanedCompanies = dedupedCompanies.map(company => {
              const enhanced = {
                ...company,
                website_url: company.website_url ? canonicalizeUrl(company.website_url, baseUrl) || company.website_url : undefined
              };

              if (adapter?.id === 'saudi-industry-guide' && sigBestByKey) {
                const k = sigStrictKey(enhanced?.name_en || enhanced?.name_ar);
                const best = k ? sigBestByKey.get(k) : null;
                if (best) {
                  if (!enhanced.website_url && best.website_url) enhanced.website_url = best.website_url;
                  if (!enhanced.email && best.email) enhanced.email = best.email;
                  if (!enhanced.phone && best.phone) enhanced.phone = best.phone;
                  if (!enhanced.full_address && best.full_address) enhanced.full_address = best.full_address;
                }
              }

              // If adapter didn't provide certain fields, supplement from page-level extraction.
              // SaudiIndustryGuide pages frequently include unrelated "Website" labels in theme widgets/footer,
              // which can cause the same website to be assigned across different companies.
              const shouldSupplementWebsite =
                canApplyPageLevelExtractors &&
                adapter?.id !== 'saudi-industry-guide' &&
                !enhanced.website_url &&
                !!websiteResult.value;

              if (shouldSupplementWebsite) {
                const rawWebsite = websiteResult.value as string;
                enhanced.website_url = canonicalizeUrl(rawWebsite, baseUrl) || rawWebsite;
                enhanced.field_confidence = { ...(enhanced.field_confidence || {}), website_url: websiteResult.confidence };
              }
              if (canApplyPageLevelExtractors && !enhanced.phone && phoneResult.value?.[0]) {
                enhanced.phone = phoneResult.value[0];
                enhanced.field_confidence = { ...(enhanced.field_confidence || {}), phone: phoneResult.confidence };
              }
              if (canApplyPageLevelExtractors && !enhanced.email && emailResult.value?.[0]) {
                enhanced.email = emailResult.value[0];
                enhanced.field_confidence = { ...(enhanced.field_confidence || {}), email: emailResult.confidence };
              }
              if (canApplyPageLevelExtractors && !enhanced.logo_url && logoResult.value) {
                enhanced.logo_url = logoResult.value;
                enhanced.field_confidence = { ...(enhanced.field_confidence || {}), logo_url: logoResult.confidence };
              }
              // Supplement description / address / social when adapter didn't provide them
              if (canApplyPageLevelExtractors && !enhanced.description_en && descResult.value) {
                enhanced.description_en = descResult.value;
                enhanced.field_confidence = { ...(enhanced.field_confidence || {}), description_en: descResult.confidence };
              }
              // Adapter uses full_address, legacy adapters sometimes use city; prefer full_address when available
              if (canApplyPageLevelExtractors && !enhanced.full_address && addrResult.value) {
                enhanced.full_address = addrResult.value;
                enhanced.field_confidence = { ...(enhanced.field_confidence || {}), full_address: addrResult.confidence };
              }
              if (canApplyPageLevelExtractors && socialResult.value) {
                const s = socialResult.value as any;
                if (!enhanced.linkedin_url && s.linkedin) enhanced.linkedin_url = s.linkedin;
                if (!enhanced.facebook_url && s.facebook) enhanced.facebook_url = s.facebook;
                if (!enhanced.instagram_url && s.instagram) enhanced.instagram_url = s.instagram;
                if (!enhanced.twitter_url && s.twitter) enhanced.twitter_url = s.twitter;
                enhanced.field_confidence = { ...(enhanced.field_confidence || {}), social: socialResult.confidence };
              }

              return enhanced;
            });

            // SaudiChamber Factories: auto-follow detail pages to extract richer fields (no AI).
            // Listing pages only contain name + activity, while detail pages include email/phone/address/products.
            const enrichWithFactoryDetails = async (companies: any[]) => {
              const detailCompanies = companies.filter((c) =>
                typeof c?.source_url === 'string' && /\/home\/factorydetails\/\d+/i.test(c.source_url)
              );
              if (detailCompanies.length === 0) return companies;

              // Hard caps to keep /discover responsive even if maxPages is large (FE default can be 20).
              // Each factories page yields ~12 items. We cap detail fetches to avoid multi-minute runs.
              const expectedPerPage = 12;
              const softExpected = Math.max(expectedPerPage * Math.max(1, Number(maxPages || 1)), expectedPerPage * 2);
              const capDetails = Math.min(detailCompanies.length, Math.min(softExpected, 80));
              const cappedDetailCompanies = detailCompanies.slice(0, capDetails);

              const runWithConcurrency = async <T, R>(
                items: T[],
                concurrency: number,
                worker: (item: T, idx: number) => Promise<R>
              ): Promise<R[]> => {
                const results: R[] = new Array(items.length) as any;
                let i = 0;
                const runners = Array.from({ length: Math.max(1, concurrency) }).map(async () => {
                  while (i < items.length) {
                    const idx = i++;
                    results[idx] = await worker(items[idx], idx);
                  }
                });
                await Promise.all(runners);
                return results;
              };

              // Fetch + extract deterministically from each detail page.
              const enriched = await runWithConcurrency(cappedDetailCompanies, 8, async (c) => {
                try {
                  // Detail pages are small; keep timeout lower so we don't stall the whole request.
                  const page = await safeFetch(c.source_url, 25000);
                  if (page.blocked || !page.html) return c;

                  const emailRes = extractEmails(page.html, c.source_url);
                  const phoneRes = extractPhones(page.html, c.source_url);
                  const addrRes = extractAddress(page.html, c.source_url);
                  const descRes = extractDescription(page.html, c.source_url);
                  const websiteRes = extractWebsiteUrl(page.html, c.source_url);

                  const out = { ...c };

                  // Detail pages represent ONE factory, so page-level extractors are safe here.
                  if (!out.email && emailRes.value?.[0]) {
                    out.email = emailRes.value[0];
                    out.field_confidence = { ...(out.field_confidence || {}), email: emailRes.confidence };
                  }
                  if (!out.phone && phoneRes.value?.[0]) {
                    out.phone = phoneRes.value[0];
                    out.field_confidence = { ...(out.field_confidence || {}), phone: phoneRes.confidence };
                  }
                  if (!out.full_address && addrRes.value) {
                    out.full_address = addrRes.value;
                    out.field_confidence = { ...(out.field_confidence || {}), full_address: addrRes.confidence };
                  }
                  if (!out.description_en && descRes.value) {
                    out.description_en = descRes.value;
                    out.field_confidence = { ...(out.field_confidence || {}), description_en: descRes.confidence };
                  }
                  if (!out.website_url && websiteRes.value) {
                    const raw = websiteRes.value as string;
                    out.website_url = canonicalizeUrl(raw, c.source_url) || raw;
                    out.field_confidence = { ...(out.field_confidence || {}), website_url: websiteRes.confidence };
                  }

                  return out;
                } catch {
                  return c;
                }
              });

              const enrichedByUrl = new Map<string, any>();
              for (const c of enriched) enrichedByUrl.set(c.source_url, c);
              return companies.map((c) => enrichedByUrl.get(c.source_url) || c);
            };

            const companiesAfterDetail = isMcciFactories
              ? await enrichWithFactoryDetails(cleanedCompanies)
              : cleanedCompanies;

            const validatedCompanies = await validateAndCleanCompanies(companiesAfterDetail);

            res.json({
              buildId: BUILD_ID,
              adapterId: adapter?.id || null,
              data: validatedCompanies,
              parseMethod: result.parseMethod,
              adapterName: result.adapterName,
              totalFound: validatedCompanies.length,
              pagesCrawled: isMcciFactories ? 1 : 1 + parsedPages.length,
              cursor: isMcciFactories
                ? {
                    pageCursor: activeIdx,
                    nextCursor: activeIdx + 1 < plannedUrls.length ? activeIdx + 1 : null,
                    plannedPages: plannedUrls.length,
                    activeUrl,
                  }
                : null,
              warnings: [
                ...(result.warnings || []),
                ...(isMcciFactories && Number(maxPages || 20) > 8
                  ? ['Factories detail enrichment is capped for performance; reduce maxPages if you need deeper coverage.']
                  : []),
              ],
              evidence: {
                name: nameResult.value,
                emails: emailResult.value,
                phones: phoneResult.value,
                social: socialResult.value,
                address: addrResult.value,
                description: descResult.value,
                logo_url: logoResult.value,
              }
            });
            return;
          }
          console.warn(`Adapter "${adapter.name}" found 0 companies, falling back to generic parser then AI.`);
        }
      }

      // AI_DISABLED or allowAI=false: keep legacy response shape, skip AI extraction.
      if (!effectiveAllowAI) {
        console.log(`[Discovery] AI extraction skipped (${aiDisabled ? 'AI_DISABLED' : 'allowAI=false'}). Returning deterministic-only response.`);
        return res.json({
          data: [],
          usage: null,
          warnings: [aiDisabled ? 'AI is disabled on this server.' : 'AI extraction was skipped by request (allowAI=false).'],
        });
      }

      if (useAdvanced) {
        const scrapedData = await advancedScrape(baseUrl, maxPages);
        combinedContent = scrapedData.map(d => `URL: ${d.url}\n\n${d.content}`).join("\n\n---\n\n");
      } else {
        // Step 1: Discovery (Identify links) — use smart fetch for JS-heavy sites
        const baseContent = await safeFetch(baseUrl, 60000);
        if (baseContent.blocked) {
          return res.status(403).json({ error: 'Blocked by robots.txt' });
        }

        const prompt = `Analyze this website content from ${baseUrl}:
        
        ${baseContent.markdown}
        
        Identify up to 30 internal URLs that are likely to contain lists of companies, partners, vendors, or members.
        Return only a JSON array of absolute URLs.`;

        // Call the selected provider for discovery
        const discoveredUrls = await callProvider(provider, prompt, "Identify internal links as a JSON array of strings.");
        const parsed = safeJsonParse(discoveredUrls.content, []);
        if (Array.isArray(parsed)) {
          targetUrls = [...new Set([baseUrl, ...parsed])].slice(0, 30);
        }

        // Step 2: Parallel Scraping — use smart fetch for each URL (Using Promise.allSettled to prevent batch failure)
        const fetchResults = await Promise.allSettled(targetUrls.map(url => safeFetch(url, 45000)));
        const contents: { markdown: string }[] = [];
        const successfulUrls: string[] = [];
        
        fetchResults.forEach((result, i) => {
          if (result.status === 'fulfilled') {
            if (!result.value.blocked) {
              contents.push(result.value);
              successfulUrls.push(targetUrls[i]);
            }
          } else {
            console.warn(`[Discovery] Failed to fetch target URL: ${targetUrls[i]}`, result.reason);
          }
        });

        combinedContent = contents.map((c, i) => `URL: ${successfulUrls[i]}\n\n${c.markdown}`).join("\n\n---\n\n");
      }

      // Step 3: Extraction
      const extractionPrompt = `Using the following content from multiple pages of a website, identify and extract information for EVERY SINGLE company mentioned.
      Do not skip any. If there are 100 companies, extract 100.
      Focus on Saudi Arabian companies or companies operating in Saudi Arabia.
      Do NOT use a "city" field. Put any location (city, district, street) in full_address only.
      Return a JSON array of objects with the following schema:
      {
        "name_en": string,
        "name_ar": string,
        "business_type": "vendor" | "manufacturer" | "trader",
        "description_en": string,
        "description_ar": string,
        "website_url": string,
        "logo_url": string,
        "phone": string,
        "email": string,
        "linkedin_url": string,
        "full_address": string,
        "sales_email": string,
        "procurement_email": string,
        "categories": string[],
        "products": string[],
        "fields": string[],
        "confidence_score": number,
        "field_confidence": {
          "name_en": number,
          "name_ar": number,
          "business_type": number,
          "description_en": number,
          "description_ar": number,
          "website_url": number,
          "logo_url": number,
          "phone": number,
          "email": number,
          "linkedin_url": number,
          "full_address": number,
          "sales_email": number,
          "procurement_email": number,
          "categories": number,
          "products": number,
          "fields": number
        }
      }

      Confidence scoring rules (0.0-1.0):
      - 0.9-1.0: Field found on dedicated page (About, Contact, etc.) or in structured data
      - 0.6-0.8: Field found in page body text or meta tags
      - 0.3-0.5: Field inferred or guessed from context
      - 0.0-0.2: Field not found, default or placeholder value used

      Content:
      ${combinedContent.slice(0, 40000)}`;

      const config = getProvider(provider as AIProvider);
      const model = config?.discoveryModel;

      const result = await callProvider(provider, extractionPrompt, "Extract company data as a JSON array of objects.", model);
      const validatedCompanies = await validateAndCleanCompanies(safeJsonParse(result.content, []));
      res.json({
        data: validatedCompanies,
        usage: result.usage
      });

    } catch (error: any) {
      console.error("Discovery Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  apiRouter.post("/enrich", requireModerator, async (req, res) => {
    const { provider, companyId, websiteUrl } = req.body;

    if (!websiteUrl) {
      return res.status(400).json({ error: "Website URL is required for enrichment." });
    }

    try {
      const rawW = String(websiteUrl).trim();
      const withProto = /^https?:\/\//i.test(rawW) ? rawW : `https://${rawW.replace(/^\/+/, "")}`;
      const websiteUrlNorm = canonicalizeUrl(withProto) || withProto;

      // Step 1: Scrape the website to discover pages
      const allPages = await advancedScrape(websiteUrlNorm, 6);

      // Step 2: Classify pages by type and prioritize high-value pages
      const urls = allPages.map(p => p.url);
      const prioritized = prioritizePages(urls, websiteUrlNorm, 6);

      // Always ensure homepage is included even if not discovered
      const hasHomepage = prioritized.some(p => p.pageType === 'homepage');
      const enrichedPages = hasHomepage
        ? prioritized
        : [{ url: websiteUrlNorm, pageType: 'homepage' as const, confidence: 0.95 }, ...prioritized].slice(0, 6);

      // Map back to scraped content, fetching missing pages if needed
      const prioritizedUrls = enrichedPages.map(p => p.url);
      const missingUrls = prioritizedUrls.filter(url => !allPages.some(p => p.url === url));

      let finalPages = [...allPages.filter(p => prioritizedUrls.includes(p.url))];

      // Fetch missing high-priority pages
      for (const url of missingUrls.slice(0, 3)) {
        try {
          const fetched = await smartFetch(url, 30000);
          if (fetched.html || !fetched.markdown.startsWith('Error')) {
            finalPages.push({ url: fetched.url, content: fetched.markdown, html: fetched.html });
          }
        } catch (e) {
          console.warn(`Failed to fetch prioritized page: ${url}`, e);
        }
      }

      const combinedContent = finalPages.map(d => `[${classifyPage(d.url, websiteUrlNorm).pageType.toUpperCase()}] ${d.url}\n\n${d.content}`).join("\n\n---\n\n");

      // Step 3: AI Enrichment (pages are labeled with their type: [HOMEPAGE], [CONTACT], [ABOUT], etc.)
      const enrichmentPrompt = `Official company website (canonical): ${websiteUrlNorm}

CRITICAL — grounding:
- Use ONLY the "Website Content" sections below. Each block is from a URL on this same site.
- Do NOT invent emails, phones, CR/VAT, or addresses. Return null when not clearly present in the content.
- Do NOT mix in another company with a similar name or domain.

      Each content section is labeled with its page type in brackets (e.g., [CONTACT], [ABOUT], [HOMEPAGE]).
      Pages are ordered by importance: homepage first, then contact/about pages prioritized.
      Do NOT use a "city" field — put city, district, and street into full_address only.

      Extract when present:
      1. Logo URL (absolute)
      2. full_address — full location in one string (Saudi Arabia context)
      3. Primary/general email, phone
      4. Sales and procurement emails
      5. LinkedIn, Instagram, Twitter/X, Facebook company URLs
      6. description_en, description_ar — short factual overviews (not only the company name)
      7. seo_title_en, seo_title_ar, seo_description_en, seo_description_ar
      8. Saudi compliance if visible: cr_number, vat_number, chamber_commerce_id, is_vat_registered (boolean), procurement_portal_url (Etimad/tenders/etc.)
      9. categories — 1–5 directory categories (use exact names from site or best match)
      10. products — short product/service lines for the Products tab
      11. fields — industry/specialization tags for the Industry Fields section (e.g. Steel, Electrical)

      Website Content:
      ${combinedContent.slice(0, 50000)}

      Return a JSON object with the following schema (use null for unknown fields):
      {
        "logo_url": "string or null",
        "full_address": "string or null",
        "email": "string or null",
        "phone": "string or null",
        "sales_email": "string or null",
        "procurement_email": "string or null",
        "linkedin_url": "string or null",
        "instagram_url": "string or null",
        "twitter_url": "string or null",
        "facebook_url": "string or null",
        "description_en": "string or null",
        "description_ar": "string or null",
        "seo_title_en": "string or null",
        "seo_title_ar": "string or null",
        "seo_description_en": "string or null",
        "seo_description_ar": "string or null",
        "cr_number": "string or null",
        "vat_number": "string or null",
        "chamber_commerce_id": "string or null",
        "is_vat_registered": "boolean or null",
        "procurement_portal_url": "string or null",
        "categories": string[] | null,
        "products": string[] | null,
        "fields": string[] | null,
        "confidence_score": number (0-1),
        "field_confidence": {
          "logo_url": number,
          "full_address": number,
          "email": number,
          "phone": number,
          "sales_email": number,
          "procurement_email": number,
          "linkedin_url": number,
          "instagram_url": number,
          "twitter_url": number,
          "facebook_url": number,
          "description_en": number,
          "description_ar": number,
          "seo_title_en": number,
          "seo_title_ar": number,
          "seo_description_en": number,
          "seo_description_ar": number,
          "cr_number": number,
          "vat_number": number,
          "chamber_commerce_id": number,
          "is_vat_registered": number,
          "procurement_portal_url": number,
          "categories": number,
          "products": number,
          "fields": number
        }
      }

      Confidence scoring rules (0.0-1.0):
      - 0.9-1.0: Field found on dedicated page ([CONTACT] for emails, [ABOUT] for address)
      - 0.6-0.8: Field found in footer, meta tags, or sidebar of [HOMEPAGE]
      - 0.3-0.5: Field inferred from context or [OTHER] pages
      - 0.0-0.2: Field not found, returning null`;

      const isConfigured = (p: AIProvider) => {
        const envKey = ENV_KEY_MAP[p as string];
        return envKey ? !!process.env[envKey] : false;
      };

      // Strict provider mode:
      // - If client sends provider -> use exactly that provider.
      // - If omitted -> use backend default provider (groq).
      const selectedProvider = (String(provider || '').trim() || 'groq') as AIProvider;

      if (!isConfigured(selectedProvider)) {
        return res.status(400).json({
          error: `Provider "${selectedProvider}" is not configured on the backend.`,
          hint: `Set ${ENV_KEY_MAP[selectedProvider] || 'the required API key'} in saudidex-backend/.env`
        });
      }

      let enrichedData: { content: string; usage?: any } | undefined;
      let usedProvider: AIProvider | null = selectedProvider;

      try {
        const config = getProvider(selectedProvider);
        const model = config?.enrichmentModel;
        enrichedData = await callProvider(selectedProvider, enrichmentPrompt, "Extract company enrichment data as JSON.", model);
      } catch (e: any) {
        const msg = String(e?.message || e || "Unknown error");
        const isRateLimited = /quota exceeded|rate limit|too many requests|429/i.test(msg);
        return res.status(isRateLimited ? 429 : 500).json({
          error: isRateLimited ? "AI provider is rate limited / quota exceeded." : "Failed to enrich company data.",
          message: msg,
          provider: selectedProvider,
        });
      }

      if (!enrichedData) {
        return res.status(500).json({
          error: "Failed to enrich company data.",
          provider: selectedProvider,
        });
      }

      const parsed: any = safeJsonParse(enrichedData.content, null as any);
      if (!parsed || typeof parsed !== 'object') {
        console.error("Failed to parse enriched data:", enrichedData.content);
        return res.status(500).json({
          error: "Failed to parse AI response.",
          provider: usedProvider,
        });
      }

      // Prefer deterministic header/site logo from HTML over model guesses
      const pagesForLogo = [...finalPages].filter((p) => p.html?.includes("<"));
      pagesForLogo.sort((a, b) => {
        const ha = classifyPage(a.url, websiteUrlNorm).pageType === "homepage" ? 0 : 1;
        const hb = classifyPage(b.url, websiteUrlNorm).pageType === "homepage" ? 0 : 1;
        return ha - hb;
      });
      for (const p of pagesForLogo) {
        const lg = extractLogoUrl(p.html as string, p.url || websiteUrlNorm);
        if (lg.value) {
          parsed.logo_url = lg.value;
          parsed.field_confidence = { ...(parsed.field_confidence || {}), logo_url: lg.confidence };
          break;
        }
      }

        // Store raw HTML for re-parsing capability
        // Each page's HTML is stored in a 'company_raw_html' table
        const rawHtmlData = finalPages
          .filter(p => p.html)
          .map((p, i) => ({
            page_type: classifyPage(p.url, websiteUrlNorm).pageType,
            url: p.url,
            html: p.html,
            scraped_at: new Date().toISOString(),
            order: i
          }));

        if (rawHtmlData.length > 0) {
          // Store using Supabase admin client (server-side, bypasses RLS)
          try {
            const { supabaseAdmin } = await import("./shared/lib/supabase");
            if (supabaseAdmin) {
              const { error } = await supabaseAdmin
                .from('company_raw_html')
                .upsert({
                  company_id: companyId,
                  pages: rawHtmlData,
                  stored_at: new Date().toISOString()
                }, { onConflict: 'company_id' });

              if (error) {
                console.warn("Failed to store raw HTML (non-critical):", error);
              }
            }
          } catch (storeError) {
            console.warn("Failed to store raw HTML (non-critical):", storeError);
          }
        }

        res.json({
          ...(parsed && typeof parsed === 'object' ? parsed : {}),
          usage: enrichedData.usage,
          provider: usedProvider,
          pagesScraped: finalPages.length,
          pagesStored: rawHtmlData.length
        });
      } catch (error: any) {
        console.error("Enrichment Error:", error);
        res.status(500).json({ error: error?.message || "Failed to enrich company data." });
      }
  });

  apiRouter.post("/duplicates/detect", requireModerator, async (req, res) => {
    const { provider, companies } = req.body;

    if (!companies || !Array.isArray(companies)) {
      return res.status(400).json({ error: "Companies array is required." });
    }

    // Check if AI is disabled
    if (process.env.AI_DISABLED === 'true') {
      return res.json({ 
        status: 'ai_disabled', 
        message: 'AI duplicate detection is disabled.',
        groups: []
      });
    }

    try {
      const prompt = `Analyze the following list of companies and identify potential duplicates.
      A duplicate is a company that represents the same physical or legal entity, even if the name, website, or address varies slightly.

      Companies:
      ${JSON.stringify(companies.map(c => ({
        id: c.id,
        name_en: c.name_en,
        name_ar: c.name_ar,
        website_url: c.website_url,
        full_address: c.full_address
      })), null, 2)}

      Return a JSON array of objects, where each object represents a group of potential duplicates:
      {
        "companyIds": ["id1", "id2", ...],
        "reason": "Brief explanation of why these are duplicates"
      }
      Only include groups with 2 or more companies. If no duplicates are found, return an empty array [].`;

      const config = getProvider(provider as AIProvider);
      const model = config?.discoveryModel;

      const result = await callProvider(provider, prompt, "Identify duplicate companies as a JSON array of groups.", model);

      const parsed = safeJsonParse(result.content, []);
      res.json({
        groups: Array.isArray(parsed) ? parsed : [],
        usage: result.usage
      });
    } catch (error: any) {
      console.error("Duplicate Detection Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  apiRouter.post("/research", requireModerator, async (req, res) => {
    const { provider, task, query, goal } = req.body;

    if (!provider || !task) {
      return res.status(400).json({ error: "Provider and task are required." });
    }

    // Check if AI is disabled
    if (process.env.AI_DISABLED === 'true') {
      return res.json({ 
        status: 'ai_disabled', 
        message: 'AI research capabilities are disabled.',
        result: null
      });
    }

    try {
      const config = getProvider(provider as AIProvider);
      if (!config || !config.enabled) {
        return res.status(400).json({ error: `Provider ${provider} is not enabled.` });
      }

      const model = config.researchModel;

      switch (task) {
        case 'followUpQuestions': {
          if (!query) {
            return res.status(400).json({ error: "Query is required for followUpQuestions." });
          }
          const prompt = `Given the research query: "${query}", generate 3-5 follow-up questions that would help clarify the research goals and narrow down the scope.
Return only a JSON array of strings.`;

          const result = await callProvider(
            provider,
            prompt,
            "Generate follow-up questions for research. Return ONLY valid JSON array of strings.",
            model
          );
          const questions = safeJsonParse(result.content, []);
          return res.json({ questions, usage: result.usage });
        }

        case 'deepResearch': {
          if (!goal || !goal.query) {
            return res.status(400).json({ error: "Goal with query is required for deepResearch." });
          }

          const researchGoal = goal;
          let learnings: string[] = [];
          let visitedUrls: string[] = [];

          // Multi-step research loop
          for (let depth = 0; depth <= researchGoal.depth; depth++) {
            // Generate search queries
            const serpPrompt = `Based on the research goal: "${researchGoal.query}" and current learnings: ${learnings.join(". ") || "none yet"},
generate ${researchGoal.breadth || 3} diverse search queries to explore this topic further.
Return only a JSON array of strings.`;

            const serpResult = await callProvider(
              provider,
              serpPrompt,
              "Generate search queries for research. Return ONLY valid JSON array of strings.",
              model
            );
            const queries: string[] = safeJsonParse(serpResult.content, []);

            for (const searchQuery of queries.slice(0, 3)) {
              // Use web search to find relevant URLs
              try {
                const searchResult = await callProvider(
                  provider,
                  `Search for information about: "${searchQuery}". Return relevant URLs as a JSON array of strings.`,
                  "Find URLs related to the search query. Return ONLY valid JSON array of URL strings.",
                  model
                );
                const urls: string[] = safeJsonParse(searchResult.content, []);
                const newUrls = urls.filter((u: string) => !visitedUrls.includes(u)).slice(0, 3);
                visitedUrls = [...new Set([...visitedUrls, ...newUrls])];

                if (newUrls.length > 0) {
                  // Fetch and analyze content from URLs
                  const urlContents = await Promise.all(
                    newUrls.slice(0, 2).map(url => fetchUrlContent(url, 15000))
                  );
                  const combinedContent = urlContents.join("\n\n---\n\n");

                  const analysisPrompt = `Analyze the following content and extract key learnings related to the research goal: "${researchGoal.query}".

Content:
${combinedContent.slice(0, 10000)}

Return a JSON array of concise learning points (strings).`;

                  const analysisResult = await callProvider(
                    provider,
                    analysisPrompt,
                    "Extract learnings from the content. Return ONLY valid JSON array of strings.",
                    model
                  );
                  const newLearnings: string[] = safeJsonParse(analysisResult.content, []);
                  learnings = [...learnings, ...newLearnings];
                }
              } catch (err: any) {
                console.warn(`Failed to process query "${searchQuery}":`, err.message);
              }
            }
          }

          // Generate final report
          const reportPrompt = `Based on the following research goal and learnings, compile a comprehensive markdown report.

Research Goal: ${researchGoal.query}
Learnings: ${learnings.join("\n- ") || "No learnings found."}
Sources: ${visitedUrls.join("\n- ") || "No sources found."}

The report should be well-structured, include all sources as references, and be written in a professional tone.`;

          const reportResult = await callProvider(
            provider,
            reportPrompt,
            "Compile a comprehensive markdown research report.",
            model
          );

          return res.json({
            learnings,
            visited_urls: visitedUrls,
            report: reportResult.content,
            usage: reportResult.usage
          });
        }

        default:
          return res.status(400).json({ error: `Unknown research task: ${task}` });
      }
    } catch (error: any) {
      console.error("Research Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // ─── AI Enrichment Routes ─────────────────────────────────────────────────
  // Downstream enrichment only — no scraping, no direct DB writes.
  // All AI outputs are returned to the caller; persistence is optional/client-driven.
  // Default provider for classification tasks: groq (fast, cheap).
  // Default provider for writing/translation tasks: mistral (better text quality).

  // 1. Category classification
  apiRouter.post('/ai/classify', requireModerator, async (req, res) => {
    const { provider = 'groq', company } = req.body;
    if (!company) return res.status(400).json({ error: 'company is required.' });
    if (process.env.AI_DISABLED === 'true') return res.json({ status: 'ai_disabled', message: 'AI enrichment is disabled.' });
    try {
      const result = await ai_classifyCompany(company, provider);
      res.json(result);
    } catch (err: any) {
      console.error('[ai/classify]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // 2. Service/product normalization + taxonomy mapping
  apiRouter.post('/ai/normalize', requireModerator, async (req, res) => {
    const { provider = 'groq', company } = req.body;
    if (!company) return res.status(400).json({ error: 'company is required.' });
    if (process.env.AI_DISABLED === 'true') return res.json({ status: 'ai_disabled', message: 'AI enrichment is disabled.' });
    try {
      const result = await ai_normalizeCompany(company, provider);
      res.json(result);
    } catch (err: any) {
      console.error('[ai/normalize]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // 3. Authorized brand detection
  apiRouter.post('/ai/brands', requireModerator, async (req, res) => {
    const { provider = 'groq', company } = req.body;
    if (!company) return res.status(400).json({ error: 'company is required.' });
    if (process.env.AI_DISABLED === 'true') return res.json({ status: 'ai_disabled', message: 'AI enrichment is disabled.' });
    try {
      const result = await ai_detectBrands(company, provider);
      res.json(result);
    } catch (err: any) {
      console.error('[ai/brands]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // 4. Duplicate candidate ranking (requires explicit candidates list)
  apiRouter.post('/ai/rank-duplicates', requireModerator, async (req, res) => {
    const { provider = 'groq', company, candidates } = req.body;
    if (!company || !Array.isArray(candidates) || !candidates.length) {
      return res.status(400).json({ error: 'company and non-empty candidates array are required.' });
    }
    if (process.env.AI_DISABLED === 'true') return res.json({ status: 'ai_disabled', message: 'AI enrichment is disabled.' });

    const slim = (c: any) => ({
      id: c.id, name_en: c.name_en, name_ar: c.name_ar,
      website_url: c.website_url, phone: c.phone,
      email: c.email, city_id: c.city_id, linkedin_url: c.linkedin_url,
    });

    const prompt = `You are a duplicate company detection system for a Saudi B2B directory.

Source company:
${JSON.stringify(slim(company), null, 2)}

Candidate duplicates to rank (from most to least likely duplicate):
${JSON.stringify(candidates.map(slim), null, 2)}

For each candidate assess: same domain, similar name (Arabic/English variants),
same phone, same LinkedIn. Rank from highest to lowest match_score.

Return JSON:
{
  "rankings": [
    {
      "candidate_id": "company_id",
      "match_score": 0.95,
      "reasons": ["Same domain", "Same phone number"],
      "recommended_action": "merge"
    }
  ]
}
recommended_action must be one of: merge | review | dismiss`;

    try {
      const config = getProvider(provider as AIProvider);
      const result = await callProvider(provider, prompt, "Rank duplicate candidates as JSON.", config?.discoveryModel);
      res.json(safeJsonParse(result.content, { rankings: [] }));
    } catch (err: any) {
      console.error('[ai/rank-duplicates]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // 5. Profile description improvement (uses mistral by default for bilingual quality)
  apiRouter.post('/ai/improve-profile', requireModerator, async (req, res) => {
    const { provider = 'mistral', company } = req.body;
    if (!company) return res.status(400).json({ error: 'company is required.' });
    if (process.env.AI_DISABLED === 'true') return res.json({ status: 'ai_disabled', message: 'AI enrichment is disabled.' });
    try {
      const result = await ai_improveProfile(company, provider);
      res.json(result);
    } catch (err: any) {
      console.error('[ai/improve-profile]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // 6. Missing field suggestions (non-critical fields only)
  apiRouter.post('/ai/suggest-fields', requireModerator, async (req, res) => {
    const { provider = 'groq', company } = req.body;
    if (!company) return res.status(400).json({ error: 'company is required.' });
    if (process.env.AI_DISABLED === 'true') return res.json({ status: 'ai_disabled', message: 'AI enrichment is disabled.' });
    try {
      const result = await ai_suggestMissingFields(company, provider);
      res.json(result);
    } catch (err: any) {
      console.error('[ai/suggest-fields]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // 7. Profile completeness scoring (deterministic — no AI call needed)
  apiRouter.post('/ai/score-completeness', requireModerator, (req, res) => {
    const { company } = req.body;
    if (!company) return res.status(400).json({ error: 'company is required.' });
    res.json(ai_scoreCompleteness(company));
  });

  // 8. Evidence summarization for admin reviewers
  apiRouter.post('/ai/summarize-evidence', requireModerator, async (req, res) => {
    const { provider = 'groq', company, summary_type = 'general' } = req.body;
    if (!company) return res.status(400).json({ error: 'company is required.' });
    if (process.env.AI_DISABLED === 'true') return res.json({ status: 'ai_disabled', message: 'AI enrichment is disabled.' });
    try {
      const result = await ai_summarizeEvidence(company, summary_type, provider);
      res.json(result);
    } catch (err: any) {
      console.error('[ai/summarize-evidence]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // 9. Company merging
  apiRouter.post('/ai/merge', requireAdmin, async (req, res) => {
    const { provider = 'groq', master, duplicate } = req.body;
    if (!master || !duplicate) return res.status(400).json({ error: 'Both master and duplicate companies are required.' });
    if (process.env.AI_DISABLED === 'true') {
      return res.status(400).json({ error: 'AI merging is disabled.' });
    }
    try {
      const result = await ai_mergeCompanies(master, duplicate, provider);
      res.json(result);
    } catch (err: any) {
      console.error('[ai/merge]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // 10. Run-all batch: executes the top-5 priority enrichment jobs for one company.
  //    classify, normalize, brands, suggest-fields, score-completeness run in parallel.
  //    improve-profile runs only when explicitly requested (costs more tokens).
  apiRouter.post('/ai/run-all', requireModerator, async (req, res) => {
    const {
      provider = 'groq',
      company,
      jobs = ['classify', 'normalize', 'brands', 'suggest-fields', 'score-completeness'],
    } = req.body;

    if (!company) return res.status(400).json({ error: 'company is required.' });
    if (process.env.AI_DISABLED === 'true') return res.json({ status: 'ai_disabled', message: 'AI enrichment is disabled.', company_id: company.id, results: {}, errors: {}, jobs_run: [] });

    const VALID_JOBS = new Set([
      'classify', 'normalize', 'brands',
      'suggest-fields', 'score-completeness', 'improve-profile', 'summarize-evidence',
    ]);

    const results: Record<string, any> = {};
    const errors: Record<string, string> = {};

    const runJob = async (job: string) => {
      if (!VALID_JOBS.has(job)) return;
      try {
        switch (job) {
          case 'classify': results.classify = await ai_classifyCompany(company, provider); break;
          case 'normalize': results.normalize = await ai_normalizeCompany(company, provider); break;
          case 'brands': results.brands = await ai_detectBrands(company, provider); break;
          case 'suggest-fields': results.suggest_fields = await ai_suggestMissingFields(company, provider); break;
          case 'score-completeness': results.score_completeness = ai_scoreCompleteness(company); break;
          case 'improve-profile': results.improve_profile = await ai_improveProfile(company, provider); break;
          case 'summarize-evidence': results.summarize_evidence = await ai_summarizeEvidence(company, 'general', provider); break;
        }
      } catch (err: any) {
        errors[job] = err.message;
      }
    };

    const requested = (Array.isArray(jobs) ? jobs : []).filter((j: string) => VALID_JOBS.has(j));
    await Promise.all(requested.map(runJob));

    res.json({ company_id: company.id, results, errors, jobs_run: requested });
  });

  // Mount the router at /api
  app.use("/api", apiRouter);
}

async function startServer() {
  const PORT = Number(process.env.PORT || 3000);

  // 1. Setup API routes
  setupApiRoutes(app);

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🚀 Server running at http://localhost:${PORT}`);
    console.log(`📡 Deployment: ${process.env.VERCEL === '1' ? 'Vercel' : 'Local'}`);
    console.log(`🔥 Environment: ${process.env.NODE_ENV || 'development'}\n`);
  });
}

// Only start the server locally (not in Vercel)
if (process.env.VERCEL !== "1") {
  startServer();
}

export default app;
