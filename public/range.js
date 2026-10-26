export const RANGE_PAGE_DAYS = 126;

export function splitRange(from, to) {
  const end = Date.parse(to + 'T12:00:00Z');
  const pages = [];
  for (let start = Date.parse(from + 'T12:00:00Z'); start <= end; start += RANGE_PAGE_DAYS * 86400000) {
    pages.push({
      from: new Date(start).toISOString().slice(0, 10),
      to: new Date(Math.min(end, start + (RANGE_PAGE_DAYS - 1) * 86400000)).toISOString().slice(0, 10),
    });
  }
  return pages;
}

export async function loadRangePages(from, to, loadPage, onProgress = () => {}) {
  let loaded = 0;
  const pages = await Promise.all(splitRange(from, to).map(async range => {
    const page = await loadPage(range);
    if (page.nextFrom) throw new Error('The selected range was not loaded completely. Please try again.');
    loaded += page.days.length;
    onProgress(loaded);
    return page;
  }));
  return {
    ...pages[0], from, to, nextFrom: null,
    days: pages.flatMap(page => page.days),
    fetchedAt: pages.map(page => page.fetchedAt).sort().at(-1),
  };
}
