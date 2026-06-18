export type GithubSlugger = {
  slug(value: string): string;
};

function baseGithubSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[`*_~[\]()]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

export function createGithubSlugger(): GithubSlugger {
  const counts = new Map<string, number>();

  return {
    slug(value: string): string {
      const base = baseGithubSlug(value);
      const count = counts.get(base) ?? 0;
      counts.set(base, count + 1);

      if (count === 0) {
        return base;
      }
      return `${base}-${count}`;
    }
  };
}
