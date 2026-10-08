/**
 * HAOWISE document-head maintenance: browser tab title and favicon.
 *
 * Neither has an extension surface upstream:
 *
 * - The tab title comes from `productTitle`, a build-time `process.env.DSH_CLIENT_TITLE`
 *   that Vite inlined when `@deepseek-ai/dsh-client-ui-layout` was published. WorkDSH
 *   consumes published packages and does not rebuild upstream source, so the shipped
 *   value is frozen at "DeepSeek Harness".
 * - The favicon lives in the prebuilt `dsh-web-frontend/dist/index.html`, an artifact
 *   pnpm hardlinks from the shared store.
 *
 * So both are rewritten at runtime. The title needs a `MutationObserver` rather than a
 * one-shot assignment: the official `DocumentTitle` effect re-asserts
 * `"<session> — DeepSeek Harness"` on every session selection/rename and again on its
 * cleanup. Rewriting only the product-name substring preserves that behaviour instead
 * of fighting it, and because the title then no longer contains the upstream string,
 * the observer converges instead of looping.
 */

/** Product title baked into the published layout at build time. */
const UPSTREAM_TITLE = 'DeepSeek Harness';

const BRAND_TITLE = 'HAOWISE';

/**
 * HAOWISE Λ monogram centred in a square canvas for the tab icon. Same path as the
 * sidebar and hero mark; the transform centres the 23.16x17.04 artwork in 24x24.
 */
const FAVICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">'
  + '<g transform="translate(12 12) scale(0.8) translate(-11.58 -8.55)">'
  + '<path d="M11.58 1.6 2.6 15.5M11.58 1.6l8.98 13.9" stroke="#1F5FA0" stroke-width="3.3" stroke-linecap="round" stroke-linejoin="round"/>'
  + '</g></svg>',
)}`;

/** Point every declared icon link at the HAOWISE favicon, declaring one if absent. */
function applyFavicon(): void {
  let links = [...document.head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')];
  if (links.length === 0) {
    const link = document.createElement('link');
    link.rel = 'icon';
    document.head.append(link);
    links = [link];
  }
  for (const link of links) {
    link.type = 'image/svg+xml';
    link.href = FAVICON;
  }
}

/** Swap the upstream product name for the brand, leaving any session prefix intact. */
function rewriteTitle(): void {
  const current = document.title;
  if (!current.includes(UPSTREAM_TITLE)) return;
  document.title = current.split(UPSTREAM_TITLE).join(BRAND_TITLE);
}

/**
 * Apply both rewrites and keep the title rewritten for as long as the plugin lives.
 * @returns disposer that stops observing.
 */
export function installDocumentHead(): () => void {
  rewriteTitle();
  applyFavicon();

  const observer = new MutationObserver(rewriteTitle);
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });

  return () => observer.disconnect();
}