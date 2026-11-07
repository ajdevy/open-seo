import { describe, expect, it, vi } from "vitest";
import {
  BRAND_IDENTITY_VARIANTS_SLUG,
  brandIdentityVariantUpdates,
  mentionedBrandIdentityVariants,
  parseBrandIdentityVariants,
  projectBrandIdentityVariants,
} from "./brandIdentityVariants";
import { projectContextQueryKey } from "./shared";

vi.mock("@/serverFunctions/projectContext", () => ({
  getProjectContext: vi.fn(),
  updateProjectContext: vi.fn(),
}));

describe("project brand identity variants", () => {
  it("parses one normalized, de-duplicated identity per line", () => {
    expect(
      parseBrandIdentityVariants(" Acme Cloud \n\nACME CLOUD\nAcme.io "),
    ).toEqual(["Acme Cloud", "Acme.io"]);
  });

  it("reads variants only from the project's dedicated context section", () => {
    expect(
      projectBrandIdentityVariants([
        { slug: "positioning", content: "Acme is different" },
        {
          slug: BRAND_IDENTITY_VARIANTS_SLUG,
          content: "Acme Cloud\nAcme.io",
        },
      ]),
    ).toEqual(["Acme Cloud", "Acme.io"]);
    expect(projectContextQueryKey("project-a")).not.toEqual(
      projectContextQueryKey("project-b"),
    );
  });

  it("saves a normalized project-context section and deletes it when cleared", () => {
    expect(
      brandIdentityVariantUpdates(" Acme Cloud \nACME CLOUD", false),
    ).toEqual([
      {
        customSection: BRAND_IDENTITY_VARIANTS_SLUG,
        title: "Brand identity variants",
        content: "Acme Cloud",
      },
    ]);
    expect(brandIdentityVariantUpdates("", true)).toEqual([
      { deleteCustomSection: BRAND_IDENTITY_VARIANTS_SLUG },
    ]);
    expect(brandIdentityVariantUpdates("", false)).toEqual([]);
  });

  it("matches saved variants in answer text as whole phrases", () => {
    expect(
      mentionedBrandIdentityVariants(
        "Acme-Cloud was mentioned. AcmeCloudy was not.",
        ["Acme Cloud", "AcmeCloud"],
      ),
    ).toEqual(["Acme Cloud"]);
  });
});
