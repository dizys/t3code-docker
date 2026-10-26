// The console's pages, in one table.
//
// The shell (page.mjs, on the server) draws the sidebar and the phone's tab
// bar from it; app.js routes, titles and heads each page with it; the view
// model offers it in the command palette; the shortcuts are its keys. A page
// is added, renamed or moved here and nowhere else.
//
// Like model.js this is a classic script with no DOM: the server and the tests
// run it under Node, and the page inlines it before model.js.
const T3Routes = (() => {
  'use strict';

  // Each page: its route (the address's #hash), its title, the icon beside it
  // in the sidebar, the second key of its G shortcut (G A for Agents), the
  // sidebar group it sits in, a one-line summary for its header, and the guide
  // in docs/ that explains it.
  const PAGES = [
    { route: 'overview', title: 'Overview', icon: 'layout-dashboard', key: 'o', group: 'home',
      summary: 'Setup progress, and anything on this server that needs you.', doc: 'setup-page.md' },
    { route: 'access', title: 'Access', icon: 'smartphone', key: 'd', group: 'home',
      summary: 'Pair devices, and choose how they reach this server.', doc: 'remote-access.md' },
    { route: 'agents', title: 'Agents', icon: 'bot', key: 'a', group: 'agents',
      summary: 'Install, sign in and update your coding agents.', doc: 'agents.md' },
    { route: 'instructions', title: 'Instructions & skills', icon: 'book-open', key: 'i', group: 'agents',
      summary: 'What your agents read at the start of every session.', doc: 'context-management.md' },
    { route: 'mcp', title: 'MCP servers', icon: 'plug', key: 'm', group: 'agents',
      summary: 'Servers your agents can start or connect to.', doc: 'mcp-servers.md' },
    { route: 'files', title: 'Files', icon: 'folder', key: 'f', group: 'tools',
      summary: 'Your projects, your home folder and what fills the disk.', doc: 'files.md' },
    { route: 'credentials', title: 'Server credentials', icon: 'key-round', key: 'c', group: 'tools',
      summary: 'SSH passwords and API tokens your agents can use by name.', doc: 'server-credentials.md' },
    { route: 'toolchains', title: 'Toolchains', icon: 'wrench', key: 't', group: 'tools',
      summary: 'Languages and tools on every agent’s path, at exact versions.', doc: 'toolchains.md' },
    { route: 'sourcecontrol', title: 'Source control', icon: 'git-pull-request', key: 's', group: 'tools',
      summary: 'The CLIs T3 Code uses to open pull requests.', doc: 'source-control.md' },
    { route: 'ports', title: 'Ports', icon: 'ethernet-port', key: 'p', group: 'tools',
      summary: 'Give a dev server running here a public HTTPS address.', doc: 'ports.md' },
    { route: 'updates', title: 'Updates', icon: 'circle-arrow-up', key: 'u', group: 'system',
      summary: 'Keep T3 Code, agents and tools current.', doc: 't3code-updates.md' },
    { route: 'storage', title: 'Storage', icon: 'hard-drive', key: 'v', group: 'system',
      summary: 'Disk space, and the caches and old versions you can clear.', doc: 'storage.md' },
    { route: 'server', title: 'Server', icon: 'server', key: 'e', group: 'system',
      summary: 'T3 Code, this container and the setup console itself.', doc: 'configuration.md' },
  ];

  // Sidebar groups, in order; a group without a label draws no heading. The
  // first holds the pages everyone starts from.
  const GROUPS = [
    { id: 'home', label: null },
    { id: 'agents', label: 'Agents' },
    { id: 'tools', label: 'Tools' },
    { id: 'system', label: 'System' },
  ];

  // The phone's tab bar. Every other page lives under More, which lists them
  // in the sidebar's groups.
  const TABS = [
    { route: 'overview', title: 'Overview', icon: 'layout-dashboard' },
    { route: 'access', title: 'Access', icon: 'smartphone' },
    { route: 'agents', title: 'Agents', icon: 'bot' },
    { route: 'ports', title: 'Ports', icon: 'ethernet-port' },
    { route: 'more', title: 'More', icon: 'ellipsis' },
  ];
  const MORE = { route: 'more', title: 'More', icon: 'ellipsis', key: null, group: null, summary: 'Everything else on this server.', doc: null };

  // Addresses a page had before it moved, so an old bookmark or a link from an
  // older T3 Code still lands where it meant to.
  const ALIASES = { devices: 'access', context: 'instructions', environment: 'server' };

  const BY_ROUTE = new Map([...PAGES, MORE].map((page) => [page.route, page]));
  const page = (route) => BY_ROUTE.get(route) || null;
  /** The page an address names, through its aliases; null when it names none. */
  const resolve = (name) => (BY_ROUTE.has(name) ? name : ALIASES[name] || null);
  /** The tab that holds a page on a phone. */
  const tabOf = (route) => (TABS.some((tab) => tab.route === route) ? route : 'more');
  /** Pages in their sidebar groups, each group with its label. */
  const grouped = () => GROUPS.map((group) => ({ ...group, pages: PAGES.filter((p) => p.group === group.id) }));

  /**
   * A guide's address on GitHub, at the release this image was built from so
   * it describes what is running; a branch build or an unknown one reads main.
   */
  const REPO = 'https://github.com/dizys/t3code-docker/blob/';
  const docUrl = (doc, imageVersion) => {
    const release = /^v?(\d+\.\d+\.\d+)$/.exec(String(imageVersion || '').trim());
    return REPO + (release ? 'v' + release[1] : 'main') + '/docs/' + doc;
  };

  return { PAGES, GROUPS, TABS, ALIASES, page, resolve, tabOf, grouped, docUrl };
})();
