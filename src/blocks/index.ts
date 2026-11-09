/**
 * Site-side renderers for RedeemID's Portable Text blocks, picked up by
 * EmDash from the plugin's `componentsEntry`.
 */
import Marker from "./PaywallBreak.astro";
import CollectionBlock from "./CollectionBlock.astro";
import ContributionBlock from "./ContributionBlock.astro";
import PlanBlock from "./PlanBlock.astro";
import PreferencesBlock from "./PreferencesBlock.astro";
import ProductBlock from "./ProductBlock.astro";
import SearchBlock from "./SearchBlock.astro";

export const blockComponents = {
	"redeemid-paywall": Marker,
	"redeemid-members": Marker,
	"redeemid-members-end": Marker,
	"redeemid-item": Marker,
	"redeemid-plan": PlanBlock,
	"redeemid-product": ProductBlock,
	"redeemid-collection": CollectionBlock,
	"redeemid-search": SearchBlock,
	"redeemid-contribution": ContributionBlock,
	"redeemid-preferences": PreferencesBlock,
};
