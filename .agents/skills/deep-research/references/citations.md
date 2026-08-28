# Grounded Citations Contract & Standards

## 1. Core Doctrine
Every factual claim taken from an outside source MUST carry an inline citation `[n]`, and the document MUST conclude with a verified `## Sources` block.

```markdown
Autonomous AI agents achieve higher reliability when equipped with domain-specific tools.[1]
Recent benchmarks demonstrate a 34% reduction in hallucinations with retrieval grounding.[2]

## Sources
[1] Agent Tooling Benchmark 2026: https://arxiv.org/abs/2601.12345
[2] Evaluation of Grounded Retrieval Systems: https://example.com/eval-report
```

## 2. Citation Rules & Invariants
1. **Register at Retrieval:** Log every URL as soon as it is fetched by a tool. Never fabricate or guess URLs during drafting.
2. **Inline Placement:** Attach citation brackets directly after the claim without a preceding space: `Claim text.[1][2]`
3. **No Retyping:** Copy URLs verbatim from the tool output.
4. **X / Social Posts:** Use canonical URLs `https://x.com/{handle}/status/{id}` and state author handle and publication date.
5. **Model Knowledge vs. Grounded Facts:** If a statement is based on internal model weights rather than retrieved evidence, label it `[unverified]`.

## 3. Pre-Delivery Verification Checklist
- [ ] Does every `[n]` in the text correspond to a numbered entry in `## Sources`?
- [ ] Are all URLs valid, reachable, and formatted as clickable markdown links?
- [ ] Are claims in the report backed by verbatim facts in the retrieved source text?
- [ ] Are contradictory findings from different sources explicitly noted and compared?
