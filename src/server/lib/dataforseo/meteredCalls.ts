import { waitUntil } from "cloudflare:workers";
import {
  type CreditFeature,
  mapDataforseoPathToCreditFeature,
} from "@/shared/billing-credit-features";
import {
  getOrCreateOrganizationCustomer,
  reserveUsageCredits,
  settleUsageCredits,
  type BillingCustomerContext,
} from "@/server/billing/subscription";
import {
  DataforseoChargedTaskError,
  type DataforseoApiCallCost,
  type DataforseoApiResponse,
} from "@/server/lib/dataforseo/envelope";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { AppError } from "@/server/lib/errors";

/** Reserve each batch call before dispatch, then settle its provider report. */
export async function meterDataforseoCalls<T>(
  customer: BillingCustomerContext,
  executes: Array<() => Promise<DataforseoApiResponse<T>>>,
  callCredits: number[],
  creditFeature?: CreditFeature,
): Promise<PromiseSettledResult<T>[]>;
export async function meterDataforseoCalls<T>(
  customer: BillingCustomerContext,
  executes: Array<() => Promise<DataforseoApiResponse<T>>>,
  callCredits: number[],
  creditFeature: CreditFeature | undefined,
  withProviderCost: true,
): Promise<PromiseSettledResult<{ data: T; providerCostUsd: number }>[]>;
export async function meterDataforseoCalls<T>(
  customer: BillingCustomerContext,
  executes: Array<() => Promise<DataforseoApiResponse<T>>>,
  callCredits: number[],
  creditFeature?: CreditFeature,
  withProviderCost = false,
): Promise<PromiseSettledResult<T | { data: T; providerCostUsd: number }>[]> {
  if (executes.length === 0) return [];
  const isHostedMode = await isHostedServerAuthMode();

  if (!isHostedMode) {
    return Promise.allSettled(
      executes.map(async (execute) => {
        const result = await execute();
        return withProviderCost
          ? { data: result.data, providerCostUsd: result.billing.costUsd }
          : result.data;
      }),
    );
  }

  const billingCustomer = await getOrCreateOrganizationCustomer(customer);
  const { holds, refusedCalls } = await reserveUsageCredits({
    customer,
    customerId: billingCustomer.id,
    callCredits,
    creditFeature,
  });

  const work = (async () => {
    const billed: Array<DataforseoApiCallCost | null> = executes.map(
      () => null,
    );
    const settled = await Promise.allSettled(
      executes.map(async (execute, index) => {
        if (refusedCalls.includes(index)) {
          throw new AppError("INSUFFICIENT_CREDITS");
        }
        try {
          const result = await execute();
          billed[index] = result.billing;
          return withProviderCost
            ? { data: result.data, providerCostUsd: result.billing.costUsd }
            : result.data;
        } catch (error) {
          if (!(error instanceof DataforseoChargedTaskError)) throw error;
          if (error.isInvalidField && error.billing.costUsd <= 0)
            throw new AppError("VALIDATION_ERROR", error.message);
          billed[index] = error.billing;
          throw error;
        }
      }),
    );

    for (const hold of holds) {
      const costs = hold.callIndexes
        .map((index) => billed[index])
        .filter((cost) => cost !== null);
      await settleUsageCredits({
        customer,
        hold,
        creditFeature:
          creditFeature ??
          (costs.length > 0
            ? mapDataforseoPathToCreditFeature(costs[0].path)
            : undefined),
        costs,
      });
    }
    return settled;
  })();

  try {
    waitUntil(work.catch(() => undefined));
  } catch {
    // No request context (Workflow step, tests): the await below runs it.
  }
  return await work;
}
