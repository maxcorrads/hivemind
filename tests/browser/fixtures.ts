import { expect, test as base } from "@playwright/test";

export * from "@playwright/test";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isRemote(url: URL): boolean {
  return ["http:", "https:", "ws:", "wss:"].includes(url.protocol) && !LOCAL_HOSTS.has(url.hostname);
}

/**
 * Hermetic browser tests: every request to a non-local host is aborted and
 * fails the test, so the suite never depends on (or leaks to) the network.
 */
export const test = base.extend<{ hermetic: void }>({
  hermetic: [async ({ context }, use) => {
    const remote: string[] = [];
    await context.route(isRemote, async route => {
      remote.push(`${route.request().method()} ${route.request().url()}`);
      await route.abort("blockedbyclient");
    });
    await use();
    expect(remote, "Requests to non-local hosts").toEqual([]);
  }, { auto: true }],
});
