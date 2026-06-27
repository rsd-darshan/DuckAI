"""
Knowledge Base RAG service.

Retrieval uses a hybrid scoring approach:
  - Exact substring hits (highest weight)
  - TF-IDF keyword overlap
  - SequenceMatcher character similarity (fuzzy fallback)

Retrieved chunks are synthesized by the LLM into a coherent answer.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from difflib import SequenceMatcher
from typing import Any

from ai_engine import chat as ai_chat
from database import kb_add_document, kb_get_document, kb_list_documents

_STOPWORDS = frozenset(
    "a an and are as at be been by do does for from has have he her him his "
    "how i in is it its me my no not of on or our out she so that the their "
    "them then there they this to up us was we were what when where which who "
    "will with you your".split()
)


def _tokenize(text: str) -> list[str]:
    return [w.lower() for w in re.findall(r"\b[a-z0-9]{2,}\b", text.lower()) if w not in _STOPWORDS]


def _chunk_text(text: str, chunk_size: int) -> list[str]:
    raw = (text or "").strip()
    if not raw:
        return []
    # Prefer splitting at paragraph/sentence boundaries
    paragraphs = re.split(r"\n{2,}|\.\s+", raw)
    chunks: list[str] = []
    current = ""
    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        if len(current) + len(para) <= chunk_size:
            current = f"{current} {para}".strip() if current else para
        else:
            if current:
                chunks.append(current)
            # If para itself is too long, hard-split it
            for i in range(0, len(para), chunk_size):
                chunks.append(para[i : i + chunk_size])
            current = ""
    if current:
        chunks.append(current)
    return chunks or [raw[:chunk_size]]


def _score_chunk(query_tokens: list[str], chunk: str) -> float:
    """Hybrid relevance score in [0, 1]."""
    q = " ".join(query_tokens)
    chunk_lower = chunk.lower()

    # 1. Exact substring match — strongest signal
    exact_bonus = 0.35 if q in chunk_lower else 0.0
    # Each query token found verbatim
    chunk_tokens = _tokenize(chunk)
    chunk_token_set = set(chunk_tokens)
    q_set = set(query_tokens)
    overlap = q_set & chunk_token_set
    token_overlap_ratio = len(overlap) / max(len(q_set), 1)

    # 2. TF-IDF-style: term frequency in chunk
    chunk_counter = Counter(chunk_tokens)
    total = sum(chunk_counter.values()) or 1
    tf_score = sum(chunk_counter[t] / total for t in overlap)
    tf_score = min(tf_score * 3.0, 0.4)  # scale and cap

    # 3. Fuzzy character similarity — fallback for typos / paraphrases
    fuzzy = SequenceMatcher(None, q, chunk_lower[:len(q) * 3]).ratio() * 0.15

    score = exact_bonus + (token_overlap_ratio * 0.3) + tf_score + fuzzy
    return min(round(score, 4), 1.0)


def ingest_document(title: str, content: str, source: str, tags: list[str]) -> dict[str, Any]:
    return kb_add_document(title=title, content=content, source=source, tags=tags)


def list_documents() -> list[dict[str, Any]]:
    return kb_list_documents()


def query_documents(query: str, top_k: int, chunk_size: int) -> list[dict[str, Any]]:
    docs = kb_list_documents()
    q = (query or "").strip()
    if not q or not docs:
        return []

    query_tokens = _tokenize(q)
    if not query_tokens:
        query_tokens = [q.lower()[:40]]

    chunks: list[dict[str, Any]] = []
    for doc in docs:
        for idx, chunk in enumerate(_chunk_text(doc["content"], chunk_size)):
            score = _score_chunk(query_tokens, chunk)
            if score > 0.01:  # skip completely irrelevant chunks
                chunks.append({
                    "document_id": doc["id"],
                    "title": doc["title"],
                    "source": doc.get("source") or "",
                    "chunk_index": idx,
                    "chunk": chunk,
                    "score": score,
                })

    chunks.sort(key=lambda x: x["score"], reverse=True)
    return chunks[:max(1, top_k)]


def synthesize_with_sources(query: str, top_k: int, chunk_size: int) -> dict[str, Any]:
    sources = query_documents(query, top_k=top_k, chunk_size=chunk_size)
    if not sources:
        return {
            "answer": "No relevant documents found in your knowledge base for that query. Try ingesting more documents first.",
            "sources": [],
        }

    context_text = "\n\n".join(
        f"[Source: {s['title']} (chunk {s['chunk_index']}, score {s['score']:.2f})]\n{s['chunk']}"
        for s in sources
    )
    prompt = (
        f"Question: {query}\n\n"
        f"Knowledge base context:\n{context_text}\n\n"
        "Answer the question using ONLY the provided context. "
        "Cite the source title in parentheses after each relevant sentence. "
        "If the context doesn't contain enough information, say so explicitly."
    )
    try:
        answer = ai_chat([{"role": "user", "content": prompt}], context={})
    except Exception:
        answer = "Could not generate answer — LLM unavailable. Showing raw source chunks above."

    return {"answer": answer, "sources": sources}


def get_document(document_id: str) -> dict[str, Any] | None:
    return kb_get_document(document_id)
