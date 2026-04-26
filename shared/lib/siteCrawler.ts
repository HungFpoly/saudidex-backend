/**
 * Site Crawler (Focused)
 *
 * Responsible for:
 * - Opening homepage
 * - Extracting internal links
 * - Following only relevant pages (About, Contact, Team, Services)
 * - Limiting crawl depth
 * - Focused crawling, not full-site
 *
 * Page priority order:
 * 1. Homepage
 * 2. About
 * 3. Contact
 * 4. Team / Leadership
 * 5. Services / Solutions
 * 6. Careers
 * 7. Footer links
 */

import * as cheerio from 'cheerio';
import { canonicalizeUrl, extractDomain, isValidUrl } from './urlCanonicalizer';
import { classifyPage, PageType } from './pageClassifier';

export interface CrawledPage {
  url: string;
  pageType: PageType;
  html: string;
  markdown: string;
  title: string;
  links: string[];
  depth: number;
  fetchTime: number;
  error?: string;
}

export interface CrawlConfig {
  maxPages?: number;
  maxDepth?: number;
  timeout?: number;
  followTypes?: PageType[]; // Which page types to follow
  userAgent?: string;
}

const DEFAULT_CONFIG: CrawlConfig = {
  maxPages: 10,
  maxDepth: 2,
  timeout: 15000,
  followTypes: ['homepage', 'about', 'contact', 'team', 'products', 'services'],
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
};

/**
 * Fetch a single page and return CrawledPage.
 */
export async function fetchPage(url: string, config: CrawlConfig = {}): Promise<CrawledPage | null> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const start = Date.now();

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': cfg.userAgent || DEFAULT_CONFIG.userAgent! },
      signal: AbortSignal.timeout(cfg.timeout || 15000)
    });

    if (!response.ok) {
      return {
        url,
        pageType: 'other',
        html: '',
        markdown: '',
        title: '',
        links: [],
        depth: 0,
        fetchTime: Date.now() - start,
        error: `HTTP ${response.status}`
      };
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Extract title
    const title = $('title').text().trim();

    // Convert to markdown
    const turndown = await import('turndown').then(m => m.default);
    const td = new turndown();
    td.remove(['script', 'style', 'nav', 'footer', 'header', 'iframe', 'noscript', 'svg']);
    const body = $('body').html() || '';
    const markdown = td.turndown(body);

    // Extract internal links
    const domain = extractDomain(url);
    const links: string[] = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (href) {
        try {
          const resolved = new URL(href, url).href;
          if (extractDomain(resolved) === domain) {
            links.push(resolved);
          }
        } catch {
          // Skip invalid URLs
        }
      }
    });

    // Classify page type
    const pageType = classifyPage(url, url).pageType;

    return {
      url,
      pageType,
      html,
      markdown: markdown.slice(0, 30000),
      title,
      links: [...new Set(links)],
      depth: 0,
      fetchTime: Date.now() - start
    };
  } catch (error: any) {
    return {
      url,
      pageType: 'other',
      html: '',
      markdown: '',
      title: '',
      links: [],
      depth: 0,
      fetchTime: Date.now() - start,
      error: error.message
    };
  }
}

/**
 * Focused crawl of a company website.
 * Follows only relevant pages (About, Contact, Team, etc.) up to maxPages.
 * Returns crawled pages in priority order.
 */
export async function focusedCrawl(
  homepageUrl: string,
  config: CrawlConfig = {}
): Promise<CrawledPage[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const pages: CrawledPage[] = [];
  const visited = new Set<string>();
  const domain = extractDomain(homepageUrl);

  if (!domain) return pages;

  // Fetch homepage first
  const homePage = await fetchPage(homepageUrl, cfg);
  if (!homePage || homePage.error) {
    if (homePage) pages.push(homePage);
    return pages;
  }

  visited.add(homePage.url);
  homePage.pageType = 'homepage';
  pages.push(homePage);

  // Build priority queue from homepage links
  const followTypes = cfg.followTypes || DEFAULT_CONFIG.followTypes!;
  const priorityUrls: string[] = [];

  // Classify all links and sort by priority
  const classifiedLinks = homePage.links
    .map(url => ({ url, ...classifyPage(url, homepageUrl) }))
    .filter(c => followTypes.includes(c.pageType))
    .sort((a, b) => {
      const order: Record<PageType, number> = {
        homepage: 0, contact: 1, about: 2, team: 3,
        products: 4, services: 5, faq: 6, careers: 7,
        news: 8, blog: 9, legal: 10, other: 11
      };
      return (order[a.pageType] || 11) - (order[b.pageType] || 11);
    });

  // Follow links in priority order
  for (const link of classifiedLinks) {
    if (pages.length >= (cfg.maxPages || 10)) break;
    if (visited.has(link.url)) continue;

    visited.add(link.url);

    const page = await fetchPage(link.url, cfg);
    if (page && !page.error) {
      page.depth = 1;
      pages.push(page);
    }
  }

  return pages;
}

/**
 * Extract company information from crawled pages.
 * Combines data from homepage, about, contact pages.
 */
export function extractFromCrawledPages(pages: CrawledPage[]): {
  description?: string;
  phone?: string;
  email?: string;
  address?: string;
  socialLinks: Record<string, string>;
  teamMembers: string[];
  products: string[];
} {
  const result = {
    description: undefined as string | undefined,
    phone: undefined as string | undefined,
    email: undefined as string | undefined,
    address: undefined as string | undefined,
    socialLinks: {} as Record<string, string>,
    teamMembers: [] as string[],
    products: [] as string[]
  };

  for (const page of pages) {
    if (!page.html) continue;

    const $ = cheerio.load(page.html);
    const text = $('body').text().toLowerCase();

    // Extract from contact pages (highest priority for contact info)
    if (page.pageType === 'contact') {
      const phoneMatch = text.match(/(\+?[\d\s\-()]{7,15})/);
      if (phoneMatch && !result.phone) result.phone = phoneMatch[1].trim();

      const emailMatch = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (emailMatch && !result.email) result.email = emailMatch[1];

      const addressMatch = $('address').first().text().trim();
      if (addressMatch && !result.address) result.address = addressMatch;
    }

    // Extract from about pages
    if (page.pageType === 'about' && !result.description) {
      const desc = $('p').first().text().trim();
      if (desc.length > 20 && desc.length < 500) {
        result.description = desc;
      }
    }

    // Extract social links from all pages
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (href.includes('linkedin.com') && !result.socialLinks.linkedin) {
        result.socialLinks.linkedin = href;
      } else if (href.includes('twitter.com') && !result.socialLinks.twitter) {
        result.socialLinks.twitter = href;
      } else if (href.includes('facebook.com') && !result.socialLinks.facebook) {
        result.socialLinks.facebook = href;
      }
    });

    // Extract team members from team pages
    if (page.pageType === 'team') {
      $('h1, h2, h3, h4').each((_, el) => {
        const name = $(el).text().trim();
        if (name.length > 3 && name.length < 50 && /^[A-ZÀ-Ýa-zà-ý\s]+$/.test(name)) {
          result.teamMembers.push(name);
        }
      });
    }

    // Extract products/services
    if (page.pageType === 'products' || page.pageType === 'services') {
      $('h1, h2, h3, h4, li, .product-name, .service-name').each((_, el) => {
        const text = $(el).text().trim();
        if (text.length > 2 && text.length < 100) {
          result.products.push(text);
        }
      });
    }
  }

  return result;
}
