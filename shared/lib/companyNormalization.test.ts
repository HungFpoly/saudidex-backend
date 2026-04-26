import { describe, expect, it } from 'vitest';

import {
  createCompanySlug,
  mapCategoryIds,
  normalizeDiscoveredCompany,
  normalizeEnrichmentUpdate,
} from './companyNormalization';

describe('company normalization', () => {
  it('maps category labels to known IDs', () => {
    expect(mapCategoryIds(['Electrical', '4', 'Unknown Category'])).toEqual([
      '2',
      '4',
      'Unknown Category',
    ]);
  });

  it('creates stable slugs', () => {
    expect(createCompanySlug('Controls & Electrics Arabia Ltd.')).toBe(
      'controls-electrics-arabia-ltd',
    );
  });

  it('normalizes discovered companies with required defaults', () => {
    const normalized = normalizeDiscoveredCompany(
      {
        name_en: 'Example Co',
        categories: ['Electrical'],
      },
      'https://saudidex.vercel.app',
    );

    expect(normalized.slug).toBe('example-co');
    expect(normalized.categories).toEqual(['2']);
    expect(normalized.status).toBe('pending');
    expect(normalized.full_address).toBe('Saudi Arabia');
    expect(normalized.city_id).toBe('1');
    expect(normalized).not.toHaveProperty('city');
  });

  it('maps legacy AI city into full_address but does not persist city on the row', () => {
    const normalized = normalizeDiscoveredCompany(
      {
        name_en: 'Legacy Co',
        city: 'Riyadh',
      },
      'https://example.com',
    );

    expect(normalized.full_address).toBe('Riyadh');
    expect(normalized).not.toHaveProperty('city');
  });

  it('keeps only safe enrichment fields and normalizes arrays', () => {
    const normalized = normalizeEnrichmentUpdate({
      categories: ['Electrical'],
      products: ['Panels', 123],
      logo_url: 'https://saudidex.vercel.app/logo.png',
      unsupported: 'ignore-me',
    });

    expect(normalized).toEqual({
      categories: ['2'],
      products: ['Panels'],
      logo_url: 'https://saudidex.vercel.app/logo.png',
    });
  });

  it('coerces is_vat_registered from Gemini string', () => {
    expect(
      normalizeEnrichmentUpdate({
        is_vat_registered: 'true',
        cr_number: '1010123456',
      }),
    ).toEqual({ is_vat_registered: true, cr_number: '1010123456' });
  });

  it('normalizes industry fields from enrichment', () => {
    expect(
      normalizeEnrichmentUpdate({
        fields: ['  Steel  ', 'Electrical', 99],
      }),
    ).toEqual({ fields: ['Steel', 'Electrical'] });
  });
});
