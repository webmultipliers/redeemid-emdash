/**
 * Site-side renderers for RedeemID's Portable Text blocks, picked up by
 * EmDash from the plugin's `componentsEntry`.
 */
import PaywallBreak from "./PaywallBreak.astro";
import PlanBlock from "./PlanBlock.astro";

export const blockComponents = {
	"redeemid-paywall": PaywallBreak,
	"redeemid-plan": PlanBlock,
};
