/**
 * Dynamic Sitemap Generator for Saudi B2B Index
 *
 * Usage:
 *   - Development: Run `npm run sitemap` to generate static sitemap.xml
 *   - Production: Import `generateSitemapXml()` and call it in your deploy pipeline
 *   - CI/CD: Runs automatically via `prebuild` script
 *
 * Fetches all verified companies from Supabase and generates sitemap.xml
 * with proper lastmod, changefreq, and priority values.
 */

import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

const BASE_URL = 'https://saudib2b.com';

interface SitemapUrl {
  loc: string;
  lastmod?: string;
  changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
  priority?: number;
}

const STATIC_URLS: SitemapUrl[] = [
  { loc: '/', changefreq: 'daily', priority: 1.0 },
  { loc: '/search', changefreq: 'daily', priority: 0.8 },
  { loc: '/categories', changefreq: 'weekly', priority: 0.7 },
  { loc: '/regions', changefreq: 'weekly', priority: 0.7 },
  { loc: '/submit', changefreq: 'monthly', priority: 0.5 },
  { loc: '/privacy', changefreq: 'yearly', priority: 0.3 }
];

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toXmlDate(timestamp: any): string | undefined {
  if (!timestamp) return undefined;
  try {
    if (timestamp.toDate) {
      return timestamp.toDate().toISOString().split('T')[0];
    }
    if (typeof timestamp === 'string') {
      return timestamp.split('T')[0];
    }
    if (typeof timestamp === 'number') {
      return new Date(timestamp * 1000).toISOString().split('T')[0];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function fetchMarketplaceUrls(): Promise<SitemapUrl[]> {
  const marketplaceUrls: SitemapUrl[] = [];

  // These should ideally be imported, but for CLI consistency we'll use the known ones
  const categories = [
    'industrial-equipment', 'electrical', 'food-manufacturing', 
    'building-materials', 'medical-supplies', 'chemicals', 'automotive'
  ];
  
  const regions = [
    'riyadh-region', 'makkah-region', 'eastern-province'
  ];

  categories.forEach(slug => {
    marketplaceUrls.push({
      loc: `/search?category=${slug}`,
      changefreq: 'daily',
      priority: 0.8
    });
  });

  regions.forEach(slug => {
    marketplaceUrls.push({
      loc: `/search?region=${slug}`,
      changefreq: 'daily',
      priority: 0.7
    });
  });

  return marketplaceUrls;
}

export async function fetchCompanyUrls(): Promise<SitemapUrl[]> {
  const supabaseUrl = process.env.VITE_SUPABASE_URL || '';
  const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY || '';

  if (!supabaseUrl || !supabaseKey) {
    console.warn('[Sitemap] Supabase not configured, returning static URLs only');
    return [];
  }

  const sb = createClient(supabaseUrl, supabaseKey);
  const { data, error } = await sb
    .from('companies')
    .select('id, slug, name_en, updated_at, created_at')
    .eq('status', 'approved'); // Changed from is_verified to any approved company

  if (error) {
    console.error('[Sitemap] Error fetching companies:', error);
    return [];
  }

  const companyUrls = (data || []).map(company => {
    const slug = company.slug || company.name_en?.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || company.id;
    const lastmod = toXmlDate(company.updated_at || company.created_at);

    return {
      loc: `/company/${company.id}/${slug}`,
      lastmod,
      changefreq: 'weekly' as const,
      priority: 0.6
    };
  });

  const marketplaceUrls = await fetchMarketplaceUrls();
  return [...marketplaceUrls, ...companyUrls];
}

export function generateSitemapXml(urls: SitemapUrl[]): string {
  const urlEntries = urls.map(url => {
    let xml = `  <url>\n    <loc>${escapeXml(url.loc.startsWith('http') ? url.loc : `${BASE_URL}${url.loc}`)}</loc>`;
    if (url.lastmod) xml += `\n    <lastmod>${url.lastmod}</lastmod>`;
    if (url.changefreq) xml += `\n    <changefreq>${url.changefreq}</changefreq>`;
    if (url.priority !== undefined) xml += `\n    <priority>${url.priority}</priority>`;
    xml += '\n  </url>';
    return xml;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urlEntries}
</urlset>`;
}

export async function generateSitemap(): Promise<string> {
  try {
    const companyUrls = await fetchCompanyUrls();
    const allUrls = [...STATIC_URLS, ...companyUrls];
    return generateSitemapXml(allUrls);
  } catch (error) {
    console.error('Failed to generate sitemap, falling back to static URLs:', error);
    return generateSitemapXml(STATIC_URLS);
  }
}

// CLI mode: generate and write sitemap.xml
if (process.argv[1]?.endsWith('generate-sitemap.ts')) {
  (async () => {
    console.log('Generating sitemap...');
    const xml = await generateSitemap();
    const outputPath = resolve(process.cwd(), 'public', 'sitemap.xml');
    writeFileSync(outputPath, xml, 'utf-8');
    console.log(`Sitemap written to ${outputPath}`);
    console.log(`  URLs included: ${(xml.match(/<loc>/g) || []).length}`);
    process.exit(0);
  })();
}
