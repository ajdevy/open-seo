import { useState } from "react";
import { Button } from "@/client/components/ui/button";
import { SectionHeader } from "@/client/components/PageHeader";
import { Textarea } from "@/client/components/ui/textarea";
import { PROSE_MAX_CHARS } from "@/types/schemas/projectContext";
import { useContextUpdate } from "./shared";
import {
  BRAND_IDENTITY_VARIANTS_TITLE,
  brandIdentityVariantUpdates,
  parseBrandIdentityVariants,
} from "./brandIdentityVariants";

export function BrandIdentityVariantsSection({
  projectId,
  initialContent,
}: {
  projectId: string;
  initialContent: string;
}) {
  const update = useContextUpdate(projectId);
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? initialContent;
  const savedContent = parseBrandIdentityVariants(initialContent).join("\n");
  const variants = parseBrandIdentityVariants(value);
  const content = variants.join("\n");
  const changed = content !== savedContent;

  return (
    <section className="space-y-3">
      <SectionHeader
        title={BRAND_IDENTITY_VARIANTS_TITLE}
        hint="Other names, acronyms, and spellings customers may use for this brand."
      />
      <p className="text-sm text-muted-foreground">
        Add one variant per line. They appear with this project’s own brand in
        its AI visibility report and answer evidence.
      </p>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!changed || update.isPending) return;
          const updates = brandIdentityVariantUpdates(
            content,
            Boolean(initialContent.trim()),
          );
          if (!updates.length) return;
          update.mutate(updates, {
            onSuccess: () => setDraft(null),
          });
        }}
      >
        <Textarea
          aria-label="Brand identity variants"
          rows={4}
          maxLength={PROSE_MAX_CHARS}
          placeholder={"Acme Cloud\nAcme.io\nFormer brand name"}
          value={value}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            size="sm"
            disabled={!changed || update.isPending}
          >
            {update.isPending ? "Saving…" : "Save variants"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!changed || update.isPending}
            onClick={() => setDraft(null)}
          >
            Cancel
          </Button>
        </div>
      </form>
    </section>
  );
}
