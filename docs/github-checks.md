# Optional GitHub repository checks

GitHub signs you into hosted Life Diff. To independently check repository changes, give the Life Diff GitHub App read access to the specific repositories you want it to check. Select only those repositories in GitHub's installation settings. A session can check repositories only if you also name them when opening it.

In your authorized MCP client, call `start_session` before the work, with a list of repositories you control or have permission to check. This example uses a fictional test repository.

```json
{ "repos": ["example-org/launch-sandbox"] }
```

Confirm the returned repository list and review any warnings. After the work, pass the returned session ID to `end_session`. Life Diff compares supported GitHub metadata with the start snapshot. It can corroborate supported changes such as pull requests, issues, branches, commits, and file change counts. An agent claim matches only if the check finds evidence for that claim. The verification feed reads GitHub. Separately, a write-capable upstream you registered can change GitHub with its own permissions.

In [Settings](https://lifediff.dev/settings), turn on **Include GitHub repository changes in the daily diff** to surface these checks in the daily roundup. Repositories must still be named per session. The public [DeepWiki lookup](connect.md#first-lookup) uses a regular tool-activity session.

In the beta, a GitHub account has one open session across its clients. Coordinate before starting a repository check or closing the session from another client. Close an opted-in session explicitly to give it the normal GitHub comparison. A later ordinary proxied call can finalize a stale receipt without a GitHub read.

[Hosted privacy and retention](../PRIVACY.md)
