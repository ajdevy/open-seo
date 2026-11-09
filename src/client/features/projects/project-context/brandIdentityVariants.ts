import {
  BRAND_IDENTITY_VARIANTS_SLUG,
  parseBrandIdentityVariants,
} from "@/shared/project-context/brandIdentityVariants";

export {
  BRAND_IDENTITY_VARIANTS_SLUG,
  mentionedBrandIdentityVariants,
  parseBrandIdentityVariants,
  projectBrandIdentityVariants,
} from "@/shared/project-context/brandIdentityVariants";

export const BRAND_IDENTITY_VARIANTS_TITLE = "Brand identity variants";

export function brandIdentityVariantUpdates(content: string, exists: boolean) {
  const variants = parseBrandIdentityVariants(content);
  if (variants.length) {
    return [
      {
        customSection: BRAND_IDENTITY_VARIANTS_SLUG,
        title: BRAND_IDENTITY_VARIANTS_TITLE,
        content: variants.join("\n"),
      },
    ];
  }
  return exists ? [{ deleteCustomSection: BRAND_IDENTITY_VARIANTS_SLUG }] : [];
}
