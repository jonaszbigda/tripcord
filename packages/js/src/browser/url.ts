/** Origin and path only: query strings and fragments often carry tokens and emails. */
export function stripQueryAndHash(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

/**
 * The page URL as it goes into a timeline's meta. `sanitize` lets an app keep
 * what it needs (e.g. one safe query param). If it throws or returns a
 * non-string, the default is used with a warning: capturing never throws.
 */
export function pageUrl(href: string, sanitize?: (url: URL) => string): string {
  const url = new URL(href);
  if (!sanitize) {
    return stripQueryAndHash(url);
  }
  try {
    const result = sanitize(url);
    if (typeof result === "string") {
      return result;
    }
    console.warn("[tripcord] sanitizeUrl must return a string; sending the URL without its query and fragment.");
  } catch (error) {
    console.warn("[tripcord] sanitizeUrl threw; sending the URL without its query and fragment.", error);
  }
  return stripQueryAndHash(url);
}
