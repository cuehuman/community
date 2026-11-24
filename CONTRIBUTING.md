# Contributing

We welcome code samples and integration examples that show how to build with CueHuman.

## Sharing a Code Sample

1. Fork this repository and create a branch.
2. Put your sample in its own folder under `samples/`, by framework and language: `samples/<framework>/<language>/<sample-name>/`, for example `samples/langgraph/python/pause-and-resume/`. A sample that uses no framework goes under `samples/<language>/`, for example `samples/python/approval-flow/`.
3. Add a `README.md` in that folder that says what the sample does and how to run it.
4. Open a pull request. We review every pull request before it's merged.

## Rules for Samples

- **No secrets.** Read the API key from the `CUEHUMAN_API_KEY` environment variable. Never commit a key, even a test key.
- **No real people.** Use the example human Jane Doe, `jane.doe@example.com` and `+15551234567`, and the company name "Example Company".
- **Production address only.** Call `https://api.cuehuman.ai`.
- **Keep it small.** A sample shows one thing well, with only the dependencies it needs.

## License

By opening a pull request, you agree that your contribution is licensed under this repository's [MIT License](LICENSE).

## Other Ways to Help

- Found a bug? Open a [Bug Report](https://github.com/cuehuman/community/issues/new/choose).
- Have a question? Ask in [Q&A](https://github.com/cuehuman/community/discussions/categories/q-a).

Everyone taking part follows our [Code of Conduct](CODE_OF_CONDUCT.md).
