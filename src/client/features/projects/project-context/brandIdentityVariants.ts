export const BRAND_IDENTITY_VARIANTS_SLUG = "brand-identity-variants";
export const BRAND_IDENTITY_VARIANTS_TITLE = "Brand identity variants";

/** Each line is one alternate name, acronym, or spelling for this project. */
export function parseBrandIdentityVariants(content: string): string[] {
  const seen = new Set<string>();
  return content
    .split(/\r?\n/)
    .map((variant) => variant.trim())
    .filter((variant) => {
      if (!variant) return false;
      const key = variant.normalize("NFKC").toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function projectBrandIdentityVariants(
  customSections: readonly { slug: string; content: string }[],
) {
  return parseBrandIdentityVariants(
    customSections.find(
      (section) => section.slug === BRAND_IDENTITY_VARIANTS_SLUG,
    )?.content ?? "",
  );
}

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

/** Match a saved identity as a phrase, without accepting a longer word around it. */
export function mentionedBrandIdentityVariants(
  answer: string | null | undefined,
  variants: readonly string[],
) {
  if (!answer) return [];
  const normalizedAnswer = answer.normalize("NFKC");
  return variants.filter((variant) => {
    const words = variant.trim().split(/\s+/).filter(Boolean).map(escapeRegExp);
    if (!words.length) return false;
    const phrase = words.join("[^\\p{L}\\p{N}]+");
    return new RegExp(
      `(^|[^\\p{L}\\p{N}])(${phrase})(?=$|[^\\p{L}\\p{N}])`,
      "iu",
    ).test(normalizedAnswer);
  });
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
