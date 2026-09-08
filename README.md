# Lumanin Plugins

The official plugin collection for [Lumanin](https://github.com/Tapuuk/Lumanin),
the keyboard launcher for Linux. Every plugin here is written and maintained by
Lumanin's author.

Each plugin lives in its own folder under [`plugins/`](plugins/), and
[`plugins.json`](plugins.json) is the index the launcher reads. Browse and
install them from inside Lumanin — the Plugins screen in Lumanin Settings, or
the Plugin Store row in `lumanin plugins` — or install one directly by URL:

```bash
lumanin plugin-install https://github.com/Tapuuk/Lumanin-Plugins/tree/main/plugins/<name>
```

Install everything at once:

```bash
lumanin plugin-install https://github.com/Tapuuk/Lumanin-Plugins --all
```

## Your own plugins

This repository does not take submissions — it holds the official set only.
Anyone can publish a Lumanin plugin independently: push the folder
`lumanin plugin-export` produces to any public git repository, and its URL is
the whole distribution. A community collection that gathers those repositories
in one place is planned separately.

The easiest way to write a plugin is the
[generator skill](https://github.com/Tapuuk/Lumanin/tree/main/.claude/skills/lumanin-plugin)
for Claude Code.
