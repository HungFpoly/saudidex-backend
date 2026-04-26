import { CATEGORIES } from '@/lib/data';
import { Company } from '@/types';

type DiscoveryCompanyLike = Partial<Company> & {
  address?: string;
  /** Legacy AI field — not a DB column; stripped before save */
  city?: string;
};

const FALLBACK_CITY_ID = '1';
const FALLBACK_REGION_ID = '1';
const FALLBACK_ADDRESS = 'Saudi Arabia';

export const mapCategoryIds = (categories: string[] = []) => {
  return categories
    .map((category) => category?.trim())
    .filter(Boolean)
    .map((category) => {
      const matchById = CATEGORIES.find((entry) => entry.id === category);
      if (matchById) {
        return matchById.id;
      }

      const normalized = category.toLowerCase();
      const matchByName = CATEGORIES.find(
        (entry) =>
          entry.name_en.toLowerCase() === normalized || entry.name_ar === category,
      );

      return matchByName?.id ?? category;
    });
};

export const createCompanySlug = (name: string) => {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')  // Strip everything except alphanumeric and hyphens
    .replace(/-+/g, '-')          // Collapse multiple hyphens
    .replace(/^-|-$/g, '');       // Remove leading/trailing hyphens
};

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate a company record before saving to Firestore.
 * Checks required fields, email format, URL format, phone format.
 * Returns { valid, errors, warnings } — errors block save, warnings are informational.
 */
export const validateCompanyRecord = (company: Partial<Company>): ValidationResult => {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Required fields
  if (!company.name_en?.trim()) errors.push('name_en is required');
  if (!company.slug?.trim()) errors.push('slug is required');
  if (!company.business_type) errors.push('business_type is required');

  // Email format validation (basic)
  const emailFields = [
    { key: 'email', value: company.email },
    { key: 'sales_email', value: company.sales_email },
    { key: 'procurement_email', value: company.procurement_email },
  ];
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  for (const { key, value } of emailFields) {
    if (value && !emailRegex.test(value)) {
      errors.push(`${key} has invalid email format: "${value}"`);
    }
  }

  // URL format validation
  const urlFields = [
    { key: 'website_url', value: company.website_url },
    { key: 'logo_url', value: company.logo_url },
    { key: 'linkedin_url', value: company.linkedin_url },
  ];
  const urlRegex = /^https?:\/\/.+/i;
  for (const { key, value } of urlFields) {
    if (value && !urlRegex.test(value)) {
      errors.push(`${key} has invalid URL format: "${value}"`);
    }
  }

  // LinkedIn URL specific check
  if (company.linkedin_url && !company.linkedin_url.includes('linkedin.com')) {
    warnings.push('linkedin_url does not contain "linkedin.com"');
  }

  // Phone format — allow +, digits, spaces, dashes, parentheses
  if (company.phone) {
    const phoneClean = company.phone.replace(/[\s\-().]/g, '');
    if (!/^\+?\d{7,15}$/.test(phoneClean)) {
      warnings.push(`phone format looks unusual: "${company.phone}"`);
    }
  }

  // Confidence score range
  if (company.confidence_score !== undefined && (company.confidence_score < 0 || company.confidence_score > 1)) {
    warnings.push(`confidence_score out of range: ${company.confidence_score}`);
  }

  // Description length
  if (company.description_en && company.description_en.length < 10) {
    warnings.push('description_en is very short (< 10 chars)');
  }

  // City/region
  if (!company.city_id) warnings.push('city_id is missing, will use default');
  if (!company.region_id) warnings.push('region_id is missing, will use default');

  return { valid: errors.length === 0, errors, warnings };
};

export const normalizeDiscoveredCompany = (
  extractedData: DiscoveryCompanyLike,
  sourceUrl: string,
) => {
  const timestamp = new Date().toISOString();
  const nameEn = extractedData.name_en?.trim() || 'Unknown Company';
  const legacyCityOnly = (extractedData as { city?: string }).city?.trim();
  const fullAddress =
    extractedData.full_address?.trim() ||
    extractedData.address?.trim() ||
    legacyCityOnly ||
    FALLBACK_ADDRESS;

  const { city: _legacyCity, address: _legacyAddress, ...extractedForRow } = extractedData as DiscoveryCompanyLike &
    Record<string, unknown>;

  const provenance = {
    extracted_at: timestamp,
    data_source: extractedData.data_source || 'AI Agent',
    source_url: extractedData.source_url || sourceUrl,
  };

  return {
    ...extractedForRow,
    name_en: nameEn,
    name_ar: extractedData.name_ar?.trim() || nameEn,
    slug: extractedData.slug?.trim() || createCompanySlug(nameEn),
    business_type: extractedData.business_type || 'vendor',
    description_en: extractedData.description_en?.trim() || nameEn,
    description_ar: extractedData.description_ar?.trim() || extractedData.description_en?.trim() || nameEn,
    categories: mapCategoryIds(extractedData.categories),
    brands: extractedData.brands || [],
    products: Array.isArray(extractedData.products)
      ? extractedData.products.filter((p): p is string => typeof p === 'string').map((s) => s.trim()).filter(Boolean)
      : [],
    fields: Array.isArray(extractedData.fields)
      ? extractedData.fields.filter((f): f is string => typeof f === 'string').map((s) => s.trim()).filter(Boolean)
      : [],
    is_verified: false,
    is_featured: false,
    status: (extractedData.status as any) || 'pending',
    data_source: provenance.data_source,
    source_url: provenance.source_url,
    confidence_score: extractedData.confidence_score ?? 0,
    full_address: fullAddress,
    city_id: extractedData.city_id || FALLBACK_CITY_ID,
    region_id: extractedData.region_id || FALLBACK_REGION_ID,
    last_scraped_at: timestamp,
    created_at: extractedData.created_at || timestamp,
    updated_at: timestamp,
    extraction_metadata: {
      extracted_at: timestamp,
      original_data: extractedData as Record<string, unknown>,
      field_confidence: (extractedData as any).field_confidence || {},
    }
  } satisfies Partial<Company>;
};

const ENRICHMENT_FIELDS: Array<keyof Company> = [
  'logo_url',
  'linkedin_url',
  'sales_email',
  'procurement_email',
  'phone',
  'email',
  'full_address',
  'seo_title_en',
  'seo_title_ar',
  'seo_description_en',
  'seo_description_ar',
  'description_en',
  'description_ar',
  'categories',
  'products',
  'fields',
  'instagram_url',
  'twitter_url',
  'facebook_url',
  'cr_number',
  'vat_number',
  'chamber_commerce_id',
  'is_vat_registered',
  'procurement_portal_url',
  'secondary_emails',
  'secondary_phones',
  'secondary_websites',
  'secondary_linkedin',
  'secondary_socials',
  'confidence_score',
];

export const normalizeEnrichmentUpdate = (payload: Record<string, unknown>) => {
  const nextUpdate: Partial<Company> = {};

  for (const field of ENRICHMENT_FIELDS) {
    const value = payload[field];
    if (value === undefined || value === null || value === '') {
      continue;
    }

    if (field === 'categories' && Array.isArray(value)) {
      nextUpdate.categories = mapCategoryIds(value.filter((entry): entry is string => typeof entry === 'string'));
      continue;
    }

    if (field === 'products' && Array.isArray(value)) {
      nextUpdate.products = value.filter((entry): entry is string => typeof entry === 'string');
      continue;
    }

    if (field === 'fields' && Array.isArray(value)) {
      nextUpdate.fields = value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }

    if (field === 'full_address' && typeof value === 'string') {
      nextUpdate.full_address = value.trim();
      continue;
    }

    if (field === 'is_vat_registered') {
      if (value === true || value === false) {
        nextUpdate.is_vat_registered = value;
        continue;
      }
      if (typeof value === 'string') {
        const v = value.trim().toLowerCase();
        if (v === 'true' || v === 'yes' || v === '1') nextUpdate.is_vat_registered = true;
        else if (v === 'false' || v === 'no' || v === '0') nextUpdate.is_vat_registered = false;
        continue;
      }
    }

    // Types are narrowed by the source data and Company field list.
    (nextUpdate as Record<string, unknown>)[field] = value;
  }

  return nextUpdate;
};
