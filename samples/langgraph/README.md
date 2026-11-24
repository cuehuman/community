# CueHuman with LangGraph

LangGraph can pause a workflow for a person and resume it later. It does not reach the person or collect their answer. CueHuman does that part: it sends the message, hosts the request form and returns the answer to your code.

| Sample | Languages |
|---|---|
| **Pause and resume.** A graph pauses with `interrupt()`, and a CueHuman webhook resumes it when the human answers. Use it when the answer can take minutes or days, and the run must survive a restart. | [Python](python/pause-and-resume/) · [TypeScript](typescript/pause-and-resume/) |
| **Ask-and-wait tool.** A tool an agent calls to ask a person and wait for the answer. Use it when the answer is expected within a few minutes. | [Python](python/ask-and-wait-tool/) · [TypeScript](typescript/ask-and-wait-tool/) |

The samples call the CueHuman API directly, with no CueHuman library to install. Each sample's page first shows the code you add to your own project, then how to run the complete example.

## What you need

- A CueHuman account and an agent key from the Developer Portal. Use a `cue_test_` key while you try the samples: test requests are free and go by email to members of your organization only.
- For the Python samples, Python 3.10 or later. For the TypeScript samples, Node.js 20 or later.

Never commit a key. Each sample reads its settings from a `.env` file that Git ignores; copy `.env.example` to `.env` and fill it in.
