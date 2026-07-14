# Architecture One Page

```text
Requirement / diff / OpenAPI / issue
                 |
                 v
      Context + impact analysis
                 |
                 v
      Versioned gray plan + oracle
                 |
        human permission gate
                 |
                 v
    Independent target project adapter
                 |
                 v
       Playwright execution loop
                 |
                 v
 Evidence graph: DOM / network / console / trace / screenshot
                 |
                 v
 Failure attribution + bounded repair proposal
                 |
                 v
 Plan Judge -> Evidence Judge -> Release Judge
                 |
                 v
 CI gate / JUnit / PR annotation / human override
```

The target project is an explicit runtime boundary. The Agent does not write target source code, and a fallback Judge result is never presented as an LLM success.
