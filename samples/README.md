# Integration Code Samples

Working examples of CueHuman inside agent frameworks. Each one shows a common way an agent asks a person for a decision, a file or form data, and carries on with the answer. Copy what you need into your own project, or run a sample as it is to see the whole flow.

The samples call the CueHuman API directly, so there is no CueHuman library to install. Each sample's README shows the code you add to your project, then how to run the complete example.

## Frameworks

| Framework | What the samples show | Languages |
|---|---|---|
| **[LangGraph](langgraph/)** | Ten patterns for pausing a graph or an agent for a person: resuming by webhook, an ask-and-wait tool, an approval gate, reminders and escalation, forms, document uploads, attachments, verified approvals, several approvers, and a graph hosted on LangSmith. | Python · TypeScript |

More frameworks will be added here as samples arrive.

## Contributing a Sample

We welcome samples for other frameworks and languages, and new patterns for the ones above. A sample goes in its own folder, by framework and language: `samples/<framework>/<language>/<sample-name>/`. A sample that uses no framework goes under `samples/<language>/`. Each sample has its own README that says what it does and how to run it.

Samples never contain an API key or a real person's details, and they call the production address, `https://api.cuehuman.ai`. See [Contributing](../CONTRIBUTING.md) for the full rules and how to open a pull request.
