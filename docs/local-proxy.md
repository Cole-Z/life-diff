# Local stdio proxy

The local CLI wraps one stdio MCP server. It passes JSON-RPC through and records calls to `~/.lifediff/actions/<session>.jsonl` with mode `0600`. Receipt lines say **reported by proxy**. The log applies secret-key and text-pattern redaction. Bounded arguments can still contain sensitive content. [Action log format](action-log.md)

## Build from source

Go **1.26.11 or newer** is required by [go.mod](../go.mod). There are currently no tagged releases or downloadable binaries. `install.sh` is for use after a release archive is published.

```bash
git clone https://github.com/Cole-Z/life-diff.git
cd life-diff
go build -o lifediff ./cmd/lifediff
```

## Configure your client

In a stdio-capable client, merge the entry into the existing `mcpServers` object. Set the absolute path and replace the example executable and arguments after `--` with an installed tool server's launch command. Reload the client and confirm the wrapped server's tools appear.

```json
{
  "mcpServers": {
    "wrapped": {
      "command": "/absolute/path/to/lifediff",
      "args": ["proxy", "--", "/absolute/path/to/my-mcp-server"]
    }
  }
}
```

After some tool activity, run `./lifediff receipt` from the build directory. The CLI prints the latest proxy receipt and writes HTML next to the action log.

For a locally corroborated Google diff, follow the separate [Google snapshot guide](local-google.md).
