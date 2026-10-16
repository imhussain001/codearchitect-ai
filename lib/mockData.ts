import type { ArchitectureGraph } from "@/lib/types";
import { authMicroservice } from "@/lib/mock/authMicroservice";
import { ecommerceApi } from "@/lib/mock/ecommerceApi";

/** Built-in sample repositories shown in the repository selector. */
export const SAMPLE_REPOSITORIES: readonly ArchitectureGraph[] = [ecommerceApi, authMicroservice];

export const DEFAULT_REPOSITORY_ID = authMicroservice.id;

export const SAMPLE_PROMPTS: Record<string, string[]> = {
  [authMicroservice.id]: [
    "Change `userId` from integer to UUID v4",
    "Refactor Users Database from SQL to MongoDB",
    "Change database schema for Users",
    "Rotate JWT signing from HS256 to RS256",
  ],
  [ecommerceApi.id]: [
    "Store prices as integer cents instead of float dollars",
    "Replace Redis catalog cache with CDN edge caching",
    "Swap Stripe for Adyen in the payment adapter",
  ],
};

export function findSample(id: string): ArchitectureGraph | undefined {
  return SAMPLE_REPOSITORIES.find((repo) => repo.id === id);
}

export { authMicroservice, ecommerceApi };
