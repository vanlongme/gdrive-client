import { z } from 'zod';
import { IsoTimestampSchema } from './common';

// Site branding (wave 8, Phase B1): the operator-facing identity served by
// GET /api/v1/site — anonymous, and available before setup completes so the
// setup/login shells can brand themselves. Never carries credential fields;
// the logo is only ever referenced by its cache-busted URL.

export const SITE_LOCALES = ['vi', 'en'] as const;
export const SiteLocaleSchema = z.enum(SITE_LOCALES);
export type SiteLocale = z.infer<typeof SiteLocaleSchema>;

export const SiteBrandingViewSchema = z
  .object({
    title: z.string().min(1).max(40),
    tagline: z.string().max(80),
    welcome: z.string().max(160),
    supportEmail: z.string().email().nullable(),
    defaultLocale: SiteLocaleSchema,
    /** '/api/v1/site/logo?v=<logo_version>' while a logo is stored. */
    logoUrl: z.string().min(1).nullable(),
  })
  .strict();
export type SiteBrandingView = z.infer<typeof SiteBrandingViewSchema>;

export const SiteBrandingResponseSchema = z
  .object({ site: SiteBrandingViewSchema })
  .strict();
export type SiteBrandingResponse = z.infer<typeof SiteBrandingResponseSchema>;

// PUT /api/v1/admin/site body (admin). title is trimmed before the 1..40
// bound; supportEmail is nullable to clear the field.
export const UpdateSiteBrandingRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(40),
    tagline: z.string().max(80),
    welcome: z.string().max(160),
    supportEmail: z.string().email().max(320).nullable(),
    defaultLocale: SiteLocaleSchema,
  })
  .strict();
export type UpdateSiteBrandingRequest = z.infer<
  typeof UpdateSiteBrandingRequestSchema
>;

// Audit-facing fields emitted next to the view on write operations; kept for
// worker C's admin UI and future diagnostics.
export const SiteBrandingAuditSchema = z
  .object({
    updatedAt: IsoTimestampSchema,
    updatedBy: z.string().min(1).nullable(),
  })
  .strict();
export type SiteBrandingAudit = z.infer<typeof SiteBrandingAuditSchema>;
