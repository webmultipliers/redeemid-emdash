/**
 * Features: named perks a member holds through their levels or their
 * Shopify tags (an ad-free site, a supporter thank-you, early access).
 * Like levels they come only from the mirrored tags; nothing here grants
 * them otherwise.
 *
 *   features: [
 *     { slug: "ad-free", name: "Ad-free", levels: ["gold", "premium"] },
 *     { slug: "supporter", name: "Supporter", tags: ["supporter"] },
 *   ]
 */

import { levelsFor, viewer, type AstroLike } from "./access.js";
import type { FeatureConfig, LevelConfig } from "./config.js";
import { siteConfig } from "./site-config.js";
import type { MemberRecord } from "./storage.js";

/** The feature slugs a member holds: from any of the feature's levels or tags. */
export function featuresFor(member: Pick<MemberRecord, "tags" | "status"> | null, features: FeatureConfig[] = [], levels: LevelConfig[] = []): string[] {
	if (!member || member.status === "disabled") return [];
	const held = levelsFor(member.tags, levels);
	const tags = new Set(member.tags.map((t) => t.toLowerCase()));
	return features
		.filter((f) => (f.levels ?? []).some((l) => held.includes(l)) || (f.tags ?? []).some((t) => tags.has(t.toLowerCase())))
		.map((f) => f.slug);
}

/** Does the visitor hold this feature? */
export async function hasFeature(astro: AstroLike, slug: string): Promise<boolean> {
	return (await viewerFeatures(astro)).includes(slug);
}

/** The visitor's features. */
export async function viewerFeatures(astro: AstroLike): Promise<string[]> {
	const config = await siteConfig(astro.locals);
	if (!config?.features?.length) return [];
	const v = await viewer(astro);
	return featuresFor(v.member, config.features, config.levels);
}
