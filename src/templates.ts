/**
 * Middleware added by redeemidGuard(): hands the build-time template scan
 * (see template-scan.ts) to the Status page. The guard's Vite plugin
 * replaces FINDINGS below with the scan when it builds this file.
 */

import { defineMiddleware } from "astro:middleware";

import { TEMPLATES_KEY, type TemplateFinding } from "./template-scan.js";

const FINDINGS: TemplateFinding[] | null = null; // redeemid:templates

(globalThis as Record<string, unknown>)[TEMPLATES_KEY] = FINDINGS;

export const onRequest = defineMiddleware((_context, next) => next());
