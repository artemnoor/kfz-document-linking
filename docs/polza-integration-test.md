# Polza AI live integration record

## Run: 2026-11-12

- Provider: Polza AI
- Model: `deepseek/deepseek-v4-flash`
- Input: real Structured Extraction 1.2.0 KFZ report and act fixtures
- HTTP requests: 1
- API errors/timeouts: 0
- Output contract validation: passed
- LLM hypotheses returned: 0
- Test duration: 4.4 seconds
- Result: passed; the matcher handled an admissible candidate pair and emitted no unsupported link.

The runner used the locally available `POLZA_AI_API_KEY` only for this process, mapped to the service's `POLZA_API_KEY` setting. The value was not written to a file, fixture, test output, or repository. The live test is reproducible with `POLZA_API_KEY` set:

```powershell
npm run test:polza
```

The test deliberately records counts and validation status only. It does not persist or print the provider response, extracted document content, or credentials.

The full test suite was also run with the same transient mapping on this date: **29 passed, 0 failed, 0 skipped**. Its live Polza test made one request, returned zero API errors and zero hypotheses, and validated the output contract; that request took 6.5 seconds.
