---
name: Bug report
about: Report something that isn't working
title: "[bug] "
labels: bug
---

**What happened**
A clear description of the bug.

**Steps to reproduce**

1. …
2. …

**Expected behavior**
What you expected instead.

**Environment**

Run `kritya doctor` and paste the output — it covers the version, OS, Node
version, active provider, and whether the API key resolved, all in one go. It
never prints the key itself, only whether one was found, so the output is safe
to paste. If you'd rather not let it make a network request, use
`kritya doctor --offline`.

```
<kritya doctor output>
```

Anything it didn't cover:

- Provider and model (e.g. `nvidia` / `nvidia/nemotron-3-super-120b-a12b`):

**Logs / output**
Paste any relevant terminal output. Redact API keys and private code.
