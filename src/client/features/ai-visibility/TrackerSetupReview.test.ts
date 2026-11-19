import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "@/client/components/ui/button";
import {
  TrackerSetupReview,
  type TrackerSetupReviewData,
} from "./TrackerSetupReview";

// The component's shared UI module imports server functions with Workers-only bindings.
vi.mock("cloudflare:workers", () => ({ env: {} }));

type ElementProps = {
  children?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
};

function elements(node: ReactNode): ReactElement<ElementProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<ElementProps>(node)) return [];
  return [node, ...elements(node.props.children)];
}

const review: TrackerSetupReviewData = {
  patch: {},
  estimate: {
    promptCount: 1,
    engineCount: 1,
    observations: 1,
    providerCostUsd: 0,
    providerCostBounded: true,
    runNowProviderCostUsd: 0,
    costUsd: 0,
    costCredits: 0,
    runNowCostUsd: 0,
    runNowCostCredits: 0,
    scheduleInterval: "weekly",
    checksPerMonth: 4,
    monthlyCostUsd: 0,
    weeklyProviderBudgetUsd: 8,
    weeklyProviderBudgetAccountedUsd: 0,
    weeklyProviderBudgetHeldUsd: 0,
    weeklyProviderBudgetAvailableUsd: 8,
    weeklyProviderBudgetGlobalAvailableUsd: 8,
    weeklyProjectProviderBudgetUsd: 8,
    weeklyProjectProviderBudgetAccountedUsd: 0,
    weeklyProjectProviderBudgetHeldUsd: 0,
    weeklyProjectProviderBudgetAvailableUsd: 8,
    runNowProviderBudgetRemainingUsd: 8,
    weeklyProviderBudgetScope: "installation",
    weeklyProviderBudgetWindowDays: 7,
    currency: "USD",
    warnings: [],
  },
};

describe("TrackerSetupReview", () => {
  it("routes a new tracker's weekly action through the schedule save", () => {
    const onSave = vi.fn();
    const onSaveAndSchedule = vi.fn();
    const tree = TrackerSetupReview({
      review,
      enabled: false,
      creating: true,
      pending: false,
      error: null,
      canSchedule: true,
      scheduling: false,
      onBack: vi.fn(),
      onSave,
      onSaveAndSchedule,
    });
    const button = elements(tree).find(
      (element) =>
        element.type === Button && element.props.onClick === onSaveAndSchedule,
    );

    expect(button).toBeDefined();
    button?.props.onClick?.();

    expect(onSaveAndSchedule).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("does not enable a new weekly tracker without provider access or prompts", () => {
    const onSaveAndSchedule = vi.fn();
    const tree = TrackerSetupReview({
      review: { ...review, estimate: { ...review.estimate, observations: 0 } },
      enabled: false,
      creating: true,
      pending: false,
      error: null,
      canSchedule: false,
      scheduling: false,
      onBack: vi.fn(),
      onSave: vi.fn(),
      onSaveAndSchedule,
    });
    const button = elements(tree).find(
      (element) =>
        element.type === Button && element.props.onClick === onSaveAndSchedule,
    );

    expect(button?.props.disabled).toBe(true);
  });
});
