/**
 * Saudidex Discovery Pipeline - Complete Module System
 *
 * Barrel export for all pipeline modules.
 * Import from this file to access the complete discovery pipeline.
 */

// Seed Management
export { SeedManager } from '../seedManager';
export type { SeedEntry, SeedSourceType, SeedStatus, SeedConfig } from '../seedManager';

// Crawl Queue / Scheduler
export { CrawlQueue, processQueue } from '../crawlQueue';
export type { CrawlTask, QueueName, QueuePriority, QueueConfig } from '../crawlQueue';

// Website Resolver
export { resolveWebsite, isLikelyParkedDomain, resolveWebsites, filterValidWebsites } from '../websiteResolver';
export type { WebsiteResolution } from '../websiteResolver';

// Site Crawler (Focused)
export { fetchPage, focusedCrawl, extractFromCrawledPages } from '../siteCrawler';
export type { CrawledPage, CrawlConfig } from '../siteCrawler';

// URL Canonicalizer
export {
  canonicalizeUrl,
  normalizeUrl,
  resolveUrl as resolveUrlUtil,
  extractDomain,
  urlsMatch,
  deduplicateUrls,
  cleanUrlForMatching,
  isValidUrl,
  parseUrl
} from '../urlCanonicalizer';

// Page Classifier
export {
  classifyPage,
  prioritizePages,
  getEnrichmentPageOrder
} from '../pageClassifier';
export type { PageType, ClassifiedPage } from '../pageClassifier';

// Robots Policy
export {
  canFetch as canFetchRobots,
  getCrawlDelay as getRobotsCrawlDelay,
  clearRobotsCache,
  clearRobotsCacheForDomain,
  getRobotsCacheStats,
  warmRobotsCache,
} from '../robotsPolicy';

// Rate Limiter
export {
  withRateLimit,
  setDomainDelay,
  setRobotsCrawlDelay,
  getDomainDelay,
  getRateLimiterStats,
  resetRateLimiter,
  calculateBackoff,
  extractDomainFromUrl,
  initRateLimiter,
} from '../rateLimiter';
export type { RateLimitConfig } from '../rateLimiter';

// Field Extractors
export {
  extractDescription,
  extractEmails,
  extractPhones,
  extractSocialLinks,
  extractAddress,
  extractCompanyName,
  extractLogoUrl,
  extractTeam
} from '../extractors';
export type { ExtractedField } from '../extractors';

// Normalizer
export {
  normalizeCompanyName,
  normalizePhone,
  normalizeEmail,
  normalizeCity,
  normalizeCountry,
  cleanText,
  removeJunkValues,
  normalizeCompanyRecord
} from '../normalizer';

// Deduplication
export {
  stringSimilarity,
  isSameCompanyName,
  detectDuplicates,
  mergeCompanies
} from '../deduper';

// Observability
export {
  metricsCollector,
  incrementCounter,
  getCounter,
  resetCounter,
  setGauge,
  getGauge,
  recordHistogram,
  getHistogramStats,
  recordAdapterParse,
  recordFetch,
  recordQueueEvent,
  recordFieldExtract,
  recordAIEnrichment,
  recordValidation,
  getAdapterStats,
  getSystemMetrics,
  getRecentMetrics,
  resetAllMetrics,
} from '../observability';
export type { MetricPoint } from '../observability';

// Export Layer
export {
  exportToJson,
  exportToCsv,
  exportToApiPayload,
  exportCompanies,
  downloadExport
} from '../exporter';
export type { ExportFormat, ExportOptions } from '../exporter';

// Directory Parser Adapters
export { parserRegistry, BaseDirectoryParser } from '../adapters/DirectoryParserAdapter';
export type { DirectoryParserAdapter, ParsedCompany, ParseResult } from '../adapters/DirectoryParserAdapter';

// Pipeline barrel exports - importing all pipeline modules
export { queueManager } from '../queueManager';
export { validator } from '../validator';
export { canFetch, getCrawlDelay } from '../robotsPolicy';
export { waitForSlot, releaseSlot } from '../rateLimiter';
export { searchIndexer } from '../searchIndexer';
export { entityResolver } from '../entityResolver';

// Export types
export type { CrawlJob, QueueType, JobStatus } from '../queueManager';
export type { ValidationResult, CompanyData } from '../validator';
export type { QueueStats } from '../queueManager';
