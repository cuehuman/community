# CueHuman with LangGraph

LangGraph can pause a workflow for a person and resume it later. It does not reach the person or collect their answer. CueHuman does that part: it sends the message, hosts the request form and returns the answer to your code.

| Sample | Languages |
|---|---|
| **Pause and resume.** A graph pauses with `interrupt()`, and a CueHuman webhook resumes it when the human answers. Use it when the answer can take minutes or days, and the run must survive a restart. | [Python](python/pause-and-resume/) · [TypeScript](typescript/pause-and-resume/) |
| **Ask-and-wait tool.** A tool an agent calls to ask a person and wait for the answer. Use it when the answer is expected within a few minutes. | [Python](python/ask-and-wait-tool/) · [TypeScript](typescript/ask-and-wait-tool/) |
| **Approval gate.** A tool that cannot run until a person approves that exact call, enforced by LangChain's human-in-the-loop middleware. Use it when an action must never happen without sign-off. | [Python](python/approval-gate/) · [TypeScript](typescript/approval-gate/) |
| **Remind, then escalate.** An approval that does not wait forever: it reminds the approver once, then asks a backup. Use it when silence must not block the work. | [Python](python/remind-then-escalate/) · [TypeScript](typescript/remind-then-escalate/) |
| **Ask for details.** A graph pauses to collect information on a form, then continues with the answers. Use it when the workflow is missing data only a person has. | [Python](python/ask-for-details/) · [TypeScript](typescript/ask-for-details/) |
| **Collect a document.** A graph pauses until a person uploads files, then downloads them. Use it for claims, onboarding and other document checks. | [Python](python/collect-a-document/) · [TypeScript](typescript/collect-a-document/) |
| **Verified approval.** The approver proves they hold the address with a code, and the graph checks the answer's signed receipt before acting. Use it for high-risk actions. | [Python](python/verified-approval/) · [TypeScript](typescript/verified-approval/) |
| **Two approvers.** Several people are asked at once, each in their own branch, and the action needs a yes from all of them. | [Python](python/two-approvers/) · [TypeScript](typescript/two-approvers/) |
| **Hosted on LangSmith.** The pause-and-resume approval for a graph a LangGraph server runs, with the webhook as a route on that server. | [Python](python/hosted-on-langsmith/) · [TypeScript](typescript/hosted-on-langsmith/) |

The samples call the CueHuman API directly, with no CueHuman library to install. Each sample's page first shows the code you add to your own project, then how to run the complete example.

## What you need

- A CueHuman account and an agent key from the Developer Portal. Use a `cue_test_` key while you try the samples: test requests are free and go by email to members of your organization only.
- For the Python samples, Python 3.10 or later. For the TypeScript samples, Node.js 20 or later.

Never commit a key. Each sample reads its settings from a `.env` file that Git ignores; copy `.env.example` to `.env` and fill it in.
