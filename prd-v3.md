# PRODUCT REQUIREMENTS DOCUMENT (PRD)

**SUPERSEDING NOTE: WE HAVE ABANDONED THIS APPROACH DO NOT READ THIS FILE**
---
Status: DEPRECATED
---

## Engineering notes
The below requirements were made without any knowledge of our existing codebase.
The below notes supersede anything in the provided requirements; if there is a conflict between these notes and the requirements, please bring it to our attention:
1. This PRD encompasses changes to our collection classification and url matching logic only. 
2. It introduces the concept of a Collection Card, which replaces our current "classification object" in name and in implementation. The Collection Card should continue to be versioned in the manner of our current classification object, it replaces the content of the classification object.
3. Its matching requirements should be implemented as a new Matching Strategy, ensuring the existing LLM matching strategy remains in place.  There may be work required to adapt the existing llm-fetch stategy to the new Collection Card classification structure. 


# 1. Executive Summary

Build a system that:

1. Accepts a URL
2. Extracts structured content
3. Returns ranked candidate Collections (topics) in realtime (<10s)
4. Allows human selection
5. Continuously enriches and maintains semantic “Collection Cards”
6. Evolves as new URLs are added

The system must function as:

* A realtime classification assistant
* A batch taxonomy enrichment engine
* A living semantic representation of the corpus

---

# 2. Problem Statement

We have:

* ~600 Collections (topics)
* Each Collection contains 1–20 URLs
* Significant semantic overlap between Collections
* Some hierarchical structure (optional, incomplete)
* Thousands of existing URLs
* Ongoing ingestion of new URLs

Current limitations:

* Collection names are semantically thin
* No formal representation beyond name + membership
* Classification quality degrades as overlap increases
* No mechanism for taxonomy evolution

---

# 3. Goals & Non-Goals

## 3.1 Goals

* Return top 5–10 candidate Collections for a URL
* Achieve <10s p95 end-to-end latency
* Improve selection accuracy over time
* Maintain evolving semantic Collection Cards
* Support optional hierarchical relationships
* Provide drift detection & governance

## 3.2 Non-Goals

* Fully automated classification without human oversight
* Strict enforcement of hierarchical routing
* Building a large-scale extreme classification system (>50k labels)

---

# 4. High-Level Architecture

System consists of:

### A. Offline Processing Service

* Corpus embedding
* Collection representation building
* Card generation
* Drift monitoring
* Batch reclassification

### B. Realtime Inference Service

* URL ingestion
* Text extraction
* Embedding generation
* Candidate scoring
* Optional reranking
* API delivery

### C. Shared Data Layer

* URL records
* Collection records
* Embeddings
* Collection Cards
* Model metadata
* Version history

---

# 5. Core Data Models

## 5.1 URL Entity

```json
{
  "url_id": "...",
  "url": "...",
  "normalized_url": "...",
  "signal_pack_text": "...",
  "embedding_vector": "...",
  "embedding_model_version": "...",
  "keyphrases": ["..."],
  "entities": ["..."],
  "collection_id": "...",
  "created_at": "...",
  "updated_at": "..."
}
```

---

## 5.2 Collection Entity

```json
{
  "collection_id": "...",
  "display_name": "...",
  "canonical_path": "AI / Architecture / MCP Servers",
  "parent_id": "...",
  "aliases": ["..."],
  "centroid_vector": "...",
  "exemplar_vectors": ["..."],
  "card_id": "...",
  "created_at": "...",
  "updated_at": "..."
}
```

---

## 5.3 Collection Card

```json
{
  "card_id": "...",
  "collection_id": "...",
  "definition": "...",
  "includes": ["..."],
  "excludes": ["..."],
  "keyphrases": ["..."],
  "representative_entities": ["..."],
  "generated_by": "system|manual",
  "model_version": "...",
  "last_generated_at": "...",
  "last_reviewed_at": "...",
  "version": 3
}
```

---

# 6. URL Ingestion & Signal Extraction

## 6.1 Fetch Requirements

* HTML required
* Enforce timeout
* Enforce max content size
* Handle non-HTML gracefully

## 6.2 Signal Pack Construction

Signal pack must include:

* Title
* Meta description
* H1/H2 text
* First N tokens of main content
* Optional breadcrumb/domain tokens

Signal pack must be deterministic.

---

# 7. Embedding Strategy

## 7.1 Requirements

* Fixed embedding model version
* Float32 vectors
* Optional L2 normalization
* Store model version with vectors

## 7.2 URL Embeddings

Generated at:

* Initial ingestion
* Re-embedding events (model upgrade)

---

## 7.3 Collection Representation

For each Collection:

* Compute centroid = mean(URL embeddings)
* Select 3–5 exemplars (medoids or nearest to centroid)
* Store both

Recompute asynchronously when:

* New URL added
* Drift threshold exceeded

---

# 8. Realtime Inference

## 8.1 Flow

1. Receive URL
2. Fetch & extract signal pack
3. Generate embedding
4. Score against all Collections
5. Return top K

---

## 8.2 Scoring Formula

For each Collection:

```
s_centroid = dot(url_vec, centroid_vec)
s_exemplar = max(dot(url_vec, exemplar_vec_i))
score = 0.6*s_exemplar + 0.4*s_centroid
```

Return top 10 by default.

---

## 8.3 Ambiguity Detection

Compute:

* Top-1 margin = s1 - s2
* Softmax entropy over top K

If:

* Margin < threshold OR entropy > threshold
  → mark as ambiguous

---

## 8.4 Optional Reranking Layer

Input:

* URL signal pack
* Top 10 Collection Cards

Output:

* Refined ranking
* Short rationale

Must execute within remaining latency budget.

---

# 9. Collection Card Lifecycle

## 9.1 Initial Generation

Triggered when:

* System bootstrapped
* New Collection created
* Manual regeneration requested

Steps:

1. Aggregate URL keyphrases/entities
2. Generate draft definition
3. Generate includes/excludes
4. Store versioned card

Acceptance criteria:

* Definition ≥ 200 chars
* ≥5 keyphrases
* ≥3 representative entities

---

## 9.2 Incremental Updates

When URL added:

* Update centroid
* Update frequency stats
* Flag card regeneration if:

```
centroid_shift > threshold
OR vocab_divergence > threshold
```

Regeneration runs asynchronously.

---

## 9.3 Drift Detection

Track:

* Centroid movement
* Intra-cluster variance
* Confusion frequency with sibling Collections
* Vocabulary distribution shift

Flag Collection for review if drift exceeds thresholds.

---

## 9.4 Human Governance

System must allow:

* Manual card editing
* Card version history
* Diff visualization
* Approval workflow

Manual edits override auto-generated drafts.

---

# 10. Hierarchy Support

Hierarchy is optional but supported.

Behavior:

* Parent Collections may be empty.
* Parents have cards.
* Inference may boost children if parent score high.
* If leaf confidence low but parent high → suggest parent.

Hierarchy must not enforce strict routing.

---

# 11. Feedback Loop

When user selects Collection:

* Log selected Collection
* Log ranking position
* Log top K suggestions
* Store as labeled example

Future extensions:

* Train supervised reranker
* Improve confusion modeling

---

# 12. Performance Requirements

* End-to-end p95 < 10s
* Embedding + scoring < 2s
* Scoring across 600 Collections < 200ms
* Asynchronous updates must not block inference

---

# 13. Observability & Metrics

Track:

* Top-1 accuracy
* Top-5 recall
* Ambiguity rate
* Margin distribution
* Human override rate
* Drift frequency

Dashboard required.

---

# 14. Model Governance

* Embed model version stored everywhere
* Re-embedding plan documented
* Golden dataset (~200 URLs) maintained
* Regression tests compare ranking before/after changes

---

# 15. Security & Operational Considerations

* URL fetch sandboxed
* Rate limiting
* Content-size limits
* Embedding data encrypted at rest
* API authentication required

---

# 16. Roadmap

Phase 1:

* Embedding-based retrieval
* Collection Cards
* Human selection loop

Phase 2:

* Reranker
* Drift-aware card updates
* Hierarchy boosting

Phase 3:

* Active learning
* Auto-detect redundant Collections
* Taxonomy optimization tools

---

# 17. Definition of Done

System is considered complete when:

* Realtime classification functional
* Cards generated for all Collections
* Feedback loop operational
* Drift detection implemented
* Monitoring dashboard deployed
* Golden dataset regression tests passing

---

# Final Outcome

This system delivers:

* A realtime semantic routing assistant
* A self-evolving taxonomy
* A structured knowledge graph foundation
* Measurable, improvable classification quality

---
