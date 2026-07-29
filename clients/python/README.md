# Generated Python contracts

`ai_test_officer_client/models.py` is generated from the same versioned
`docs/openapi.json` used by the Workbench TypeScript client:

```bash
npm run contracts:generate
```

The file is not maintained by hand. Applications can import the generated
Pydantic models with:

```python
from ai_test_officer_client.models import LlmKnowledgeContext, KnowledgeDecision
```
